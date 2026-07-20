// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The index manifest: a small JSON file next to the engine's catalog that
// records what the index holds and how far indexing has progressed. Tools
// read it to know whether semantic search has unlocked yet ("staged
// readiness": keyword search is available the moment the first batch lands;
// vectors backfill afterwards).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, TABLE } from "./config.js";

/** On-disk index format. Bump when the table schema or the embedded text
 * changes so old indexes are treated as absent and rebuilt, never mixed:
 *   1 -> 2: added the `symbol` column and enriched (contextual) embed text. */
export const INDEX_FORMAT_VERSION = 2;

/** How far the vector half of the index has progressed. */
export type VectorState = "none" | "building" | "ready";

export interface EmbedderInfo {
  provider: string;
  model: string;
  dim: number;
  /** Local-model quantization the index was embedded with. */
  dtype?: string;
}

export interface Manifest {
  version: number;
  /** Table name the index lives in (always `chunks` today). */
  table: string;
  vectors: VectorState;
  embedder?: EmbedderInfo;
  files: number;
  chunks: number;
  /** Files left un-indexed because the repo exceeded the file cap. Absent when
   * the whole tree fit (the common case) - its presence means the index is
   * partial and query results may be incomplete. */
  truncatedFiles?: number;
  /** The file cap in effect when `truncatedFiles` was recorded, for context in
   * the "index is partial" warning. Only meaningful alongside `truncatedFiles`. */
  maxFiles?: number;
  /** Chunk count per language tag. */
  languages: Record<string, number>;
  indexedAt: string;
  /** Wall-clock of the keyword (text) index build, ms. */
  indexMs: number;
  /** Wall-clock of the vector backfill, ms (present once vectors are ready). */
  embedMs?: number;
}

export function manifestPath(indexDirPath: string): string {
  return join(indexDirPath, MANIFEST_NAME);
}

export function readManifest(indexDirPath: string): Manifest | undefined {
  try {
    const raw = readFileSync(manifestPath(indexDirPath), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    // A manifest from an older format reads as absent, so the index rebuilds
    // rather than being queried with a stale schema / raw-embedded vectors.
    if (parsed.version !== INDEX_FORMAT_VERSION || typeof parsed.table !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeManifest(indexDirPath: string, manifest: Manifest): void {
  mkdirSync(indexDirPath, { recursive: true });
  writeFileSync(manifestPath(indexDirPath), JSON.stringify(manifest, null, 2) + "\n");
}

export function emptyManifest(): Manifest {
  return {
    version: INDEX_FORMAT_VERSION,
    table: TABLE,
    vectors: "none",
    files: 0,
    chunks: 0,
    languages: {},
    indexedAt: new Date().toISOString(),
    indexMs: 0,
  };
}
