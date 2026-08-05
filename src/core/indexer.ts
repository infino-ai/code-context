// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Staged indexing. Stage 1 commits a keyword (FTS) index - search works
// seconds after indexing starts, before any embedding model even exists on
// the machine. Stage 2 embeds every chunk and rebuilds the same table with a
// vector index; hybrid/semantic search unlocks when it lands. The table name
// never changes, so SQL written against `chunks` keeps working across stages;
// the manifest records how far the index has progressed.
//
// Both stages STREAM (issue #9): peak memory scales with one batch, not the
// repo. Chunks spool to an on-disk NDJSON spill as files are walked (the
// live table is untouched during the walk), embeddings stream through the
// embedder into a packed-f32 spill, and every table (re)build replays the
// spills in bounded waves. Each build owns uniquely-named spills, deleted
// when its vector stage settles either way.
//
// Two invariants the streaming must not soften:
//   - Table swaps are ATOMIC to same-process readers: every drop → create →
//     append sequence runs in one synchronous block (no awaits), exactly like
//     the pre-streaming code. Spill reads inside those blocks are sync I/O.
//   - Failures leave the previous index standing. Chunk-spill errors abort
//     before any drop; embed errors surface before pass B's drop; sync embeds
//     before it deletes a single row.

import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  type WriteStream,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { IndexSpec, type Connection, type OptimizeOptions, type RowRecord } from "@infino-ai/infino";
import { APPEND_BATCH, EMBED_BATCH, N_CENT, TABLE, DEFAULT_CAPS, type IndexCaps } from "./config.js";
import { walkRepo } from "./walker.js";
import { shouldIndexFile, chunkFile, looksBinary, embedText, type Chunk } from "./chunker.js";
import { readManifest, writeManifest, INDEX_FORMAT_VERSION, type Manifest, type VectorState } from "./manifest.js";
import {
  diffFiles,
  emptyFileState,
  hashContent,
  readFileState,
  writeFileState,
  type FileState,
} from "./filestate.js";
import type { Embedder } from "./embedder.js";

const COMPACTION_TARGET_MIB =
  parseInt(process.env.CX_COMPACTION_TARGET_MIB ?? "", 10) || 10;

/** Spill filename prefix; full names are `spill.<pid>-<token>.<seq>.{chunks
 * .ndjson,vectors.f32}` so concurrent builds (same process, or a CLI racing
 * the MCP server) never share files. The random token disambiguates equal
 * pids across PID namespaces (two containers bind-mounting one repo are both
 * pid 1) - a bare-pid "mine" test would let one instantly sweep the other's
 * live spills. */
const SPILL_PREFIX = "spill.";
const SPILL_OWNER = `${SPILL_PREFIX}${process.pid}-${randomBytes(3).toString("hex")}.`;

/** Another process's leftover spills are swept only past this age - young
 * ones may belong to its live backfill. Our own dead spills sweep instantly
 * (the in-process registry knows which are live). */
const STALE_SPILL_MS = 24 * 60 * 60 * 1000;

/** Read-buffer size for the synchronous spill readers. */
const SPILL_READ_BUF_BYTES = 1 << 20;

/** Bytes per f32 (vector-spill row stride is `dim * F32_BYTES`). */
const F32_BYTES = 4;

export interface IndexOptions {
  root: string;
  db: Connection;
  /** Where the manifest is written (the index directory). */
  indexDirPath: string;
  /** Omit for a keyword-only index (vectors can be added by re-indexing).
   * The caller owns the embedder's lifecycle (dispose, when it has one). */
  embedder?: Embedder;
  caps?: IndexCaps;
  onPhase?: (phase: "scan" | "chunk" | "commit-text" | "embed" | "commit-vectors") => void;
  /** Progress within the current phase. */
  onProgress?: (done: number, total: number) => void;
}

export interface IndexStats {
  files: number;
  chunks: number;
  /** Candidate files left out because the repo exceeded the file cap. */
  truncatedFiles?: number;
  /** The file cap in effect for this build (context for `truncatedFiles`). */
  maxFiles: number;
  languages: Record<string, number>;
  vectors: VectorState;
  indexMs: number;
  embedMs?: number;
  /** Present when the vector stage failed; the keyword index is still live. */
  embedError?: string;
}

const TEXT_SCHEMA = {
  path: "large_utf8",
  start_line: "int32",
  end_line: "int32",
  lang: "large_utf8",
  symbol: "large_utf8",
  content: "large_utf8",
} as const;

/** A staged run: `text` resolves when keyword search is live; `completion`
 * resolves when the vector stage lands (== `text` when there is no embedder).
 * `completion` never rejects - a vector-stage failure is recorded in the
 * stats (embedError) and the manifest, with the keyword index still live. */
export interface StagedIndexRun {
  text: IndexStats;
  completion: Promise<IndexStats>;
}

/** Index and wait for everything (CLI flow). */
export async function indexRepo(opts: IndexOptions): Promise<IndexStats> {
  const run = await indexRepoStaged(opts);
  return run.completion;
}

/** Index in stages (MCP flow: reply once keyword search is live, let vectors
 * backfill in-process). */
export async function indexRepoStaged(opts: IndexOptions): Promise<StagedIndexRun> {
  const { root, db, indexDirPath, embedder, onPhase, onProgress } = opts;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const t0 = performance.now();

  // Keep the index out of the user's commits before we write a byte of it.
  ensureIndexIgnored(root, indexDirPath);

  // --- scan -----------------------------------------------------------------
  onPhase?.("scan");
  const walked = walkRepo(root).filter(
    (f) => shouldIndexFile(f.path) && f.size <= caps.maxFileBytes,
  );
  const taken = walked.slice(0, caps.maxFiles);
  const truncatedFiles = walked.length - taken.length;

  // --- chunk → spill ----------------------------------------------------------
  // The whole tree spools to the chunk spill before any table is touched, so
  // the previous index serves queries all through the walk, and a failure
  // here (full disk, racing deletes) costs nothing.
  onPhase?.("chunk");
  mkdirSync(indexDirPath, { recursive: true });
  sweepStaleSpills(indexDirPath);
  const spill = newSpill(indexDirPath);
  const languages: Record<string, number> = {};
  const fileState = emptyFileState();
  let files = 0;
  let chunkCount = 0;
  try {
    const chunkWriter = guardedWriter(spill.chunksPath);
    try {
      for (let i = 0; i < taken.length; i++) {
        let buf: Buffer;
        try {
          buf = readFileSync(join(root, taken[i].path));
        } catch {
          continue; // racing deletes are fine - index what's readable
        }
        // Every readable candidate is fingerprinted (binary ones too, so a later
        // sync's stat walk doesn't keep rediscovering them as "added").
        fileState.files[taken[i].path] = {
          size: taken[i].size,
          mtimeMs: taken[i].mtimeMs,
          hash: hashContent(buf),
        };
        if (looksBinary(buf)) continue;
        const fileChunks = await chunkFile(taken[i].path, buf.toString("utf8"));
        if (fileChunks.length === 0) continue;
        files++;
        chunkCount += fileChunks.length;
        for (const c of fileChunks) {
          languages[c.lang || "other"] = (languages[c.lang || "other"] ?? 0) + 1;
          await chunkWriter.write(JSON.stringify(c) + "\n");
        }
        if (i % 50 === 0) onProgress?.(i, taken.length);
      }
      await chunkWriter.close();
    } catch (err) {
      chunkWriter.destroy();
      throw err;
    }
  } catch (err) {
    spill.release(); // previous index untouched - just clean up and surface
    throw err;
  }

  // --- stage 1: swap in the keyword table -------------------------------------
  // One synchronous block (drop → create → append waves; sync spill reads, no
  // awaits) so same-process readers never observe a half-swapped table. From
  // here until the completion promise exists (whose finally owns the spill),
  // any throw must release it - a leaked name would pin the file in the
  // liveSpills registry for the life of the process.
  try {
    onPhase?.("commit-text");
    if (db.listTables().includes(TABLE)) db.dropTable(TABLE, true);
    const textTable = db.createTable(TABLE, { ...TEXT_SCHEMA }, new IndexSpec().fts("content"));
    appendSpillSync(textTable, spill, chunkCount, undefined, onProgress);
    if (!embedder) compact(textTable);
    const indexMs = Math.round(performance.now() - t0);

    const stats: IndexStats = {
      files,
      chunks: chunkCount,
      ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
      maxFiles: caps.maxFiles,
      languages,
      vectors: embedder ? "building" : "none",
      indexMs,
    };
    writeManifest(indexDirPath, toManifest(stats));
    writeFileState(indexDirPath, fileState);
    if (!embedder) {
      spill.release();
      return { text: stats, completion: Promise.resolve(stats) };
    }

    // --- stage 2: embed, then swap in the hybrid table -------------------------
    // A failure anywhere before the swap (model download, endpoint down, full
    // disk) leaves the stage-1 keyword table live and the manifest honest -
    // search degrades, indexing never fails. The swap itself is again one
    // synchronous block. `completion` must never reject; its finally owns the
    // spill from here on.
    const completion = (async () => {
      try {
        onPhase?.("embed");
        const tEmbed = performance.now();
        const dim =
          chunkCount === 0
            ? await embedder.dim() // no chunks to embed - just size the schema
            : await embedSpill(spill, embedder, chunkCount, onProgress);

        onPhase?.("commit-vectors");
        db.dropTable(TABLE, true);
        const hybridTable = db.createTable(
          TABLE,
          { ...TEXT_SCHEMA, embedding: { vector: dim } },
          new IndexSpec().fts("content").vector("embedding", dim, N_CENT, "cosine"),
        );
        // Zero chunks ⇒ no vector spill was ever written; the empty table is
        // already complete.
        if (chunkCount > 0) appendSpillSync(hybridTable, spill, chunkCount, dim, onProgress);
        compact(hybridTable);
        stats.vectors = "ready";
        stats.embedMs = Math.round(performance.now() - tEmbed);
        writeManifest(
          indexDirPath,
          toManifest(stats, {
            provider: embedder.provider,
            model: embedder.model,
            dim,
            ...(embedder.dtype ? { dtype: embedder.dtype } : {}),
          }),
        );
      } catch (err) {
        stats.vectors = "none";
        stats.embedError = (err as Error).message;
        try {
          writeManifest(indexDirPath, toManifest(stats));
        } catch {
          /* disk gone - nothing left to record on, and completion must not reject */
        }
      } finally {
        spill.release();
      }
      return stats;
    })();
    return { text: { ...stats }, completion };
  } catch (err) {
    spill.release();
    throw err;
  }
}

// --- spill plumbing ------------------------------------------------------------

interface Spill {
  chunksPath: string;
  vectorsPath: string;
  /** Delete both files and drop them from the in-process live registry. */
  release(): void;
}

/** Basenames of spills owned by in-flight builds in this process; the stale
 * sweep never touches these. */
const liveSpills = new Set<string>();
let spillSeq = 0;

function newSpill(indexDirPath: string): Spill {
  const base = `${SPILL_OWNER}${++spillSeq}`;
  const names = [`${base}.chunks.ndjson`, `${base}.vectors.f32`];
  for (const n of names) liveSpills.add(n);
  const [chunksPath, vectorsPath] = names.map((n) => join(indexDirPath, n));
  return {
    chunksPath,
    vectorsPath,
    release() {
      for (const n of names) {
        liveSpills.delete(n);
        try {
          rmSync(join(indexDirPath, n), { force: true });
        } catch {
          /* best-effort - the stale sweep on the next build gets another try */
        }
      }
    },
  };
}

/** Remove leftover spills from crashed builds: this process's own dead files
 * immediately (anything not in the live registry), other processes' only
 * once older than STALE_SPILL_MS - a young foreign spill may be a live
 * backfill in another process. Best-effort. */
function sweepStaleSpills(indexDirPath: string): void {
  let names: string[];
  try {
    names = readdirSync(indexDirPath);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SPILL_PREFIX) || liveSpills.has(name)) continue;
    try {
      if (!name.startsWith(SPILL_OWNER) && Date.now() - statSync(join(indexDirPath, name)).mtimeMs < STALE_SPILL_MS) {
        continue;
      }
      rmSync(join(indexDirPath, name), { force: true });
    } catch {
      /* raced another cleanup - fine */
    }
  }
}

/** A WriteStream wrapper that records async 'error' events and surfaces them
 * at the next write/close instead of crashing the process (an fs.WriteStream
 * 'error' with no listener is FATAL to Node, and most of a spill's lifetime
 * is spent awaiting the embedder, not awaiting stream events). */
function guardedWriter(path: string) {
  const stream: WriteStream = createWriteStream(path);
  let failure: Error | null = null;
  stream.on("error", (err) => {
    failure = err as Error;
  });
  return {
    async write(data: string | Buffer): Promise<void> {
      if (failure) throw failure;
      if (!stream.write(data)) {
        await once(stream, "drain"); // rejects if 'error' fires while waiting
      }
    },
    async close(): Promise<void> {
      if (failure) throw failure;
      stream.end();
      await once(stream, "close");
      if (failure) throw failure;
    },
    destroy(): void {
      stream.destroy();
    },
  };
}

/** Fully synchronous line iterator over an NDJSON spill (StringDecoder keeps
 * multi-byte UTF-8 intact across buffer boundaries). Sync on purpose: it runs
 * inside the atomic drop→create→append blocks, which must not await. */
function* readLinesSync(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(SPILL_READ_BUF_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        yield carry.slice(0, nl);
        carry = carry.slice(nl + 1);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) yield carry;
  } finally {
    closeSync(fd);
  }
}

/** Replay a spill into a table in APPEND_BATCH waves - synchronously, so the
 * caller's drop→create→append block stays atomic to same-process readers.
 * With `dim` set, each row is joined with its packed f32 vector from the
 * vector spill (same order, same count - verified, since a silently short
 * table is the one unrecoverable outcome). Only the in-flight wave is ever
 * resident; the engine binding takes number[] rows, so one wave is boxed
 * transiently - bounded, unlike the whole-corpus number[][] this replaces. */
function appendSpillSync(
  table: { append(rows: RowRecord[]): void },
  spill: Spill,
  expectedRows: number,
  dim?: number,
  onProgress?: (done: number, total: number) => void,
): void {
  const rows: Chunk[] = [];
  let appended = 0;
  let fd = -1;
  if (dim !== undefined) {
    fd = openSync(spill.vectorsPath, "r");
    const size = fstatSync(fd).size;
    if (size !== expectedRows * dim * F32_BYTES) {
      closeSync(fd);
      throw new Error(
        `vector spill holds ${size} bytes, expected ${expectedRows * dim * F32_BYTES} (${expectedRows} rows × ${dim}d)`,
      );
    }
  }
  try {
    const appendWave = () => {
      if (rows.length === 0) return;
      if (dim === undefined) {
        table.append(rows.map(toTextRow));
      } else {
        const want = rows.length * dim * F32_BYTES;
        // Own ArrayBuffer (not the pooled Buffer.alloc) so the f32 view is
        // 4-byte aligned regardless of wave size.
        const ab = new ArrayBuffer(want);
        const buf = Buffer.from(ab);
        let got = 0;
        while (got < want) {
          const n = readSync(fd, buf, got, want - got, null);
          if (n === 0) throw new Error(`vector spill truncated (wanted ${want} more bytes)`);
          got += n;
        }
        const f32 = new Float32Array(ab);
        table.append(
          rows.map((c, j) => ({
            ...toTextRow(c),
            embedding: Array.from(f32.subarray(j * dim, (j + 1) * dim)),
          })),
        );
      }
      appended += rows.length;
      rows.length = 0;
      onProgress?.(appended, expectedRows);
    };
    for (const line of readLinesSync(spill.chunksPath)) {
      rows.push(JSON.parse(line) as Chunk);
      if (rows.length >= APPEND_BATCH) appendWave();
    }
    appendWave();
    if (appended !== expectedRows) {
      throw new Error(`chunk spill replayed ${appended} rows, expected ${expectedRows}`);
    }
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Stream the chunk spill through the embedder in EMBED_BATCH waves, packing
 * f32 rows into the vector spill. Async is fine here: the previous table is
 * still serving queries. Returns the vector dimension; throws on a dim change
 * or count mismatch (before anything is dropped). */
async function embedSpill(
  spill: Spill,
  embedder: Embedder,
  total: number,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const out = guardedWriter(spill.vectorsPath);
  try {
    let dim: number | undefined;
    let done = 0;
    const batch: Chunk[] = [];

    const embedBatch = async () => {
      if (batch.length === 0) return;
      const texts = batch.map(embedText);
      let vectors: Float32Array;
      let d: number;
      if (embedder.embedToFloat32) {
        ({ vectors, dim: d } = await embedder.embedToFloat32(texts));
      } else {
        const rows = await embedder.embed(texts);
        d = rows[0]?.length ?? 0;
        vectors = Float32Array.from(rows.flat());
      }
      if (d <= 0 || vectors.length !== batch.length * d) {
        throw new Error(`embedder returned ${vectors.length} floats for ${batch.length} texts (dim ${d})`);
      }
      if (dim === undefined) dim = d;
      else if (dim !== d) throw new Error(`embedding dim changed mid-run: ${dim} → ${d}`);
      await out.write(Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
      done += batch.length;
      batch.length = 0;
      onProgress?.(Math.min(done, total), total);
      // Keep the chunk spill's mtime fresh: another process's stale sweep
      // judges foreign spills by age, and the chunk file goes cold the moment
      // the walk ends while this embed phase can run for hours.
      try {
        const now = new Date();
        utimesSync(spill.chunksPath, now, now);
      } catch {
        /* best-effort */
      }
    };

    const lines = createInterface({ input: createReadStream(spill.chunksPath) });
    for await (const line of lines) {
      batch.push(JSON.parse(line) as Chunk);
      if (batch.length >= EMBED_BATCH) await embedBatch();
    }
    await embedBatch();
    await out.close();
    if (done !== total || dim === undefined) {
      throw new Error(`embedding count mismatch: ${done} vectors for ${total} chunks`);
    }
    return dim;
  } catch (err) {
    out.destroy();
    throw err;
  }
}

// --- incremental sync --------------------------------------------------------

export interface SyncResult {
  action: "noop" | "synced";
  filesAdded: number;
  filesChanged: number;
  filesDeleted: number;
  chunksAdded: number;
  chunksRemoved: number;
  /** Post-sync totals. */
  files: number;
  chunks: number;
  /** Files still left un-indexed because the tree exceeds the file cap (0 when
   * the whole tree fits). Recomputed each sync so it tracks a growing repo. */
  truncatedFiles: number;
  vectors: VectorState;
  tookMs: number;
}

export type SyncOutcome = SyncResult | { action: "rebuild-required"; reason: string };

/** Bring the index up to date with the working tree by re-chunking (and
 * re-embedding) only the files that changed since the last index or sync.
 * Reports `rebuild-required` instead of guessing when incremental can't be
 * correct (no prior state, an in-flight vector backfill, or an embedder that
 * no longer matches the index). Fresh chunks spool through spills and are
 * embedded BEFORE any stale row is deleted, so an embed failure (which throws)
 * leaves the index exactly as it was. */
export async function syncRepo(opts: IndexOptions): Promise<SyncOutcome> {
  const { root, db, indexDirPath, embedder, onPhase } = opts;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const t0 = performance.now();

  const manifest = readManifest(indexDirPath);
  const prev = readFileState(indexDirPath);
  if (!manifest || !prev || !db.listTables().includes(TABLE)) {
    return { action: "rebuild-required", reason: "no prior index state" };
  }
  if (manifest.vectors === "building") {
    return { action: "rebuild-required", reason: "vector backfill in progress" };
  }
  const hasVectors = manifest.vectors === "ready";
  if (hasVectors && !embedder) {
    return { action: "rebuild-required", reason: "index has vectors but no embedder is configured" };
  }
  if (hasVectors && embedder && manifest.embedder && manifest.embedder.model !== embedder.model) {
    return {
      action: "rebuild-required",
      reason: `embedder changed (index: ${manifest.embedder.model}, current: ${embedder.model})`,
    };
  }

  // --- diff -------------------------------------------------------------------
  onPhase?.("scan");
  const walked = walkRepo(root).filter((f) => shouldIndexFile(f.path) && f.size <= caps.maxFileBytes);
  const candidates = walked.slice(0, caps.maxFiles);
  const truncatedFiles = walked.length - candidates.length;
  // Content is re-read at chunk time rather than cached here: a branch switch
  // can change thousands of files, and holding every changed buffer is
  // exactly the whole-repo materialization this module avoids.
  const diff = diffFiles(candidates, prev, (path) => {
    try {
      return readFileSync(join(root, path));
    } catch {
      return undefined;
    }
  });

  if (diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0) {
    writeFileState(indexDirPath, diff.next); // refresh stat fingerprints
    // Files added or removed *beyond* the cap never show up in the diff (the
    // candidate list is already capped), so the truncation count can change
    // while the indexed content doesn't. Reconcile the manifest when it drifts,
    // otherwise the "index is partial" marker goes stale.
    if (truncatedFiles !== (manifest.truncatedFiles ?? 0)) {
      const reconciled: Manifest = { ...manifest };
      if (truncatedFiles > 0) {
        reconciled.truncatedFiles = truncatedFiles;
        reconciled.maxFiles = caps.maxFiles;
      } else {
        delete reconciled.truncatedFiles;
        delete reconciled.maxFiles;
      }
      writeManifest(indexDirPath, reconciled);
    }
    return {
      action: "noop",
      filesAdded: 0,
      filesChanged: 0,
      filesDeleted: 0,
      chunksAdded: 0,
      chunksRemoved: 0,
      files: manifest.files,
      chunks: manifest.chunks,
      truncatedFiles,
      vectors: manifest.vectors,
      tookMs: Math.round(performance.now() - t0),
    };
  }

  // --- chunk the touched files into a spill --------------------------------------
  onPhase?.("chunk");
  sweepStaleSpills(indexDirPath);
  const spill = newSpill(indexDirPath);
  try {
    let chunksAdded = 0;
    const chunkWriter = guardedWriter(spill.chunksPath);
    try {
      for (const path of [...diff.added, ...diff.changed]) {
        let buf: Buffer;
        try {
          buf = readFileSync(join(root, path));
        } catch {
          // Readable at diff time, gone now. Drop it from the recorded state so
          // the next sync re-examines it instead of treating it as indexed -
          // its stale rows are deleted below either way.
          delete diff.next.files[path];
          continue;
        }
        if (looksBinary(buf)) continue;
        for (const c of await chunkFile(path, buf.toString("utf8"))) {
          chunksAdded++;
          await chunkWriter.write(JSON.stringify(c) + "\n");
        }
      }
      await chunkWriter.close();
    } catch (err) {
      chunkWriter.destroy();
      throw err;
    }

    // --- embed them (before ANY delete - a throw here must cost nothing) --------
    let dim: number | undefined;
    if (hasVectors && embedder && chunksAdded > 0) {
      onPhase?.("embed");
      dim = await embedSpill(spill, embedder, chunksAdded, opts.onProgress);
    }

    // --- apply: one synchronous block of deletes + appends -------------------------
    onPhase?.("commit-text");
    const table = db.openTable(TABLE);
    // `added` paths are deleted too: it makes a re-run of an interrupted sync
    // idempotent instead of duplicating rows.
    const stale = [...diff.added, ...diff.changed, ...diff.deleted];
    let chunksRemoved = 0;
    for (let i = 0; i < stale.length; i += 100) {
      const batch = stale.slice(i, i + 100).map((p) => `'${p.replace(/'/g, "''")}'`);
      chunksRemoved += table.delete(`path IN (${batch.join(",")})`).nTombstoned;
    }
    if (chunksAdded > 0) {
      appendSpillSync(table, spill, chunksAdded, hasVectors && embedder ? dim : undefined);
    }

    // --- persist state + recount ----------------------------------------------------
    writeFileState(indexDirPath, diff.next);
    const [{ n: chunkCount, f: fileCount }] = db.querySql(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT path) AS f FROM ${TABLE}`,
    ) as [{ n: unknown; f: unknown }];
    const langRows = db.querySql(
      `SELECT lang, COUNT(*) AS n FROM ${TABLE} GROUP BY lang`,
    ) as Array<{ lang: string; n: unknown }>;
    const languages: Record<string, number> = {};
    for (const r of langRows) languages[r.lang || "other"] = Number(r.n);
    const nextManifest: Manifest = {
      ...manifest,
      files: Number(fileCount),
      chunks: Number(chunkCount),
      languages,
      indexedAt: new Date().toISOString(),
    };
    // Track truncation as the tree grows or shrinks: set the fields when files
    // are now over the cap, clear the stale ones (spread from `manifest`) when
    // the tree has dropped back under it.
    if (truncatedFiles > 0) {
      nextManifest.truncatedFiles = truncatedFiles;
      nextManifest.maxFiles = caps.maxFiles;
    } else {
      delete nextManifest.truncatedFiles;
      delete nextManifest.maxFiles;
    }
    writeManifest(indexDirPath, nextManifest);

    // --- compact after deletes/appends to keep tombstones clean ---
    compact(table);

    return {
      action: "synced",
      filesAdded: diff.added.length,
      filesChanged: diff.changed.length,
      filesDeleted: diff.deleted.length,
      chunksAdded,
      chunksRemoved,
      files: nextManifest.files,
      chunks: nextManifest.chunks,
      truncatedFiles,
      vectors: nextManifest.vectors,
      tookMs: Math.round(performance.now() - t0),
    };
  } finally {
    spill.release();
  }
}

/** Post-build/sync compaction: batched appends leave many small superfiles behind
 * (measured 3-4x index-size bloat on large repos); merge them and sweep the
 * orphans. The 60s gc grace protects any reader mid-query in another
 * process. Tuned for small-file workloads via CX_COMPACTION_TARGET_MIB env var
 * (default 10 MiB, triggers compaction at ~8 MiB with 80% fill).
 * Best-effort - a failed compaction never fails the operation. */
function compact(table: { optimize(opts?: OptimizeOptions): void; gc(graceSecs: number): unknown }): void {
  try {
    const opts: OptimizeOptions = { targetSuperfileSizeMb: COMPACTION_TARGET_MIB };
    table.optimize(opts);
    table.gc(60);
  } catch {
    /* e.g. non-durable storage - the index still works, just bigger */
  }
}

/** Keep the on-disk index out of version control. On a build, add the index
 * directory to the repo-root `.gitignore` when the repo is a git checkout and
 * the dir isn't already ignored. Best-effort and idempotent: it never fails a
 * build, and does nothing when the index lives outside the repo (a custom
 * CX_INDEX_DIR) since there's nothing in the tree to ignore. */
function ensureIndexIgnored(root: string, indexDirPath: string): void {
  try {
    const rel = relative(root, indexDirPath);
    // Index lives outside the repo tree (custom CX_INDEX_DIR) - nothing to ignore.
    if (!rel || rel === "" || rel.startsWith("..")) return;
    // Only manage a .gitignore inside an actual git checkout (dir or worktree file).
    if (!existsSync(join(root, ".git"))) return;

    const entry = rel.split(sep).join("/").replace(/\/+$/, "");
    const gitignorePath = join(root, ".gitignore");
    let current = "";
    try {
      current = readFileSync(gitignorePath, "utf8");
    } catch {
      /* no .gitignore yet - we'll create one */
    }
    const already = current
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/+/, "").replace(/\/+$/, ""))
      .some((l) => l === entry);
    if (already) return;

    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(gitignorePath, `${prefix}${entry}/\n`);
  } catch {
    /* read-only tree, permissions, etc. - never fail indexing over .gitignore */
  }
}

function toTextRow(c: Chunk) {
  return {
    path: c.path,
    start_line: c.startLine,
    end_line: c.endLine,
    lang: c.lang,
    symbol: c.symbol ?? "",
    content: c.content,
  };
}

function toManifest(stats: IndexStats, embedder?: Manifest["embedder"]): Manifest {
  return {
    version: INDEX_FORMAT_VERSION,
    table: TABLE,
    vectors: stats.vectors,
    ...(embedder ? { embedder } : {}),
    files: stats.files,
    chunks: stats.chunks,
    ...(stats.truncatedFiles ? { truncatedFiles: stats.truncatedFiles, maxFiles: stats.maxFiles } : {}),
    languages: stats.languages,
    indexedAt: new Date().toISOString(),
    indexMs: stats.indexMs,
    ...(stats.embedMs !== undefined ? { embedMs: stats.embedMs } : {}),
  };
}
