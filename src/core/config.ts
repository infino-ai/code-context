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

/** Character cap on the text handed to the embedding model per chunk. The
 * model truncates to its token window anyway (256 tokens for the default
 * MiniLM), so anything past a few thousand characters never influences the
 * vector - but it DOES size the tokenizer/ONNX arenas. Capping here bounds
 * arena growth on pathological inputs (minified bundles, single-line data
 * files) without changing retrieval. */
export const EMBED_MAX_CHARS = Number(process.env.CX_EMBED_MAX_CHARS ?? 8000);

/** Default number of search hits. Configurable per call (the `k` tool param /
 * CLI `-k`) and via CX_SEARCH_K for config/CI-level defaults. */
export const DEFAULT_SEARCH_K = Number(process.env.CX_SEARCH_K ?? 10);

/** How many of the top search hits carry their chunk content. Hits ranked
 * below this carry a one-line excerpt and their line range instead, so the
 * result stays citable at a fraction of the tokens and the caller Reads a
 * later hit only when the top ones did not answer. Set it at or above k (via
 * CX_SEARCH_FULL_HITS) to get content on every hit. */
export const SEARCH_FULL_HITS = Number(process.env.CX_SEARCH_FULL_HITS ?? 3);

/** Hard cap on matching lines in one `find` result. At roughly fifty tokens
 * per returned line (path, line number, text) this is about 25k tokens: a
 * large tool result, but one a session survives, where an unbounded find of
 * a ubiquitous term could return a hundred thousand lines. A cut list still
 * carries the full total and the per-file counts. */
export const MAX_FIND_LIMIT = 500;

/** Default number of matching lines `find` returns when the caller passes no
 * limit: the cap itself, so the cut only ever lands on a flood, never on a
 * real answer (the largest measured lookup needed about 300 lines). The
 * result's `total` and `byFile` are complete either way. Configurable per call
 * (the `limit` tool param / CLI `--limit`) and via CX_FIND_LIMIT. */
export const DEFAULT_FIND_LIMIT = Number(process.env.CX_FIND_LIMIT ?? MAX_FIND_LIMIT);
