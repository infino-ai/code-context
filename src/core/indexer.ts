// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Staged indexing. Stage 1 commits a keyword (FTS) index — search works
// seconds after indexing starts, before any embedding model even exists on
// the machine. Stage 2 embeds every chunk and rebuilds the same table with a
// vector index; hybrid/semantic search unlocks when it lands. The table name
// never changes, so SQL written against `chunks` keeps working across stages;
// the manifest records how far the index has progressed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IndexSpec, type Connection } from "@infino-ai/infino";
import { APPEND_BATCH, EMBED_BATCH, N_CENT, TABLE, DEFAULT_CAPS, type IndexCaps } from "./config.js";
import { walkRepo } from "./walker.js";
import { shouldIndexFile, chunkFile, looksBinary, type Chunk } from "./chunker.js";
import { readManifest, writeManifest, type Manifest, type VectorState } from "./manifest.js";
import {
  diffFiles,
  emptyFileState,
  hashContent,
  readFileState,
  writeFileState,
  type FileState,
} from "./filestate.js";
import type { Embedder } from "./embedder.js";

export interface IndexOptions {
  root: string;
  db: Connection;
  /** Where the manifest is written (the index directory). */
  indexDirPath: string;
  /** Omit for a keyword-only index (vectors can be added by re-indexing). */
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
  content: "large_utf8",
} as const;

/** A staged run: `text` resolves when keyword search is live; `completion`
 * resolves when the vector stage lands (== `text` when there is no embedder).
 * `completion` never rejects — a vector-stage failure is recorded in the
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

  // --- scan + chunk ---------------------------------------------------------
  onPhase?.("scan");
  const walked = walkRepo(root).filter(
    (f) => shouldIndexFile(f.path) && f.size <= caps.maxFileBytes,
  );
  const taken = walked.slice(0, caps.maxFiles);
  const truncatedFiles = walked.length - taken.length;

  onPhase?.("chunk");
  const chunks: Chunk[] = [];
  const languages: Record<string, number> = {};
  const fileState = emptyFileState();
  let files = 0;
  for (let i = 0; i < taken.length; i++) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, taken[i].path));
    } catch {
      continue; // racing deletes are fine — index what's readable
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
    for (const c of fileChunks) languages[c.lang || "other"] = (languages[c.lang || "other"] ?? 0) + 1;
    chunks.push(...fileChunks);
    if (i % 50 === 0) onProgress?.(i, taken.length);
  }

  // --- stage 1: keyword index (search is live when this returns) -------------
  onPhase?.("commit-text");
  if (db.listTables().includes(TABLE)) db.dropTable(TABLE, true);
  const textTable = db.createTable(TABLE, { ...TEXT_SCHEMA }, new IndexSpec().fts("content"));
  for (let i = 0; i < chunks.length; i += APPEND_BATCH) {
    textTable.append(chunks.slice(i, i + APPEND_BATCH).map(toTextRow));
    onProgress?.(Math.min(i + APPEND_BATCH, chunks.length), chunks.length);
  }
  const indexMs = Math.round(performance.now() - t0);

  const stats: IndexStats = {
    files,
    chunks: chunks.length,
    ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
    languages,
    vectors: embedder ? "building" : "none",
    indexMs,
  };
  writeManifest(indexDirPath, toManifest(stats));
  writeFileState(indexDirPath, fileState);
  if (!embedder) return { text: stats, completion: Promise.resolve(stats) };

  // --- stage 2: embed + rebuild with a vector index ---------------------------
  // A failure here (model download, endpoint down) leaves the keyword index
  // live and the manifest honest — search degrades, indexing never fails.
  const completion = (async () => {
    try {
      onPhase?.("embed");
      const tEmbed = performance.now();
      const dim = await embedder.dim();
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        vectors.push(...(await embedder.embed(batch.map((c) => c.content))));
        onProgress?.(Math.min(i + EMBED_BATCH, chunks.length), chunks.length);
      }

      // The rebuild below is one synchronous block — drop, create, append —
      // so concurrent readers in this process never observe a half-built table.
      onPhase?.("commit-vectors");
      db.dropTable(TABLE, true);
      const hybridTable = db.createTable(
        TABLE,
        { ...TEXT_SCHEMA, embedding: { vector: dim } },
        new IndexSpec().fts("content").vector("embedding", dim, N_CENT, "cosine"),
      );
      for (let i = 0; i < chunks.length; i += APPEND_BATCH) {
        hybridTable.append(
          chunks.slice(i, i + APPEND_BATCH).map((c, j) => ({
            ...toTextRow(c),
            embedding: vectors[i + j],
          })),
        );
      }
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
      writeManifest(indexDirPath, toManifest(stats));
    }
    return stats;
  })();
  return { text: { ...stats }, completion };
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
  vectors: VectorState;
  tookMs: number;
}

export type SyncOutcome = SyncResult | { action: "rebuild-required"; reason: string };

/** Bring the index up to date with the working tree by re-chunking (and
 * re-embedding) only the files that changed since the last index or sync.
 * Reports `rebuild-required` instead of guessing when incremental can't be
 * correct (no prior state, an in-flight vector backfill, or an embedder that
 * no longer matches the index). */
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
  const candidates = walkRepo(root)
    .filter((f) => shouldIndexFile(f.path) && f.size <= caps.maxFileBytes)
    .slice(0, caps.maxFiles);
  const buffers = new Map<string, Buffer>();
  const diff = diffFiles(candidates, prev, (path) => {
    try {
      const buf = readFileSync(join(root, path));
      buffers.set(path, buf);
      return buf;
    } catch {
      return undefined;
    }
  });

  if (diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0) {
    writeFileState(indexDirPath, diff.next); // refresh stat fingerprints
    return {
      action: "noop",
      filesAdded: 0,
      filesChanged: 0,
      filesDeleted: 0,
      chunksAdded: 0,
      chunksRemoved: 0,
      files: manifest.files,
      chunks: manifest.chunks,
      vectors: manifest.vectors,
      tookMs: Math.round(performance.now() - t0),
    };
  }

  // --- re-chunk (and re-embed) just the touched files ---------------------------
  onPhase?.("chunk");
  const freshChunks: Chunk[] = [];
  for (const path of [...diff.added, ...diff.changed]) {
    const buf = buffers.get(path);
    if (!buf || looksBinary(buf)) continue;
    freshChunks.push(...(await chunkFile(path, buf.toString("utf8"))));
  }

  let vectors: number[][] | undefined;
  if (hasVectors && embedder && freshChunks.length > 0) {
    onPhase?.("embed");
    vectors = [];
    for (let i = 0; i < freshChunks.length; i += EMBED_BATCH) {
      const batch = freshChunks.slice(i, i + EMBED_BATCH);
      vectors.push(...(await embedder.embed(batch.map((c) => c.content))));
      opts.onProgress?.(Math.min(i + EMBED_BATCH, freshChunks.length), freshChunks.length);
    }
  }

  // --- apply: delete stale rows, append fresh ones ------------------------------
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
  for (let i = 0; i < freshChunks.length; i += APPEND_BATCH) {
    table.append(
      freshChunks.slice(i, i + APPEND_BATCH).map((c, j) => ({
        ...toTextRow(c),
        ...(vectors ? { embedding: vectors[i + j] } : {}),
      })),
    );
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
  writeManifest(indexDirPath, nextManifest);

  return {
    action: "synced",
    filesAdded: diff.added.length,
    filesChanged: diff.changed.length,
    filesDeleted: diff.deleted.length,
    chunksAdded: freshChunks.length,
    chunksRemoved,
    files: nextManifest.files,
    chunks: nextManifest.chunks,
    vectors: nextManifest.vectors,
    tookMs: Math.round(performance.now() - t0),
  };
}

function toTextRow(c: Chunk) {
  return {
    path: c.path,
    start_line: c.startLine,
    end_line: c.endLine,
    lang: c.lang,
    content: c.content,
  };
}

function toManifest(stats: IndexStats, embedder?: Manifest["embedder"]): Manifest {
  return {
    version: 1,
    table: TABLE,
    vectors: stats.vectors,
    ...(embedder ? { embedder } : {}),
    files: stats.files,
    chunks: stats.chunks,
    languages: stats.languages,
    indexedAt: new Date().toISOString(),
    indexMs: stats.indexMs,
    ...(stats.embedMs !== undefined ? { embedMs: stats.embedMs } : {}),
  };
}
