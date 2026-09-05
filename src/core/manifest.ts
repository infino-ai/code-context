// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The index manifest: a small JSON file next to the engine's catalog that
// records what the index holds and how far indexing has progressed. Tools
// read it to know whether semantic search has unlocked yet ("staged
// readiness": keyword search is available the moment the first batch lands;
// vectors backfill afterwards).

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, PLATFORM_MANIFEST_NAME, TABLE } from "./config.js";
import type { Analyzer } from "./analyzer.js";

/** On-disk index format. Bump when the table schema or the embedded text
 * changes so old indexes are treated as absent and rebuilt, never mixed:
 *   1 -> 2: added the `symbol` column and enriched (contextual) embed text. */
export const INDEX_FORMAT_VERSION = 2;

/** How far the vector half of the index has progressed. */
export type VectorState = "none" | "building" | "ready";

export interface EmbedderInfo {
  provider: string;
  model: string;
  /** Vector width. Absent when the platform embeds server-side: the JSON
   * schema descriptor of an embedding column names the text it embeds, not a
   * width the client ever chose. */
  dim?: number;
  /** Local-model quantization the index was embedded with. */
  dtype?: string;
}

export interface Manifest {
  version: number;
  /** Table name the index lives in (always `chunks` today). */
  table: string;
  /** Where the table lives. `hosted` marks the manifest of the chunks table on
   * the platform database (the platform manifest file, written by the loader);
   * a manifest without it describes the local index. The two are never mixed:
   * the reader of each file rejects the other's origin. */
  origin?: "hosted";
  vectors: VectorState;
  /** The FTS analyzer the table's `content` index was built with. Queries are
   * tokenized by the engine with this analyzer, and the client mirrors it to
   * decide what the index can look up. Absent on manifests written before it
   * was recorded: those tables were built locally through the binding's bare
   * `IndexSpec.fts(column)`, which the pinned engine (0.5.2) indexes with
   * `ascii_lower`, its default - read an absent value as that. */
  analyzer?: Analyzer;
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

/** The platform table's manifest lives beside the local one. */
export function platformManifestPath(indexDirPath: string): string {
  return join(indexDirPath, PLATFORM_MANIFEST_NAME);
}

function readManifestFile(path: string): Manifest | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    // A manifest from an older format reads as absent, so the index rebuilds
    // rather than being queried with a stale schema / raw-embedded vectors.
    if (parsed.version !== INDEX_FORMAT_VERSION || typeof parsed.table !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeManifestFile(indexDirPath: string, path: string, manifest: Manifest): void {
  mkdirSync(indexDirPath, { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

/** The local index's manifest. A file that describes the platform table
 * (origin `hosted`, written by builds before the two manifests were split)
 * reads as absent: the local index it sits beside was never described. */
export function readManifest(indexDirPath: string): Manifest | undefined {
  const manifest = readManifestFile(manifestPath(indexDirPath));
  return manifest?.origin === "hosted" ? undefined : manifest;
}

export function writeManifest(indexDirPath: string, manifest: Manifest): void {
  writeManifestFile(indexDirPath, manifestPath(indexDirPath), manifest);
}

/** The platform table's manifest, or undefined when this machine never loaded
 * it (a table loaded elsewhere has no record here). A manifest whose `vectors`
 * is `building` is provisional: a build from this machine is loading the table
 * and has not finished. */
export function readPlatformManifest(indexDirPath: string): Manifest | undefined {
  const manifest = readManifestFile(platformManifestPath(indexDirPath));
  return manifest?.origin === "hosted" ? manifest : undefined;
}

export function writePlatformManifest(indexDirPath: string, manifest: Manifest): void {
  writeManifestFile(indexDirPath, platformManifestPath(indexDirPath), { ...manifest, origin: "hosted" });
}

/** Forget the platform table: written by a build whose load failed, so the
 * next sync reports that the table has no record here and a build reloads
 * it, rather than trusting a manifest from before the failed load. */
export function removePlatformManifest(indexDirPath: string): void {
  rmSync(platformManifestPath(indexDirPath), { force: true });
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
