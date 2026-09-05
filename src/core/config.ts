// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Paths, tuning constants, and the hosted settings shared by the CLI and MCP server.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHostedUrl, DEFAULT_TIMEOUT_MS, DEFAULT_COLD_START_SECS, type HostedTarget } from "./hosted.js";
import { HOSTED_DEFAULT_ANALYZER, isAnalyzer, type Analyzer } from "./analyzer.js";

/** Directory name of the on-disk index, created in the repo root: the local
 * catalog, the two manifests, the file state, the usage ledger and build
 * spills. */
export const INDEX_DIR_NAME = ".infino";

// --- the platform database -----------------------------------------------------------
//
// A platform database (--db <url>) holds the same repository's chunks table
// beside the local index, reached over HTTPS: every build and sync writes
// both, and the `subagent` and `explore` tools read it. Its settings are
// command-line flags: the CLI parses them once into a HostedSettings
// (hostedSettingsFromFlags) and installs it with configureHosted(); every
// layer below reads that object through the accessor functions. Nothing here
// reads the environment except the API key, the one value that must never be
// an argument - argv is visible to every process on the machine - so it comes
// from a file named by --api-key-file, or from INFINO_API_KEY.

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

/** Who fills the platform table's vectors: `platform` (its embedding column
 * is filled and queried server-side with the platform's own model) or `local`
 * (the in-process model's vectors, shipped with the rows). The default is
 * `platform` - point at a database and the whole system works with nothing
 * else set. The local index always embeds locally; this never applies to it. */
export type EmbedProvider = "local" | "platform";

/** The default provider for the platform table. */
export const DEFAULT_HOSTED_EMBED_PROVIDER: EmbedProvider = "platform";

export interface SubagentSettings {
  /** Turn cap for one loop (the platform lowers a value above its own cap). */
  maxTurns: number;
  /** Wall clock for one loop, in seconds (likewise capped server-side). */
  maxWallSecs: number;
  /** Facts asked for and kept per call (the platform caps a value above its own). */
  k: number;
  /** The `explore` tool's budget, registered beside `subagent`. */
  explore: ExploreSettings;
}

export interface ExploreSettings {
  /** Turn cap for one exploration; absent leaves the platform's own explore
   * budget in force (a request value can only lower it). */
  maxTurns?: number;
  /** Wall clock for one exploration, in seconds. */
  maxWallSecs: number;
}

/** Default wall clock for `explore`, in seconds: an exploration is many
 * retrieval turns plus the reading between them, so it gets several times a
 * retrieval's wall; the flag raises or lowers it. */
export const DEFAULT_EXPLORE_MAX_WALL_SECS = 300;

/** Everything the platform database is configured with, resolved and
 * validated once. */
export interface HostedSettings {
  target: HostedTarget;
  embedProvider: EmbedProvider;
  /** Per-request wall clock, in milliseconds. */
  timeoutMs: number;
  /** How long retryable "not ready yet" answers are re-issued before giving
   * up, in seconds. */
  coldStartSecs: number;
  /** The FTS analyzer the platform table's content index is created with. */
  analyzer: Analyzer;
  subagent: SubagentSettings;
}

/** The platform flags as commander parses them: camelCase of `--db`,
 * `--api-key-file`, `--embed-provider`, `--db-timeout-ms`, `--cold-start-secs`,
 * `--analyzer`, `--subagent-max-turns`, `--subagent-max-wall-secs`,
 * `--subagent-k`, `--explore-max-turns`, `--explore-max-wall-secs`. Every value
 * is the raw string; validation is here, in one place, so a bad value is an
 * error at startup and not on the first call. */
export interface HostedFlags {
  db?: string;
  apiKeyFile?: string;
  embedProvider?: string;
  dbTimeoutMs?: string;
  coldStartSecs?: string;
  analyzer?: string;
  subagentMaxTurns?: string;
  subagentMaxWallSecs?: string;
  subagentK?: string;
  exploreMaxTurns?: string;
  exploreMaxWallSecs?: string;
}

/** The flags that mean nothing without --db, by their command-line spelling. */
const HOSTED_ONLY_FLAGS: Array<[keyof HostedFlags, string]> = [
  ["apiKeyFile", "--api-key-file"],
  ["embedProvider", "--embed-provider"],
  ["dbTimeoutMs", "--db-timeout-ms"],
  ["coldStartSecs", "--cold-start-secs"],
  ["analyzer", "--analyzer"],
  ["subagentMaxTurns", "--subagent-max-turns"],
  ["subagentMaxWallSecs", "--subagent-max-wall-secs"],
  ["subagentK", "--subagent-k"],
  ["exploreMaxTurns", "--explore-max-turns"],
  ["exploreMaxWallSecs", "--explore-max-wall-secs"],
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

/** A positive-integer flag that has no default: absent when not given. */
function optionalPositiveIntFlag(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return positiveIntFlag(flag, raw, 0);
}

/** Resolve the platform settings from the command line, or null when --db was
 * not given (no platform database: the local index alone). Reads the key from
 * --api-key-file, else from INFINO_API_KEY in `env`; a database with neither
 * is refused here rather than failing on the first request. Any other platform
 * flag without --db is a usage error rather than a silently ignored option. */
export function hostedSettingsFromFlags(flags: HostedFlags, env: NodeJS.ProcessEnv = process.env): HostedSettings | null {
  if (flags.db === undefined || flags.db === "") {
    const stray = HOSTED_ONLY_FLAGS.find(([key]) => flags[key] !== undefined);
    if (stray) throw new Error(`${stray[1]} needs --db <url>: it configures the platform database`);
    return null;
  }
  const { baseUrl, database } = parseHostedUrl(flags.db);
  const apiKey = flags.apiKeyFile !== undefined ? readFileSync(flags.apiKeyFile, "utf8").trim() : (env[API_KEY_ENV] ?? "");
  if (apiKey.length === 0) {
    throw new Error(`--db needs a key: pass --api-key-file <path> or set ${API_KEY_ENV} - the platform is bearer-only`);
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
      maxTurns: positiveIntFlag("--subagent-max-turns", flags.subagentMaxTurns, DEFAULT_SUBAGENT_MAX_TURNS),
      maxWallSecs: positiveIntFlag("--subagent-max-wall-secs", flags.subagentMaxWallSecs, DEFAULT_SUBAGENT_MAX_WALL_SECS),
      k: positiveIntFlag("--subagent-k", flags.subagentK, DEFAULT_SUBAGENT_K),
      explore: {
        ...(optionalPositiveIntFlag("--explore-max-turns", flags.exploreMaxTurns) !== undefined
          ? { maxTurns: optionalPositiveIntFlag("--explore-max-turns", flags.exploreMaxTurns) }
          : {}),
        maxWallSecs: positiveIntFlag("--explore-max-wall-secs", flags.exploreMaxWallSecs, DEFAULT_EXPLORE_MAX_WALL_SECS),
      },
    },
  };
}

/** The process-wide platform settings: installed once by the CLI at startup
 * (null when no --db was given), read by every layer through the accessors
 * below. There is no "hosted mode": the local index is always the one `find`,
 * `search` and `sql` read, and these settings name the platform database
 * that holds the same repository's chunks table for the `subagent` and
 * `explore` tools. Every build and every sync writes both, so the two are one
 * index in two places. */
let hosted: HostedSettings | null = null;

export function configureHosted(settings: HostedSettings | null): void {
  hosted = settings;
}

export function hostedSettings(): HostedSettings | null {
  return hosted;
}

/** Whether a platform database is configured (--db). */
export function isHosted(): boolean {
  return hosted !== null;
}

/** The platform target, or null when none is configured. The key travels only
 * inside the returned object; callers log `hostedLabel(target)`, never the
 * target. */
export function hostedTarget(): HostedTarget | null {
  return hosted?.target ?? null;
}

/** Who fills the platform table's embedding column: the --embed-provider
 * setting, `platform` by default. The local index always embeds with the
 * local model; this never applies to it. */
export function embedProvider(): EmbedProvider {
  return hosted?.embedProvider ?? DEFAULT_HOSTED_EMBED_PROVIDER;
}

/** The loggable name of a platform database: `https://host/<database>`, no key. */
export function hostedLabel(target: { baseUrl: string; database: string }): string {
  return `${target.baseUrl.replace(/\/+$/, "")}/${target.database}`;
}

/** The platform client's tuning, in the shape HostedOptions takes. */
export function hostedClientOptions(): { timeoutMs: number; coldStartSecs: number } {
  return {
    timeoutMs: hosted?.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS,
    coldStartSecs: hosted?.coldStartSecs ?? DEFAULT_DB_COLD_START_SECS,
  };
}

/** The analyzer the platform table's `content` index is created with: the
 * --analyzer flag, else HOSTED_DEFAULT_ANALYZER. Sent to the platform
 * explicitly and recorded in the platform manifest. */
export function hostedAnalyzer(): Analyzer {
  return hosted?.analyzer ?? HOSTED_DEFAULT_ANALYZER;
}

/** Whether the platform tools (`subagent`, `explore`) are registered: they
 * are whenever a platform database is configured, since that is what it is
 * for. */
export function subagentEnabled(): boolean {
  return hosted !== null;
}

export function subagentMaxTurns(): number {
  return hosted?.subagent.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
}

export function subagentMaxWallSecs(): number {
  return hosted?.subagent.maxWallSecs ?? DEFAULT_SUBAGENT_MAX_WALL_SECS;
}

/** Facts one subagent call asks for and keeps (--subagent-k). */
export function subagentK(): number {
  return hosted?.subagent.k ?? DEFAULT_SUBAGENT_K;
}

/** Turn cap for one exploration (--explore-max-turns), or undefined to
 * leave the platform's own explore budget in force. */
export function exploreMaxTurns(): number | undefined {
  return hosted?.subagent.explore.maxTurns;
}

export function exploreMaxWallSecs(): number {
  return hosted?.subagent.explore.maxWallSecs ?? DEFAULT_EXPLORE_MAX_WALL_SECS;
}

/** Whether a first query on an unindexed repo builds the index (CX_AUTO_INDEX,
 * default on). A build writes both the local index and, when a platform
 * database is configured, its chunks table: the two are one index in two
 * places and are never allowed to differ. */
export function autoIndexEnabled(): boolean {
  return !OFF_VALUES.includes((process.env.CX_AUTO_INDEX ?? "").toLowerCase());
}

/** Whether queries re-sync the index against the working tree (CX_AUTO_SYNC,
 * default on). A sync applies the same diff to the local index and to the
 * platform table when one is configured - deletes and appends to both at
 * once - so the two stay in step. */
export function autoSyncEnabled(): boolean {
  return !OFF_VALUES.includes((process.env.CX_AUTO_SYNC ?? "").toLowerCase());
}

/** The one table every tool reads. Stable across index stages: the staged
 * (keyword-only) build and the final (hybrid) build use the same name, so
 * SQL written against `chunks` keeps working as vectors arrive. */
export const TABLE = "chunks";

/** Manifest file inside the index dir - the product's own record of what the
 * local index holds (the engine ignores foreign files in its catalog root). */
export const MANIFEST_NAME = "codecontext.json";

/** The platform table's manifest, beside the local one in the same index
 * dir: what the chunks table on the configured database holds, as loaded
 * from this machine. Two files because the two tables share nothing but the
 * directory - a local rebuild must not read as a platform reload. */
export const PLATFORM_MANIFEST_NAME = "platform.json";

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

/** Default number of facts one `subagent` call asks for and returns: as many
 * as a search returns, so a subagent result costs the outer agent what a
 * search does. The platform retrieves and ranks more than this before
 * answering; `hitsTotal` says what was cut. */
export const DEFAULT_SUBAGENT_K = DEFAULT_SEARCH_K;

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
