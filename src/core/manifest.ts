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
  version: 1;
  /** Table name the index lives in (always `chunks` today). */
  table: string;
  vectors: VectorState;
  embedder?: EmbedderInfo;
  files: number;
  chunks: number;
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
    if (parsed.version !== 1 || typeof parsed.table !== "string") return undefined;
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
    version: 1,
    table: TABLE,
    vectors: "none",
    files: 0,
    chunks: 0,
    languages: {},
    indexedAt: new Date().toISOString(),
    indexMs: 0,
  };
}
