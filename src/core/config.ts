// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Paths, environment, and tuning constants shared by the CLI and MCP server.

import { join, resolve } from "node:path";
import { parseHostedUrl, DEFAULT_TIMEOUT_MS, DEFAULT_COLD_START_SECS, type HostedTarget } from "./hosted.js";

/** Directory name of the on-disk index, created in the repo root. In hosted
 * mode the same directory is the local SIDECAR: the manifest, the file state,
 * the usage ledger and build spills live here while the chunks table itself
 * lives on the platform. */
export const INDEX_DIR_NAME = ".infino";

// --- hosted mode -----------------------------------------------------------------
//
// A hosted target moves the chunks table from the in-process engine to an
// Infino platform database reached over HTTPS. Everything below reads the
// environment at call time (not at module load) so the CLI's `--db` flag, which
// sets the same variable, is seen by every layer, and so tests can set and
// clear the variables between cases.

/** The hosted engine target: `https://host/<database>`. Plain `http://` is
 * accepted for a loopback host only (see parseHostedUrl). Unset = local mode. */
export const DB_URL_ENV = "CX_DB_URL";

/** The bearer key for the hosted target. The engine's remote binding, the
 * ask harness and the platform all read this one name, so code-context does
 * too. It is only ever read into a HostedTarget - never logged or echoed. */
export const API_KEY_ENV = "INFINO_API_KEY";

/** Who embeds: `local` (the in-process model, the default) or `platform`
 * (the table's embedding column is filled and queried server-side, and no
 * model runs on this machine). */
export const EMBED_PROVIDER_ENV = "CX_EMBED_PROVIDER";

/** Per-call wall clock for one hosted request, in milliseconds. */
export const DB_TIMEOUT_MS_ENV = "CX_DB_TIMEOUT_MS";

/** How long retryable "not yet" answers (a cold database whose worker is
 * spawning) are re-issued before giving up, in seconds. */
export const DB_COLD_START_SECS_ENV = "CX_DB_COLD_START_SECS";

/** Whether the MCP server registers the hosted `retrieval_agent` tool. Off by
 * default: every tool in the list is prompt text on every turn. */
export const RETRIEVAL_AGENT_ENV = "CX_RETRIEVAL_AGENT";

/** Turn cap for one hosted `retrieval_agent` loop. */
export const RETRIEVAL_AGENT_MAX_TURNS_ENV = "CX_RETRIEVAL_AGENT_MAX_TURNS";

/** Wall-clock cap for one hosted `retrieval_agent` loop, in seconds. */
export const RETRIEVAL_AGENT_MAX_WALL_SECS_ENV = "CX_RETRIEVAL_AGENT_MAX_WALL_SECS";

/** Default per-request timeout when CX_DB_TIMEOUT_MS is unset: the client's
 * own default, so the two cannot drift apart (the rationale lives with it). */
export const DEFAULT_DB_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Default cold-start budget when CX_DB_COLD_START_SECS is unset: likewise the
 * client's own default. */
export const DEFAULT_DB_COLD_START_SECS = DEFAULT_COLD_START_SECS;

/** Default turn cap for `retrieval_agent`: enough for card lookup, a few SQL
 * turns and an answer; more turns mostly buy cost. */
export const DEFAULT_RETRIEVAL_AGENT_MAX_TURNS = 8;

/** Default wall clock for `retrieval_agent`, in seconds. */
export const DEFAULT_RETRIEVAL_AGENT_MAX_WALL_SECS = 120;

/** Spellings that turn a boolean env flag off (`CX_AUTO_INDEX=0`, ...). */
const OFF_VALUES = ["0", "false", "no"];

/** Spellings that turn a default-off boolean env flag on (`CX_RETRIEVAL_AGENT=1`). */
const ON_VALUES = ["1", "true", "yes"];

export type EmbedProvider = "local" | "platform";

/** The embedding provider from CX_EMBED_PROVIDER; a misspelling is an error
 * rather than a silent fall back to the local model. */
export function embedProvider(): EmbedProvider {
  const raw = (process.env[EMBED_PROVIDER_ENV] ?? "local").toLowerCase();
  if (raw === "local" || raw === "platform") return raw;
  throw new Error(`${EMBED_PROVIDER_ENV} must be "local" or "platform", got "${raw}"`);
}

/** Whether a hosted target is configured (CX_DB_URL set and non-empty). */
export function isHosted(): boolean {
  return (process.env[DB_URL_ENV] ?? "").length > 0;
}

/** The hosted target from CX_DB_URL + INFINO_API_KEY, or null in local mode.
 * Throws on a malformed URL or a missing key: both would otherwise surface as
 * an opaque failure on the first request. The key travels only inside the
 * returned object; callers log `hostedLabel(target)`, never the target. */
export function hostedTarget(): HostedTarget | null {
  const url = process.env[DB_URL_ENV];
  if (!url) return null;
  const { baseUrl, database } = parseHostedUrl(url);
  const apiKey = process.env[API_KEY_ENV] ?? "";
  if (apiKey.length === 0) {
    throw new Error(`${DB_URL_ENV} is set but ${API_KEY_ENV} is not - the hosted engine is bearer-only`);
  }
  return { baseUrl, database, apiKey };
}

/** The loggable name of a hosted target: `https://host/<database>`, no key. */
export function hostedLabel(target: { baseUrl: string; database: string }): string {
  return `${target.baseUrl.replace(/\/+$/, "")}/${target.database}`;
}

/** A positive-integer env var, or its default when unset. A value that is not
 * a positive integer is an error - a NaN timeout would disable the timeout. */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** The hosted client's tuning from the environment (CX_DB_TIMEOUT_MS,
 * CX_DB_COLD_START_SECS), in the shape HostedOptions takes. */
export function hostedClientOptions(): { timeoutMs: number; coldStartSecs: number } {
  return {
    timeoutMs: positiveIntEnv(DB_TIMEOUT_MS_ENV, DEFAULT_DB_TIMEOUT_MS),
    coldStartSecs: positiveIntEnv(DB_COLD_START_SECS_ENV, DEFAULT_DB_COLD_START_SECS),
  };
}

/** Whether the hosted `retrieval_agent` tool is registered (CX_RETRIEVAL_AGENT,
 * default off). */
export function retrievalAgentEnabled(): boolean {
  return ON_VALUES.includes((process.env[RETRIEVAL_AGENT_ENV] ?? "").toLowerCase());
}

export function retrievalAgentMaxTurns(): number {
  return positiveIntEnv(RETRIEVAL_AGENT_MAX_TURNS_ENV, DEFAULT_RETRIEVAL_AGENT_MAX_TURNS);
}

export function retrievalAgentMaxWallSecs(): number {
  return positiveIntEnv(RETRIEVAL_AGENT_MAX_WALL_SECS_ENV, DEFAULT_RETRIEVAL_AGENT_MAX_WALL_SECS);
}

/** Whether a first query on an unindexed repo builds the index (CX_AUTO_INDEX,
 * default on). Always off for a hosted target: a first query must never drop
 * and recreate a table other people share. */
export function autoIndexEnabled(): boolean {
  return !isHosted() && !OFF_VALUES.includes((process.env.CX_AUTO_INDEX ?? "").toLowerCase());
}

/** Whether queries re-sync the index against the working tree (CX_AUTO_SYNC,
 * default on). Always off for a hosted target, for the same reason as
 * autoIndexEnabled: the shared table is loaded explicitly, never as a side
 * effect of a query. */
export function autoSyncEnabled(): boolean {
  return !isHosted() && !OFF_VALUES.includes((process.env.CX_AUTO_SYNC ?? "").toLowerCase());
}

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
