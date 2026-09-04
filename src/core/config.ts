// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Paths, tuning constants, and the hosted settings shared by the CLI and MCP server.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHostedUrl, DEFAULT_TIMEOUT_MS, DEFAULT_COLD_START_SECS, type HostedTarget } from "./hosted.js";
import { HOSTED_DEFAULT_ANALYZER, isAnalyzer, type Analyzer } from "./analyzer.js";

/** Directory name of the on-disk index, created in the repo root. In hosted
 * mode the same directory is the local SIDECAR: the manifest, the file state,
 * the usage ledger and build spills live here while the chunks table itself
 * lives on the platform. */
export const INDEX_DIR_NAME = ".infino";

// --- hosted mode -----------------------------------------------------------------
//
// A hosted target moves the chunks table from the in-process engine to an
// Infino platform database reached over HTTPS. Its settings are command-line
// flags: the CLI parses them once into a HostedSettings (hostedSettingsFromFlags)
// and installs it with configureHosted(); every layer below reads that object
// through the accessor functions. Nothing here reads the environment except
// the API key, the one value that must never be an argument - argv is visible
// to every process on the machine - so it comes from a file named by
// --api-key-file, or from INFINO_API_KEY.

/** The environment variable holding the bearer key when --api-key-file is not
 * given. The engine's remote binding, the ask harness and the platform all
 * read this one name, so code-context does too. It is only ever read into a
 * HostedTarget - never logged or echoed. */
export const API_KEY_ENV = "INFINO_API_KEY";

/** Default per-request timeout: the client's own default, so the two cannot
 * drift apart (the rationale lives with it). */
export const DEFAULT_DB_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Default cold-start budget: likewise the client's own default. */
export const DEFAULT_DB_COLD_START_SECS = DEFAULT_COLD_START_SECS;

/** Default turn cap for `subagent`: a few search turns and a statement.
 * Measured against 8: half the inner tokens per call and a much shorter tail
 * for the same rate of empty results - the outer agent, not the inner loop,
 * decides how far to go. */
export const DEFAULT_SUBAGENT_MAX_TURNS = 4;

/** Default wall clock for `subagent`, in seconds. */
export const DEFAULT_SUBAGENT_MAX_WALL_SECS = 120;

/** Spellings that turn a boolean env flag off (`CX_AUTO_INDEX=0`, ...). */
const OFF_VALUES = ["0", "false", "no"];

/** Who embeds a hosted table: `platform` (the table's embedding field is filled
 * and queried server-side; no model runs on this machine) or `local` (the
 * in-process model, whose vectors are shipped). A hosted target defaults to
 * `platform` - point at a database and the whole system works with nothing
 * else set - and a local index can only be `local`. */
export type EmbedProvider = "local" | "platform";

/** The default provider for a hosted target. */
export const DEFAULT_HOSTED_EMBED_PROVIDER: EmbedProvider = "platform";

export interface SubagentSettings {
  /** Whether the MCP server registers the tool. Off unless asked: every tool
   * in the list is prompt text on every turn. */
  enabled: boolean;
  /** Turn cap for one loop (the platform lowers a value above its own cap). */
  maxTurns: number;
  /** Wall clock for one loop, in seconds (likewise capped server-side). */
  maxWallSecs: number;
}

/** Everything hosted mode is configured with, resolved and validated once. */
export interface HostedSettings {
  target: HostedTarget;
  embedProvider: EmbedProvider;
  /** Per-request wall clock, in milliseconds. */
  timeoutMs: number;
  /** How long retryable "not ready yet" answers are re-issued before giving
   * up, in seconds. */
  coldStartSecs: number;
  /** The FTS analyzer `cx index --db` creates the content index with. */
  analyzer: Analyzer;
  subagent: SubagentSettings;
}

/** The hosted flags as commander parses them: camelCase of `--db`,
 * `--api-key-file`, `--embed-provider`, `--db-timeout-ms`, `--cold-start-secs`,
 * `--analyzer`, `--subagent`, `--subagent-max-turns`, `--subagent-max-wall-secs`.
 * Every value is the raw string (or the bare boolean); validation is here, in
 * one place, so a bad value is an error at startup and not on the first call. */
export interface HostedFlags {
  db?: string;
  apiKeyFile?: string;
  embedProvider?: string;
  dbTimeoutMs?: string;
  coldStartSecs?: string;
  analyzer?: string;
  subagent?: boolean;
  subagentMaxTurns?: string;
  subagentMaxWallSecs?: string;
}

/** The flags that mean nothing without --db, by their command-line spelling. */
const HOSTED_ONLY_FLAGS: Array<[keyof HostedFlags, string]> = [
  ["apiKeyFile", "--api-key-file"],
  ["embedProvider", "--embed-provider"],
  ["dbTimeoutMs", "--db-timeout-ms"],
  ["coldStartSecs", "--cold-start-secs"],
  ["analyzer", "--analyzer"],
  ["subagent", "--subagent"],
  ["subagentMaxTurns", "--subagent-max-turns"],
  ["subagentMaxWallSecs", "--subagent-max-wall-secs"],
];

/** A positive-integer flag value, or its default when the flag was not given.
 * A value that is not a positive integer is an error - a NaN timeout would
 * disable the timeout. */
function positiveIntFlag(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  return n;
}

/** Resolve the hosted settings from the command line, or null when --db was
 * not given (local mode). Reads the key from --api-key-file, else from
 * INFINO_API_KEY in `env`; a hosted target with neither is refused here rather
 * than failing on the first request. Any other hosted flag without --db is a
 * usage error rather than a silently ignored option. */
export function hostedSettingsFromFlags(flags: HostedFlags, env: NodeJS.ProcessEnv = process.env): HostedSettings | null {
  if (flags.db === undefined || flags.db === "") {
    const stray = HOSTED_ONLY_FLAGS.find(([key]) => flags[key] !== undefined && flags[key] !== false);
    if (stray) throw new Error(`${stray[1]} needs --db <url>: it configures the hosted database`);
    return null;
  }
  const { baseUrl, database } = parseHostedUrl(flags.db);
  const apiKey = flags.apiKeyFile !== undefined ? readFileSync(flags.apiKeyFile, "utf8").trim() : (env[API_KEY_ENV] ?? "");
  if (apiKey.length === 0) {
    throw new Error(`--db needs a key: pass --api-key-file <path> or set ${API_KEY_ENV} - the hosted engine is bearer-only`);
  }
  const providerRaw = (flags.embedProvider ?? DEFAULT_HOSTED_EMBED_PROVIDER).toLowerCase();
  if (providerRaw !== "local" && providerRaw !== "platform") {
    throw new Error(`--embed-provider must be "platform" or "local", got "${flags.embedProvider}"`);
  }
  const analyzer = flags.analyzer ?? HOSTED_DEFAULT_ANALYZER;
  if (!isAnalyzer(analyzer)) throw new Error(`--analyzer must be "ascii_lower" or "standard", got "${flags.analyzer}"`);
  return {
    target: { baseUrl, database, apiKey },
    embedProvider: providerRaw,
    timeoutMs: positiveIntFlag("--db-timeout-ms", flags.dbTimeoutMs, DEFAULT_DB_TIMEOUT_MS),
    coldStartSecs: positiveIntFlag("--cold-start-secs", flags.coldStartSecs, DEFAULT_DB_COLD_START_SECS),
    analyzer,
    subagent: {
      enabled: flags.subagent === true,
      maxTurns: positiveIntFlag("--subagent-max-turns", flags.subagentMaxTurns, DEFAULT_SUBAGENT_MAX_TURNS),
      maxWallSecs: positiveIntFlag("--subagent-max-wall-secs", flags.subagentMaxWallSecs, DEFAULT_SUBAGENT_MAX_WALL_SECS),
    },
  };
}

/** The process-wide hosted settings: installed once by the CLI at startup
 * (null = local mode), read by every layer through the accessors below. */
let hosted: HostedSettings | null = null;

export function configureHosted(settings: HostedSettings | null): void {
  hosted = settings;
}

export function hostedSettings(): HostedSettings | null {
  return hosted;
}

/** Whether a hosted target is configured. */
export function isHosted(): boolean {
  return hosted !== null;
}

/** The hosted target, or null in local mode. The key travels only inside the
 * returned object; callers log `hostedLabel(target)`, never the target. */
export function hostedTarget(): HostedTarget | null {
  return hosted?.target ?? null;
}

/** The embedding provider: the hosted setting, or `local` for a local index
 * (the in-process engine has no server-side model). */
export function embedProvider(): EmbedProvider {
  return hosted?.embedProvider ?? "local";
}

/** The loggable name of a hosted target: `https://host/<database>`, no key. */
export function hostedLabel(target: { baseUrl: string; database: string }): string {
  return `${target.baseUrl.replace(/\/+$/, "")}/${target.database}`;
}

/** The hosted client's tuning, in the shape HostedOptions takes. */
export function hostedClientOptions(): { timeoutMs: number; coldStartSecs: number } {
  return {
    timeoutMs: hosted?.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS,
    coldStartSecs: hosted?.coldStartSecs ?? DEFAULT_DB_COLD_START_SECS,
  };
}

/** The analyzer a hosted load creates the `content` index with: the --analyzer
 * flag, else HOSTED_DEFAULT_ANALYZER. Sent to the platform explicitly and
 * recorded in the manifest, so queries mirror the right one. */
export function hostedAnalyzer(): Analyzer {
  return hosted?.analyzer ?? HOSTED_DEFAULT_ANALYZER;
}

/** Whether the hosted `subagent` tool is registered (--subagent). */
export function subagentEnabled(): boolean {
  return hosted?.subagent.enabled ?? false;
}

export function subagentMaxTurns(): number {
  return hosted?.subagent.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
}

export function subagentMaxWallSecs(): number {
  return hosted?.subagent.maxWallSecs ?? DEFAULT_SUBAGENT_MAX_WALL_SECS;
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
