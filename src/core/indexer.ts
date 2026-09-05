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
//
// THE PLATFORM TABLE. When a platform database is configured (--db <url>) the
// same repository's chunks table also lives there, reached through HostedDb,
// and every build and sync writes both: the two are one index in two places.
// A build loads the platform table after the local stages, in one pass -
// drop, create with both indexes, append in APPEND_BATCH waves - from the same
// spill the local build replayed, so the two tables hold the same rows. A sync
// applies the same diff to both, the platform's deletes and appends started
// first and the local ones run while they are in flight; the file state that
// says "this diff is applied" is written only when both sides have it, so a
// failure on either side is re-applied next time (a sync is idempotent).
// Same-process atomicity does not apply to the platform table: other
// processes read it, and the platform makes each append one commit.

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
import { APPEND_BATCH, EMBED_BATCH, TABLE, DEFAULT_CAPS, DEFAULT_HOSTED_EMBED_PROVIDER, type IndexCaps, type EmbedProvider } from "./config.js";
import { walkRepo } from "./walker.js";
import { shouldIndexFile, chunkFile, looksBinary, embedText, type Chunk } from "./chunker.js";
import {
  readManifest,
  writeManifest,
  readPlatformManifest,
  writePlatformManifest,
  INDEX_FORMAT_VERSION,
  type Manifest,
  type VectorState,
} from "./manifest.js";
import {
  analyzerOf,
  ENGINE_DEFAULT_ANALYZER,
  HOSTED_DEFAULT_ANALYZER,
  isAnalyzer,
  type Analyzer,
} from "./analyzer.js";
import { EMBEDDING_COLUMN, PLATFORM_EMBEDDER_MODEL, PLATFORM_EMBEDDER_PROVIDER } from "./context.js";
import { rowsToIpc, type HostedDb, type HostedIndexes, type JsonColumn } from "./hosted.js";
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

/** Paths named per DELETE predicate when a sync removes stale rows, so one
 * predicate (and, hosted, one query string) stays a bounded size. */
const DELETE_PATHS_PER_PREDICATE = 100;

/** The FTS-indexed column of the chunks table. */
const CONTENT_COLUMN = "content";

/** Distance metric of the vector index, the same in both modes: the local
 * model L2-normalizes, and cosine is what the platform indexes an embedding
 * column with. */
const VECTOR_METRIC = "cosine";

export interface IndexOptions {
  root: string;
  /** The in-process engine connection: the local index every build and sync
   * writes. */
  db: Connection;
  /** The platform client, when a database is configured: its chunks table is
   * written beside the local index by the same build or sync. */
  hosted?: HostedDb;
  /** Where the manifests and the file state are written (the index directory). */
  indexDirPath: string;
  /** The local model that embeds the local index (and, under
   * `embedProvider: "local"`, the platform table). Omit or pass null for a
   * keyword-only index; vectors can be added by re-indexing. The caller owns
   * the embedder's lifecycle (dispose, when it has one). */
  embedder?: Embedder | null;
  /** Platform table only: who fills its `embedding` column. `platform`, the
   * default, declares an embedding column the platform fills from `content`
   * with its own model (the rows are appended without the column); `local`
   * sends the vectors `embedder` produces. With `local` and no embedder the
   * platform table is keyword-only. The local index always embeds locally. */
  embedProvider?: EmbedProvider;
  caps?: IndexCaps;
  /** Platform table only: the FTS analyzer its `content` index is created
   * with (HOSTED_DEFAULT_ANALYZER when none is given - see hostedAnalyzer),
   * sent to the platform explicitly and recorded in the platform manifest. The
   * local index is built with the engine default through the binding's bare
   * `IndexSpec.fts(column)`. A sync whose value differs from the recorded one
   * reports rebuild-required: a table's analyzer is fixed at create time. */
  analyzer?: Analyzer;
  /** `load` is the platform pass (drop, create, append waves) after the local
   * stages; the other phases are the local build's. */
  onPhase?: (phase: "scan" | "chunk" | "commit-text" | "embed" | "commit-vectors" | "load") => void;
  /** Progress within the current phase. */
  onProgress?: (done: number, total: number) => void;
}

/** What a platform load or sync cost on the platform side, summed from the
 * client's per-call telemetry. Lives in the stats (and so in `cx index --json`
 * and the ledger), never in a tool result. */
export interface HostedLoadStats {
  /** Append requests made (one per APPEND_BATCH wave). */
  appendCalls: number;
  /** Write tokens the platform metered across the drop, create, delete and
   * append calls, from its `x-infino-write-tokens` headers. Absent when no
   * response carried the header - a missing meter is not a zero bill. */
  writeTokens?: number;
  /** Wall clock of the table writes (drop through the last append), ms;
   * scanning, chunking and embedding are counted in indexMs / embedMs. */
  loadWallMs: number;
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
  /** Wall clock to keyword-live (stage 1). */
  indexMs: number;
  embedMs?: number;
  /** Present when the vector stage failed; the keyword index is still live. */
  embedError?: string;
  /** Present when a platform database is configured: the platform-side cost
   * of loading its table. */
  hosted?: HostedLoadStats;
  /** Present when the platform load failed; the local index is complete and
   * the platform table is whatever it was. */
  hostedError?: string;
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
 * resolves when the vector stage and, when a platform database is configured,
 * the platform load have landed (== `text` when there is neither). `completion`
 * never rejects - a vector-stage failure is recorded in the stats
 * (embedError) and the manifest with the keyword index still live, and a
 * platform-load failure in `hostedError` with the local index complete. */
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
 * backfill in-process), then load the platform table when one is configured. */
export async function indexRepoStaged(opts: IndexOptions): Promise<StagedIndexRun> {
  const { root, indexDirPath, embedder, onPhase, onProgress } = opts;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const t0 = performance.now();

  // Keep the index out of the user's commits before we write a byte of it.
  ensureIndexIgnored(root, indexDirPath);

  const scanned = await scanToSpill(opts, caps);
  const db = opts.db;
  const { spill, files, chunkCount, languages, fileState, truncatedFiles } = scanned;

  // --- stage 1: swap in the keyword table -------------------------------------
  // One synchronous block (drop → create → append waves; sync spill reads, no
  // awaits) so same-process readers never observe a half-swapped table. From
  // here until the completion promise exists (whose finally owns the spill),
  // any throw must release it - a leaked name would pin the file in the
  // liveSpills registry for the life of the process.
  try {
    onPhase?.("commit-text");
    if (db.listTables().includes(TABLE)) db.dropTable(TABLE, true);
    const textTable = db.createTable(TABLE, { ...TEXT_SCHEMA }, new IndexSpec().fts(CONTENT_COLUMN));
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
    writeManifest(indexDirPath, toManifest(stats, ENGINE_DEFAULT_ANALYZER));
    writeFileState(indexDirPath, fileState);
    if (!embedder && !opts.hosted) {
      spill.release();
      return { text: stats, completion: Promise.resolve(stats) };
    }

    // --- stage 2: embed and swap in the hybrid table; then the platform load ---
    // A failure anywhere before the swap (model download, endpoint down, full
    // disk) leaves the stage-1 keyword table live and the manifest honest -
    // search degrades, indexing never fails. The swap itself is again one
    // synchronous block. The platform load comes after, from the same spill
    // and the same vectors, so the two tables hold the same rows; its failure
    // is recorded, never thrown. `completion` must never reject; its finally
    // owns the spill from here on.
    const completion = (async () => {
      let dim: number | undefined;
      try {
        if (embedder) {
          try {
            onPhase?.("embed");
            const tEmbed = performance.now();
            dim =
              chunkCount === 0
                ? await embedder.dim() // no chunks to embed - just size the schema
                : await embedSpill(spill, embedder, chunkCount, onProgress);

            onPhase?.("commit-vectors");
            db.dropTable(TABLE, true);
            const hybridTable = db.createTable(
              TABLE,
              { ...TEXT_SCHEMA, [EMBEDDING_COLUMN]: { vector: dim } },
              new IndexSpec().fts(CONTENT_COLUMN).vector(EMBEDDING_COLUMN, dim, VECTOR_METRIC),
            );
            // Zero chunks ⇒ no vector spill was ever written; the empty table is
            // already complete.
            if (chunkCount > 0) appendSpillSync(hybridTable, spill, chunkCount, dim, onProgress);
            compact(hybridTable);
            stats.vectors = "ready";
            stats.embedMs = Math.round(performance.now() - tEmbed);
            writeManifest(indexDirPath, toManifest(stats, ENGINE_DEFAULT_ANALYZER, localEmbedderInfo(embedder, dim)));
          } catch (err) {
            dim = undefined;
            stats.vectors = "none";
            stats.embedError = (err as Error).message;
            try {
              writeManifest(indexDirPath, toManifest(stats, ENGINE_DEFAULT_ANALYZER));
            } catch {
              /* disk gone - nothing left to record on, and completion must not reject */
            }
          }
        }
        if (opts.hosted) {
          try {
            stats.hosted = await loadPlatform(opts, opts.hosted, scanned, caps, embedder && dim !== undefined ? { embedder, dim } : undefined, stats);
          } catch (err) {
            stats.hostedError = (err as Error).message;
          }
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

// --- scan + chunk ------------------------------------------------------------------

/** What the walk produced: the chunk spill and the counts the stats need. */
interface Scanned {
  spill: Spill;
  files: number;
  chunkCount: number;
  languages: Record<string, number>;
  fileState: FileState;
  truncatedFiles: number;
}

/** Walk the tree and spool every chunk to the spill. The whole tree spools
 * before any table is touched, in either mode, so the previous index serves
 * queries all through the walk, and a failure here (full disk, racing
 * deletes) costs nothing - the spill is released and the error surfaces. */
async function scanToSpill(opts: IndexOptions, caps: IndexCaps): Promise<Scanned> {
  const { root, indexDirPath, onPhase, onProgress } = opts;

  onPhase?.("scan");
  const walked = walkRepo(root).filter(
    (f) => shouldIndexFile(f.path) && f.size <= caps.maxFileBytes,
  );
  const taken = walked.slice(0, caps.maxFiles);
  const truncatedFiles = walked.length - taken.length;

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
  return { spill, files, chunkCount, languages, fileState, truncatedFiles };
}

// --- the platform load -------------------------------------------------------------------

/** Load the spilled chunks into the platform's chunks table in one pass after
 * the local stages: drop → create → append waves, from the spill the local
 * build replayed, so both tables hold the same rows. The table gets the FTS
 * index with the requested analyzer and, when there are vectors, either a
 * client-vector column carrying the local embedder's vectors (`embedProvider:
 * "local"`, the vector spill already written by the local stage) with a
 * cosine index, or a platform-filled embedding column (which the platform
 * indexes by itself - a vector entry naming it is a 400). Records the
 * platform manifest so a later sync can apply its diff to this table too.
 * Throws on a platform failure; the caller records it and the local index
 * stands. */
async function loadPlatform(
  opts: IndexOptions,
  hosted: HostedDb,
  scanned: Scanned,
  caps: IndexCaps,
  vectors: { embedder: Embedder; dim: number } | undefined,
  stats: IndexStats,
): Promise<HostedLoadStats> {
  const { indexDirPath, onPhase, onProgress } = opts;
  const provider: EmbedProvider = opts.embedProvider ?? DEFAULT_HOSTED_EMBED_PROVIDER;
  const analyzer = opts.analyzer ?? HOSTED_DEFAULT_ANALYZER;
  const { spill, chunkCount } = scanned;

  const platform = provider === "platform";
  const dim = platform ? undefined : vectors?.dim;
  // Zero chunks ⇒ no vector spill was ever written and nothing is appended.
  if (dim !== undefined && chunkCount > 0) verifyVectorSpill(spill, chunkCount, dim);
  const columns = hostedColumns(platform ? { platform: true } : { dim });
  const indexes = hostedIndexes(analyzer, dim !== undefined);

  onPhase?.("load");
  const tLoad = performance.now();
  const meter = newHostedMeter();
  // A build replaces the platform table the way it replaces the local one:
  // the two are the same index, and a build is a full rebuild of both.
  if ((await hosted.listTables()).includes(TABLE)) {
    await hosted.dropTable(TABLE, true);
    meterHostedCall(meter, hosted);
  }
  await hosted.createTable(TABLE, columns, indexes);
  meterHostedCall(meter, hosted);
  if (chunkCount > 0) await appendSpillHosted(hosted, spill, chunkCount, columns, dim, platform, meter, onProgress);

  const loadStats: HostedLoadStats = { ...meter, loadWallMs: Math.round(performance.now() - tLoad) };
  const embedderInfo = platform
    ? { provider: PLATFORM_EMBEDDER_PROVIDER, model: PLATFORM_EMBEDDER_MODEL }
    : vectors && dim !== undefined
      ? localEmbedderInfo(vectors.embedder, dim)
      : undefined;
  writePlatformManifest(
    indexDirPath,
    toManifest({ ...stats, vectors: platform || dim !== undefined ? "ready" : "none", hosted: loadStats }, analyzer, embedderInfo, "hosted"),
  );
  return loadStats;
}

/** Running totals of a hosted load's platform calls; `loadWallMs` is added
 * when the load ends. */
type HostedMeter = Omit<HostedLoadStats, "loadWallMs">;

const newHostedMeter = (): HostedMeter => ({ appendCalls: 0 });

/** Fold the client's telemetry of the call that just completed into the
 * meter: appends are counted, write tokens summed when the response carried
 * the header. Called right after each write, while `lastCall()` is that call. */
function meterHostedCall(meter: HostedMeter, hosted: HostedDb): void {
  const info = hosted.lastCall();
  if (!info) return;
  if (info.op === "append") meter.appendCalls++;
  if (info.writeTokens !== undefined) meter.writeTokens = (meter.writeTokens ?? 0) + info.writeTokens;
}

/** The chunks table's columns as the platform's `create_table` takes them:
 * the text schema (the same spellings the local table uses), plus the vector
 * column when there is one - client vectors of a known width, or an
 * embedding column the platform fills from `content`. */
function hostedColumns(vectors: { platform: true } | { dim?: number }): JsonColumn[] {
  const columns: JsonColumn[] = Object.entries(TEXT_SCHEMA).map(([name, type]) => ({ name, type }));
  if ("platform" in vectors) {
    columns.push({ name: EMBEDDING_COLUMN, type: { type: "embedding", source: [CONTENT_COLUMN] } });
  } else if (vectors.dim !== undefined) {
    columns.push({ name: EMBEDDING_COLUMN, type: { type: "vector", dim: vectors.dim } });
  }
  return columns;
}

/** The index declarations of a hosted chunks table. The analyzer is always
 * named, never left to the platform default, so the manifest records exactly
 * what the table has. A vector index is declared only for a client-vector
 * column: the platform indexes an embedding column by itself and rejects a
 * caller's declaration for it. */
function hostedIndexes(analyzer: Analyzer, clientVectors: boolean): HostedIndexes {
  return {
    fts: [{ column: CONTENT_COLUMN, analyzer }],
    ...(clientVectors ? { vector: [{ column: EMBEDDING_COLUMN, metric: VECTOR_METRIC }] } : {}),
  };
}

/** Replay a spill into the hosted table in APPEND_BATCH waves, each one
 * append request (one platform commit). Client vectors ride an Arrow IPC
 * stream, the only append encoding that carries a vector column; a
 * platform-embedded table takes the JSON envelope with the rows minus the
 * embedding column, which the platform fills. Async on purpose - there is no
 * same-process atomicity to keep over the network. */
async function appendSpillHosted(
  hosted: HostedDb,
  spill: Spill,
  expectedRows: number,
  columns: JsonColumn[],
  dim: number | undefined,
  platform: boolean,
  meter: HostedMeter,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let appended = 0;
  for (const wave of spillWaves(spill, expectedRows, dim)) {
    if (platform) {
      await hosted.appendRows(TABLE, wave.rows.map(toTextRow));
    } else {
      // rowsToIpc takes the Float32Array views as they are - no boxing.
      await hosted.appendIpc(TABLE, rowsToIpc(columns, waveRows(wave, dim, (v) => v)));
    }
    meterHostedCall(meter, hosted);
    appended += wave.rows.length;
    onProgress?.(appended, expectedRows);
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

/** Refuse a vector spill whose size is not exactly `expectedRows` rows of
 * `dim` floats: a silently short table is the one unrecoverable outcome, so
 * the check runs before any table is touched. */
function verifyVectorSpill(spill: Spill, expectedRows: number, dim: number): void {
  const size = statSync(spill.vectorsPath).size;
  if (size !== expectedRows * dim * F32_BYTES) {
    throw new Error(
      `vector spill holds ${size} bytes, expected ${expectedRows * dim * F32_BYTES} (${expectedRows} rows × ${dim}d)`,
    );
  }
}

/** One replay wave: up to APPEND_BATCH chunks and, when the build has
 * vectors, their packed f32 rows in the same order (row j at
 * `f32[j*dim .. (j+1)*dim)`). */
interface SpillWave {
  rows: Chunk[];
  f32?: Float32Array;
}

/** Replay a spill in APPEND_BATCH waves. With `dim` set, each wave is joined
 * with its packed f32 vectors from the vector spill (same order, same count -
 * verified). The generator body is synchronous between yields, so the local
 * consumer's drop→create→append block stays atomic to same-process readers,
 * while the hosted consumer awaits a network round trip per wave. Only the
 * in-flight wave is ever resident. */
function* spillWaves(spill: Spill, expectedRows: number, dim?: number): Generator<SpillWave> {
  let fd = -1;
  if (dim !== undefined) {
    verifyVectorSpill(spill, expectedRows, dim);
    fd = openSync(spill.vectorsPath, "r");
  }
  try {
    let replayed = 0;
    let rows: Chunk[] = [];
    const wave = (): SpillWave => {
      const out: SpillWave = { rows };
      if (dim !== undefined) {
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
        out.f32 = new Float32Array(ab);
      }
      replayed += rows.length;
      rows = [];
      return out;
    };
    for (const line of readLinesSync(spill.chunksPath)) {
      rows.push(JSON.parse(line) as Chunk);
      if (rows.length >= APPEND_BATCH) yield wave();
    }
    if (rows.length > 0) yield wave();
    if (replayed !== expectedRows) {
      throw new Error(`chunk spill replayed ${replayed} rows, expected ${expectedRows}`);
    }
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** A wave's rows as table rows: the text columns, plus the `embedding`
 * column when the wave carries vectors. `vector` shapes each row's f32 view
 * for the consumer - boxed to number[] for the engine binding, kept as the
 * view for the Arrow IPC encoder. */
function waveRows(wave: SpillWave, dim: number | undefined, vector: (v: Float32Array) => unknown): RowRecord[] {
  const f32 = wave.f32;
  if (dim === undefined || !f32) return wave.rows.map(toTextRow);
  return wave.rows.map((c, j) => ({ ...toTextRow(c), [EMBEDDING_COLUMN]: vector(f32.subarray(j * dim, (j + 1) * dim)) }));
}

/** Replay a spill into a local table in APPEND_BATCH waves - synchronously,
 * so the caller's drop→create→append block stays atomic to same-process
 * readers. The engine binding takes number[] rows, so one wave is boxed
 * transiently - bounded, unlike the whole-corpus number[][] this replaced. */
function appendSpillSync(
  table: { append(rows: RowRecord[]): void },
  spill: Spill,
  expectedRows: number,
  dim?: number,
  onProgress?: (done: number, total: number) => void,
): void {
  let appended = 0;
  for (const wave of spillWaves(spill, expectedRows, dim)) {
    table.append(waveRows(wave, dim, (v) => Array.from(v)));
    appended += wave.rows.length;
    onProgress?.(appended, expectedRows);
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
  /** Present when a platform database is configured: the platform-side cost
   * of its deletes and appends. */
  hosted?: HostedLoadStats;
}

export type SyncOutcome = SyncResult | { action: "rebuild-required"; reason: string };

const rebuildRequired = (reason: string): SyncOutcome => ({ action: "rebuild-required", reason });

/** Bring the index up to date with the working tree by re-chunking (and
 * re-embedding) only the files that changed since the last index or sync.
 * Reports `rebuild-required` instead of guessing when incremental can't be
 * correct (no prior state, an in-flight vector backfill, or an embedder that
 * no longer matches the index). Fresh chunks spool through spills and are
 * embedded BEFORE any stale row is deleted, so an embed failure (which throws)
 * leaves the index exactly as it was.
 *
 * When a platform database is configured the same diff goes to its table too,
 * as delete-by-path-predicate plus append waves, started before the local
 * apply so both are in flight together. The platform table needs the record
 * this machine's build wrote (the platform manifest and the file state); a
 * table loaded elsewhere has no diff base here, and the outcome says so
 * rather than guessing. The file state is written only once both sides have
 * the diff, so a failure on either is re-applied by the next sync. */
export async function syncRepo(opts: IndexOptions): Promise<SyncOutcome> {
  const { root, indexDirPath, embedder, onPhase, db } = opts;
  const hosted = opts.hosted;
  const provider: EmbedProvider = opts.embedProvider ?? DEFAULT_HOSTED_EMBED_PROVIDER;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const t0 = performance.now();

  const manifest = readManifest(indexDirPath);
  const prev = readFileState(indexDirPath);
  if (!manifest || !prev || !db.listTables().includes(TABLE)) return rebuildRequired("no prior index state");
  if (manifest.vectors === "building") return rebuildRequired("vector backfill in progress");

  // The local index's vectors: a model switch is a rebuild.
  const hasVectors = manifest.vectors === "ready";
  if (hasVectors) {
    if (!embedder) return rebuildRequired("index has vectors but no embedder is configured");
    if (manifest.embedder && manifest.embedder.model !== embedder.model) {
      return rebuildRequired(`embedder changed (index: ${manifest.embedder.model}, current: ${embedder.model})`);
    }
  }

  // The platform table: it must be one this machine loaded, still exist, and
  // take the vectors the current settings produce. Who fills its vectors is
  // fixed by the table - a platform-embedded column takes no client vectors
  // and a client-vector column takes no platform text - so a provider switch
  // is a rebuild, and so is its analyzer: rows appended by a sync are
  // tokenized with the table's, whatever the caller now wants.
  let platformManifest: Manifest | undefined;
  let platformClientVectors = false;
  if (hosted) {
    platformManifest = readPlatformManifest(indexDirPath);
    if (!platformManifest) {
      return rebuildRequired(
        `no record of the platform table in ${indexDirPath} (it was loaded from another machine, or never loaded) - a build loads it`,
      );
    }
    if (!(await hosted.listTables()).includes(TABLE)) return rebuildRequired(`no ${TABLE} table on the platform database`);
    const indexedPlatform = platformManifest.embedder?.provider === PLATFORM_EMBEDDER_PROVIDER;
    if (platformManifest.vectors === "ready") {
      if (indexedPlatform && provider !== "platform") {
        return rebuildRequired(`embedder changed (platform table: ${PLATFORM_EMBEDDER_PROVIDER}, current: ${embedder?.model ?? "none"})`);
      }
      if (!indexedPlatform && provider === "platform") {
        return rebuildRequired(`embedder changed (platform table: ${platformManifest.embedder?.model ?? "client vectors"}, current: ${PLATFORM_EMBEDDER_PROVIDER})`);
      }
      if (!indexedPlatform && !embedder) return rebuildRequired("platform table has client vectors but no embedder is configured");
      if (!indexedPlatform && embedder && platformManifest.embedder && platformManifest.embedder.model !== embedder.model) {
        return rebuildRequired(`embedder changed (platform table: ${platformManifest.embedder.model}, current: ${embedder.model})`);
      }
      platformClientVectors = !indexedPlatform;
    }
    const recordedAnalyzer = analyzerOf(platformManifest);
    if (opts.analyzer !== undefined && opts.analyzer !== recordedAnalyzer) {
      return rebuildRequired(`analyzer changed (platform table: ${recordedAnalyzer}, current: ${opts.analyzer})`);
    }
  }

  // Sweep crash leftovers on every sync, INCLUDING ones about to no-op: on an
  // unchanging repo the no-op path is the only code that ever runs again, and
  // a crashed build's spill would otherwise sit in the index dir forever.
  // One readdir, throttled upstream by the auto-sync interval.
  sweepStaleSpills(indexDirPath);

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
    // while the indexed content doesn't. Reconcile the manifests when it
    // drifts, otherwise the "index is partial" marker goes stale.
    if (truncatedFiles !== (manifest.truncatedFiles ?? 0)) {
      writeManifest(indexDirPath, withTruncation(manifest, truncatedFiles, caps));
    }
    if (platformManifest && truncatedFiles !== (platformManifest.truncatedFiles ?? 0)) {
      writePlatformManifest(indexDirPath, withTruncation(platformManifest, truncatedFiles, caps));
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
    // One pass serves both tables. A platform-embedded column needs no vectors
    // from here: the platform fills it as the rows land.
    let dim: number | undefined;
    if ((hasVectors || platformClientVectors) && embedder && chunksAdded > 0) {
      onPhase?.("embed");
      dim = await embedSpill(spill, embedder, chunksAdded, opts.onProgress);
    }

    // --- apply: deletes + appends, to both tables at once ----------------------------
    // `added` paths are deleted too: it makes a re-run of an interrupted sync
    // idempotent instead of duplicating rows. The platform apply is started
    // first, so its first round trip is on the wire while the local block
    // runs; the local block is one synchronous stretch, so same-process
    // readers never see the deletes without the appends.
    onPhase?.("commit-text");
    const predicates = stalePredicates([...diff.added, ...diff.changed, ...diff.deleted]);
    const platformApply = hosted
      ? applyPlatformDiff(
          hosted,
          predicates,
          spill,
          chunksAdded,
          platformManifest?.embedder?.provider === PLATFORM_EMBEDDER_PROVIDER ? { platform: true } : { dim: platformClientVectors ? dim : undefined },
          opts.onProgress,
        )
      : undefined;
    let chunksRemoved = 0;
    try {
      const table = db.openTable(TABLE);
      for (const predicate of predicates) chunksRemoved += table.delete(predicate).nTombstoned;
      if (chunksAdded > 0) appendSpillSync(table, spill, chunksAdded, hasVectors ? dim : undefined);
      // Compact after deletes/appends to keep tombstones clean. The platform
      // table's compaction is the platform's job.
      compact(table);
    } catch (err) {
      // The platform apply is in flight; let it settle before the local
      // failure is reported, so no rejection goes unobserved. The file state
      // is not written, so the next sync re-applies the diff to both.
      await platformApply?.catch(() => undefined);
      throw err;
    }
    const hostedStats = platformApply ? await platformApply : undefined;

    // --- persist state + recount ----------------------------------------------------
    // Only now is the diff applied everywhere it must be.
    writeFileState(indexDirPath, diff.next);
    const nextManifest = withTruncation(
      { ...manifest, ...tableCounts(db.querySql(TABLE_COUNTS_SQL), db.querySql(TABLE_LANGUAGES_SQL)), indexedAt: new Date().toISOString() },
      truncatedFiles,
      caps,
    );
    writeManifest(indexDirPath, nextManifest);
    if (hosted && platformManifest) {
      const [counts, langs] = await Promise.all([hosted.querySql(TABLE_COUNTS_SQL), hosted.querySql(TABLE_LANGUAGES_SQL)]);
      writePlatformManifest(
        indexDirPath,
        withTruncation({ ...platformManifest, ...tableCounts(counts, langs), indexedAt: nextManifest.indexedAt }, truncatedFiles, caps),
      );
    }

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
      ...(hostedStats ? { hosted: hostedStats } : {}),
    };
  } finally {
    spill.release();
  }
}

/** Apply a sync's diff to the platform table: the stale paths deleted, then
 * the fresh rows appended in waves. `vectors` says what rides with the rows -
 * nothing for a platform-embedded column, the local vectors of width `dim`
 * for a client-vector column, none when the table is keyword-only. */
async function applyPlatformDiff(
  hosted: HostedDb,
  predicates: string[],
  spill: Spill,
  chunksAdded: number,
  vectors: { platform: true } | { dim?: number },
  onProgress?: (done: number, total: number) => void,
): Promise<HostedLoadStats> {
  const tLoad = performance.now();
  const meter = newHostedMeter();
  for (const predicate of predicates) {
    await hosted.deleteWhere(TABLE, predicate);
    meterHostedCall(meter, hosted);
  }
  if (chunksAdded > 0) {
    const platform = "platform" in vectors;
    const dim = platform ? undefined : vectors.dim;
    await appendSpillHosted(hosted, spill, chunksAdded, hostedColumns(vectors), dim, platform, meter, onProgress);
  }
  return { ...meter, loadWallMs: Math.round(performance.now() - tLoad) };
}

/** The recount a sync writes back to a manifest. */
const TABLE_COUNTS_SQL = `SELECT COUNT(*) AS n, COUNT(DISTINCT path) AS f FROM ${TABLE}`;
const TABLE_LANGUAGES_SQL = `SELECT lang, COUNT(*) AS n FROM ${TABLE} GROUP BY lang`;

/** The manifest fields a recount refreshes, from the two queries' rows. */
function tableCounts(counts: RowRecord[], langs: RowRecord[]): Pick<Manifest, "files" | "chunks" | "languages"> {
  const [{ n: chunkCount, f: fileCount }] = counts as [{ n: unknown; f: unknown }];
  const languages: Record<string, number> = {};
  for (const r of langs as Array<{ lang: string; n: unknown }>) languages[r.lang || "other"] = Number(r.n);
  return { files: Number(fileCount), chunks: Number(chunkCount), languages };
}

/** `manifest` with its truncation fields tracking the tree as it grows or
 * shrinks: set when files are now over the cap, cleared when the tree has
 * dropped back under it. */
function withTruncation(manifest: Manifest, truncatedFiles: number, caps: IndexCaps): Manifest {
  const next: Manifest = { ...manifest };
  if (truncatedFiles > 0) {
    next.truncatedFiles = truncatedFiles;
    next.maxFiles = caps.maxFiles;
  } else {
    delete next.truncatedFiles;
    delete next.maxFiles;
  }
  return next;
}

/** `path IN (...)` predicates over the stale paths, DELETE_PATHS_PER_PREDICATE
 * per predicate, single quotes doubled for SQL. */
function stalePredicates(paths: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i += DELETE_PATHS_PER_PREDICATE) {
    const batch = paths.slice(i, i + DELETE_PATHS_PER_PREDICATE).map((p) => `'${p.replace(/'/g, "''")}'`);
    out.push(`path IN (${batch.join(",")})`);
  }
  return out;
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

/** The manifest's record of a local embedder, with the width it produced. */
function localEmbedderInfo(embedder: Embedder, dim: number): Manifest["embedder"] {
  return {
    provider: embedder.provider,
    model: embedder.model,
    dim,
    ...(embedder.dtype ? { dtype: embedder.dtype } : {}),
  };
}

function toManifest(
  stats: IndexStats,
  analyzer: Analyzer,
  embedder?: Manifest["embedder"],
  origin?: Manifest["origin"],
): Manifest {
  return {
    version: INDEX_FORMAT_VERSION,
    table: TABLE,
    ...(origin ? { origin } : {}),
    vectors: stats.vectors,
    analyzer,
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
