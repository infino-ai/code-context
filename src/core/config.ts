// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Paths, environment, and tuning constants shared by the CLI and MCP server.

import { join, resolve } from "node:path";

/** Directory name of the on-disk index, created in the repo root. */
export const INDEX_DIR_NAME = ".infino";

/** The one table every tool reads. Stable across index stages: the staged
 * (keyword-only) build and the final (hybrid) build use the same name, so
 * SQL written against `chunks` keeps working as vectors arrive. */
export const TABLE = "chunks";

/** Manifest file inside the index dir - the product's own record of what the
 * index holds (the engine ignores foreign files in its catalog root). */
export const MANIFEST_NAME = "codecontext.json";

/** Resolve the repo root a command operates on. */
export function resolveRoot(path?: string): string {
  return resolve(path ?? process.env.CX_ROOT ?? process.cwd());
}

/** Index directory for a repo root (override with CX_INDEX_DIR). */
export function indexDir(root: string): string {
  return process.env.CX_INDEX_DIR ?? join(root, INDEX_DIR_NAME);
}

export interface IndexCaps {
  /** Max indexable files per repo. */
  maxFiles: number;
  /** Max size of a single file, in bytes. */
  maxFileBytes: number;
}

export const DEFAULT_CAPS: IndexCaps = {
  maxFiles: Number(process.env.CX_MAX_FILES ?? 20000),
  maxFileBytes: Number(process.env.CX_MAX_FILE_BYTES ?? 1024 * 1024),
};

/** Rows per engine append - each append is one atomic commit, so the table
 * becomes searchable as soon as the first batch lands. */
export const APPEND_BATCH = 512;

/** Chunks embedded per model call. */
export const EMBED_BATCH = 32;

/** IVF centroid count for the vector index. 1 = exact scan - perfect recall,
 * and at local-repo scale (tens of thousands of chunks) still milliseconds. */
export const N_CENT = 1;
