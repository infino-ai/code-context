// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The three retrieval doors, shared by the CLI and the MCP server:
//
//   find   - the grep door: every line containing an exact string, cited
//            path:line. Complete and unranked - "every place this appears"
//            is a different question from "the chunks most about it".
//   search - the finding door: one ranked pass fuses exact keyword matching
//            (BM25) with semantic similarity (vectors, RRF) once vectors are
//            ready; ranked keyword search until then. Hits carry chunk
//            content, so answers come straight from results.
//   sql    - the power door: read-only SQL over the index, built on the search
//            table functions (bm25_search / hybrid_search) composed with
//            GROUP BY, with {{name}} placeholders embedded server-side for the
//            vector functions.
//
// Each door runs against a LOCAL index (the in-process engine) or a HOSTED
// one (the platform client on the handle). The result objects are identical
// in both modes - the model never learns where the table lives - and what the
// hosted call cost goes to the usage ledger (hostedTelemetry), not into the
// result.

import { localDb, EMBEDDING_COLUMN, PLATFORM_EMBEDDER_PROVIDER, type IndexHandle } from "./context.js";
import { TABLE, DEFAULT_SEARCH_K, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "./config.js";
import type { Embedder } from "./embedder.js";
import type { Manifest } from "./manifest.js";
import type { HostedDb, RowRecord } from "./hosted.js";
import { analyzerOf, analyzerTokens, hasIndexableToken } from "./analyzer.js";

// The analyzer mirror is re-exported from the door that uses it: `find`
// decides what the index can look up with `analyzerOf(handle.manifest)`, and
// the analyzer is always named - there is no default, because which one a
// table has depends on where the table lives (see analyzer.ts).
export { analyzerOf, analyzerTokens };

/** The FTS-indexed column every door queries. */
const CONTENT_COLUMN = "content";

/** Whether the table's vector column is one the platform fills and queries
 * with its own model. Such a table takes query TEXT for its vector leg, never
 * a client vector, whatever embedder this process has configured. */
export function platformEmbedded(manifest: Manifest): boolean {
  return manifest.embedder?.provider === PLATFORM_EMBEDDER_PROVIDER;
}

/** Refuse to embed a query with a model other than the one the index was
 * built with: a same-dimension swap would return silently wrong vector
 * results. Shared by every path that embeds a query (search, sql). Nothing to
 * check for a platform-embedded table (its model is the platform's) or when
 * the index recorded no model. */
function checkQueryEmbedder(manifest: Manifest, embedder: Embedder): void {
  const indexed = manifest.embedder;
  if (platformEmbedded(manifest) || !indexed || indexed.model === embedder.model) return;
  throw new Error(
    `query embedder (${embedder.model}) does not match the index embedder (${indexed.model}) - ` +
      `set CX_EMBED_MODEL=${indexed.model} or re-run \`cx index\``,
  );
}

/** Set when the index omitted files over the cap - the index is incomplete, so
 * an absence in results is not proof of absence in the repo. */
export interface PartialIndex {
  filesSkipped: number;
  fileCap: number;
  note: string;
}

/** Build the partial-index marker from a manifest, or undefined when the whole
 * tree was indexed. Shared by search (below) and the SQL path (server-side),
 * so every query surfaces the same "results may be incomplete" signal. */
export function partialIndex(manifest: Manifest): PartialIndex | undefined {
  if (!manifest.truncatedFiles) return undefined;
  const cap = manifest.maxFiles ?? 0;
  return {
    filesSkipped: manifest.truncatedFiles,
    fileCap: cap,
    note:
      `${manifest.truncatedFiles} file(s) over the ${cap}-file cap were left out of the index, so ` +
      "results may be incomplete - a missing match is not proof it's absent. Raise CX_MAX_FILES " +
      "(CLI: --max-files) and re-index for full coverage.",
  };
}

/** JSON.stringify that survives the engine's bigint row values. */
export function jsonify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    pretty ? 2 : undefined,
  );
}

/** The ledger's record of what the hosted call behind a query cost: the round
 * trip of the answering request and the tokens the platform metered. Read
 * right after the query, while the client's last call is that query's.
 * Undefined for a local handle, so callers spread it into the usage entry
 * unconditionally. Ledger-only: the tool result stays the same in both modes. */
export function hostedTelemetry(handle: { hosted?: HostedDb }): { rttMs: number; readTokens?: number; writeTokens?: number } | undefined {
  const info = handle.hosted?.lastCall();
  if (!info) return undefined;
  return {
    rttMs: info.rttMs,
    ...(info.readTokens !== undefined ? { readTokens: info.readTokens } : {}),
    ...(info.writeTokens !== undefined ? { writeTokens: info.writeTokens } : {}),
  };
}

// --- search -----------------------------------------------------------------

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  lang: string;
  score: number;
  content: string;
  /** Definition name(s) in this chunk (e.g. "parseConfig"), when known. */
  symbol?: string;
  /** Set when content was capped - Read path:startLine-endLine for the rest. */
  truncated?: boolean;
}

/** Per-hit content cap: enough to answer "how does X work" from the hit
 * itself (a whole ~60-line chunk fits; only pathological chunks truncate). */
const HIT_CONTENT_CAP = 4000;

export interface SearchResult {
  query: string;
  /** "hybrid" once vectors are ready; "keyword" while they backfill. */
  ranking: "hybrid" | "keyword";
  hits: SearchHit[];
  note?: string;
  /** Present when the index omitted files over the cap - results may be incomplete. */
  partial?: PartialIndex;
}

const PROJECTION = ["path", "start_line", "end_line", "lang", "symbol", "content", "score"];

/** The vector leg of a search, or null for a keyword-only pass: the query
 * text itself for a platform-embedded table (the platform embeds it with the
 * column's model), the locally embedded vector when an embedder is at hand,
 * and nothing when there is no client-side embedder (--embed-provider
 * platform against a client-vector table) - no vector to fuse means the
 * search stays keyword-ranked. */
async function vectorLeg(manifest: Manifest, embedder: Embedder | null, query: string): Promise<number[] | { text: string } | null> {
  if (manifest.vectors !== "ready") return null;
  if (platformEmbedded(manifest)) return { text: query };
  if (!embedder) return null;
  checkQueryEmbedder(manifest, embedder);
  const [vector] = await embedder.embed([query]);
  return vector;
}

export async function search(
  handle: IndexHandle,
  embedder: Embedder | null,
  query: string,
  k = DEFAULT_SEARCH_K,
): Promise<SearchResult> {
  const leg = await vectorLeg(handle.manifest, embedder, query);
  const ranking: "hybrid" | "keyword" = leg ? "hybrid" : "keyword";
  let rows: Array<Record<string, unknown>>;
  if (handle.hosted) {
    rows = leg
      ? await handle.hosted.hybridSearch(TABLE, CONTENT_COLUMN, query, EMBEDDING_COLUMN, leg, k, { projection: PROJECTION })
      : await handle.hosted.bm25Search(TABLE, CONTENT_COLUMN, query, k, { projection: PROJECTION });
  } else {
    const table = localDb(handle).openTable(TABLE);
    if (leg && !Array.isArray(leg)) {
      // A local engine has no server-side model; only the platform can embed
      // query text. A local manifest never records the platform provider, so
      // this names a mixed-up sidecar rather than a reachable state.
      throw new Error(`${handle.target} is a local index but its manifest records a platform-embedded table - re-run \`cx index\``);
    }
    rows = leg
      ? table.hybridSearch(CONTENT_COLUMN, query, EMBEDDING_COLUMN, leg, k, { projection: PROJECTION })
      : table.bm25Search(CONTENT_COLUMN, query, k, { projection: PROJECTION });
  }
  return {
    query,
    ranking,
    hits: rows.map((r) => {
      const full = String(r.content);
      return {
        path: String(r.path),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        lang: String(r.lang ?? ""),
        score: Number(r.score),
        ...(r.symbol ? { symbol: String(r.symbol) } : {}),
        content: full.slice(0, HIT_CONTENT_CAP),
        ...(full.length > HIT_CONTENT_CAP ? { truncated: true } : {}),
      };
    }),
    ...(ranking === "keyword" && handle.manifest.vectors !== "ready"
      ? { note: "vectors not ready yet - keyword-ranked only (re-run `cx index` or wait for the vector stage to finish)" }
      : {}),
    ...(() => {
      const partial = partialIndex(handle.manifest);
      return partial ? { partial } : {};
    })(),
  };
}

// --- find -------------------------------------------------------------------
//
// Two steps. The index's token match narrows to the chunks that contain every
// token of the query - an inverted-list intersection, no scoring, no top-k -
// then the literal is verified line by line inside those chunks. The analyzer
// splits identifiers (`ascii_lower` indexes `parse_config` as `parse` and
// `config`), so the first step alone would over-match; the second makes every
// hit a real occurrence of the exact text, and grep's line-based,
// case-sensitive semantics fall out of it.
//
// The query goes to the engine as text, not pre-tokenized: the engine
// tokenizes it with the index's own analyzer, so the candidate set is exact
// for whichever analyzer the table has (a client mirror of the Unicode
// `standard` rules could drift, e.g. on CJK segmentation). The same text goes
// to a hosted table - the platform runs the same engine and tokenizes the
// query with the table's index. What the client does strip is the engine's
// *query grammar* - see plainTerms below.

export interface FindMatch {
  path: string;
  /** 1-based line number of the matching line. */
  line: number;
  /** The matching line; a line longer than FIND_LINE_CAP is cut to a window
   * around the match, with `...` marking each cut end. */
  text: string;
  /** Definition name(s) of the enclosing chunk (e.g. "parseConfig"), when known. */
  symbol?: string;
}

/** Matching lines in one file - the `grep -c` view. */
export interface FindFileCount {
  path: string;
  count: number;
}

export interface FindResult {
  query: string;
  ignoreCase: boolean;
  /** Matching lines in path then line order, cut at the limit. */
  matches: FindMatch[];
  /** Matching lines across the repo before the limit was applied. */
  total: number;
  /** Distinct files with at least one match, before the limit. */
  files: number;
  /** Matching lines per file, before the limit, most matches first. Always
   * complete even when `matches` is cut, so "how many and where" never needs a
   * second call. */
  byFile: FindFileCount[];
  /** Set when `total` exceeded the limit and `matches` was cut. */
  truncated?: boolean;
  /** Present when the index omitted files over the cap - results may be incomplete. */
  partial?: PartialIndex;
}

export interface FindOptions {
  /** Match regardless of letter case. Default false: case-sensitive, like grep. */
  ignoreCase?: boolean;
  /** Maximum matches returned: a positive integer, clamped to MAX_FIND_LIMIT. */
  limit?: number;
}

/** Per-line cap so one minified or generated line cannot flood the result. */
const FIND_LINE_CAP = 240;

/** Characters kept ahead of the match when a long line is cut to a window, so
 * the excerpt shows what leads into the match rather than starting on it. */
const FIND_EXCERPT_LEAD = 60;

/** Columns a local find reads from its candidate chunks: no `end_line` (each
 * match cites its own line) and no `score` (there is none - matches are
 * unranked). */
const FIND_PROJECTION = ["path", "start_line", "symbol", "content"];

/** Columns a hosted find asks the platform to return beside each line: the
 * ones that place it. The line itself comes back as the excerpt; `content`
 * is never shipped. */
const HOSTED_FIND_PROJECTION = ["path", "start_line", "symbol"];

/** The column a hosted find's per-group counts are grouped by: lines per file. */
const HOSTED_FIND_GROUP_BY = "path";

/** The characters the engine's FTS query parser reads as grammar rather than
 * text: a `+` or `-` leading a whitespace-delimited run marks a must / must-not
 * clause (`-C` would *exclude* chunks containing `c`; `--max-files` parses as
 * negation-only and errors), and `"` opens a phrase (whose adjacency check
 * fails across a token the analyzer drops). A find query is a literal, never
 * a boolean expression, so every one of them becomes a space before the
 * engine sees the query. All three are separators under both analyzers
 * (hyphen splits words in UAX #29 too), so the tokens are unchanged. */
const QUERY_GRAMMAR_CHARS = /["+-]/g;

/** `query` with the engine's query-grammar characters blanked, so the engine
 * tokenizes it as bare terms with the index's analyzer and every term is a
 * required token (under `mode: "and"`). */
export function plainTerms(query: string): string {
  return query.replace(QUERY_GRAMMAR_CHARS, " ");
}

/** The lines of `content` (whose first line is 1-based `startLine`) that
 * contain `query` literally, each with its repo line number and the 0-based
 * column of the first occurrence. */
export function matchLines(
  content: string,
  startLine: number,
  query: string,
  ignoreCase: boolean,
): Array<{ line: number; text: string; at: number }> {
  const needle = ignoreCase ? query.toLowerCase() : query;
  const out: Array<{ line: number; text: string; at: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\r$/, "");
    const at = (ignoreCase ? text.toLowerCase() : text).indexOf(needle);
    if (at >= 0) out.push({ line: startLine + i, text, at });
  }
  return out;
}

/** `text` cut to at most FIND_LINE_CAP characters around the match at `at`
 * (of `needleLength` characters), with `...` on each end that was cut. A short
 * line comes back whole. The match always survives the cut: a hit whose text
 * did not contain the query would read as the tool being wrong. */
export function excerpt(text: string, at: number, needleLength: number): string {
  if (text.length <= FIND_LINE_CAP) return text;
  const lead = Math.min(FIND_EXCERPT_LEAD, Math.max(0, FIND_LINE_CAP - needleLength));
  const start = Math.max(0, Math.min(at - lead, text.length - FIND_LINE_CAP));
  const end = Math.min(text.length, start + FIND_LINE_CAP);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/** Async because a hosted candidate lookup is a network round trip; the
 * local engine call is synchronous underneath and a rejected validation
 * surfaces as a rejection either way. */
export async function find(handle: IndexHandle, query: string, opts: FindOptions = {}): Promise<FindResult> {
  if (query.length === 0) throw new Error("find needs a non-empty string to look for");
  if (/[\r\n]/.test(query)) {
    throw new Error("find matches within a single line - the query must not contain a newline");
  }
  const analyzer = analyzerOf(handle.manifest);
  if (!hasIndexableToken(query, analyzer)) {
    throw new Error(
      `find needs at least one word or number the index can look up, and its ${analyzer} analyzer keeps ` +
        "none from this query (only punctuation, or text it does not index) - try search, or sql with " +
        "regexp_like(content, ...)",
    );
  }
  // Reject rather than clamp a malformed limit: NaN would slice to nothing and
  // report nothing, which reads as "no matches".
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error(`limit must be a positive integer, got ${opts.limit}`);
  }
  const ignoreCase = opts.ignoreCase ?? false;
  const limit = Math.min(opts.limit ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
  const partial = partialIndex(handle.manifest);

  // Hosted: the platform's find does the whole job in the worker - the
  // candidate token match, the per-line literal check, the excerpts, the cap
  // and the per-file counts - so nothing but the matching lines crosses the
  // wire. Local: the same steps, here, over the candidate chunks.
  if (handle.hosted) {
    const found = await handle.hosted.find(TABLE, CONTENT_COLUMN, query, {
      ignoreCase,
      projection: HOSTED_FIND_PROJECTION,
      groupBy: HOSTED_FIND_GROUP_BY,
      limit,
    });
    return { query, ignoreCase, ...hostedFindResult(found), ...(partial ? { partial } : {}) };
  }

  const terms = plainTerms(query);
  const candidates = localDb(handle).openTable(TABLE).tokenMatch(CONTENT_COLUMN, terms, { mode: "and", projection: FIND_PROJECTION });

  // Fixed-window chunks overlap, so one line can arrive in two chunks; key by path:line.
  const seen = new Set<string>();
  const all: FindMatch[] = [];
  for (const row of candidates) {
    const path = String(row.path);
    const symbol = row.symbol ? String(row.symbol) : undefined;
    for (const m of matchLines(String(row.content), Number(row.start_line), query, ignoreCase)) {
      const key = `${path} ${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        path,
        line: m.line,
        text: excerpt(m.text, m.at, query.length),
        ...(symbol ? { symbol } : {}),
      });
    }
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  // Per-file counts over every match, not the cut list: `grep -c` in one call.
  const counts = new Map<string, number>();
  for (const m of all) counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
  const byFile: FindFileCount[] = [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    query,
    ignoreCase,
    matches: all.slice(0, limit),
    total: all.length,
    files: byFile.length,
    byFile,
    ...(all.length > limit ? { truncated: true } : {}),
    ...(partial ? { partial } : {}),
  };
}

/** The platform's find response in the local result's shape. A line arrives
 * with its projected columns and its index within the chunk's text, so its
 * repo line is `start_line + line_index`; the per-group counts are complete
 * (counted before the limit) and already ordered most lines first, and
 * `groups_total` is the number of files whether or not the groups list was
 * cut. A line whose placing columns are missing or malformed is dropped
 * rather than cited wrongly. */
export function hostedFindResult(found: RowRecord): Pick<FindResult, "matches" | "total" | "files" | "byFile" | "truncated"> {
  const matches: FindMatch[] = [];
  for (const raw of Array.isArray(found.lines) ? found.lines : []) {
    const line = asRecord(raw);
    const columns = asRecord(line.columns);
    const path = columns.path;
    const startLine = Number(columns.start_line);
    const index = Number(line.line_index);
    if (typeof path !== "string" || !Number.isFinite(startLine) || !Number.isFinite(index) || typeof line.line !== "string") continue;
    const symbol = typeof columns.symbol === "string" && columns.symbol !== "" ? columns.symbol : undefined;
    matches.push({ path, line: startLine + index, text: line.line, ...(symbol ? { symbol } : {}) });
  }
  const byFile: FindFileCount[] = [];
  for (const raw of Array.isArray(found.groups) ? found.groups : []) {
    const group = asRecord(raw);
    const count = Number(group.lines);
    if (typeof group.value !== "string" || !Number.isFinite(count)) continue;
    byFile.push({ path: group.value, count });
  }
  const total = Number.isFinite(Number(found.total)) ? Number(found.total) : matches.length;
  const files = Number.isFinite(Number(found.groups_total)) ? Number(found.groups_total) : byFile.length;
  return { matches, total, files, byFile, ...(found.truncated === true ? { truncated: true } : {}) };
}

/** `value` as a record; anything else is empty. */
function asRecord(value: unknown): RowRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RowRecord) : {};
}

// --- sql --------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The platform's own query-vector placeholder, `{{q:"text"}}`: the name is
 * fixed to `q`, the text runs to the first `"}}`, and there is no escaping,
 * so a text containing either of these sequences cannot be expressed. */
const PLATFORM_PLACEHOLDER_OPEN = '{{q:"';
const PLATFORM_PLACEHOLDER_CLOSE = '"}}';
const PLATFORM_PLACEHOLDER_UNESCAPABLE = ["}}", '"'];

/** The distinct `{{name}}` placeholders a statement references, in order. */
function placeholderNames(sql: string): string[] {
  const referenced = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER)) referenced.add(m[1]);
  return [...referenced];
}

/** The embed text for one placeholder; a referenced placeholder with no
 * supplied text is a hard error, in both substitution forms. */
function embedTextFor(name: string, embeds: Record<string, string>): string {
  const text = embeds[name];
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`no 'embed' text supplied for placeholder {{${name}}}`);
  }
  return text;
}

const noEmbedMap = (names: string[]): Error =>
  new Error(`query has placeholder(s) {{${names.join("}}, {{")}}} but no 'embed' map was provided`);

/** Substitute `{{name}}` placeholders with embedded query vectors, inlined as
 * comma-separated float literals - this is what lets the vector_search /
 * hybrid_search table functions run from SQL (the engine itself never
 * embeds). The injected values are model floats, so there is no injection
 * surface; a referenced placeholder with no supplied text is a hard error. */
export async function applyEmbeds(
  sql: string,
  embeds: Record<string, string> | undefined,
  embedder: Embedder | null,
): Promise<string> {
  const referenced = placeholderNames(sql);
  if (referenced.length === 0) return sql;
  if (!embeds) throw noEmbedMap(referenced);
  if (!embedder) {
    throw new Error(
      `query has placeholder(s) {{${referenced.join("}}, {{")}}} but no client-side embedder is configured (--embed-providerplatform)`,
    );
  }
  const literals = new Map<string, string>();
  for (const name of referenced) {
    const [vec] = await embedder.embed([embedTextFor(name, embeds)]);
    literals.set(name, `'${vec.join(",")}'`);
  }
  return sql.replace(PLACEHOLDER, (full, name) => literals.get(name) ?? full);
}

/** Substitute `{{name}}` placeholders with the platform's own `{{q:"text"}}`
 * placeholder, which the platform embeds with the table's model before the
 * statement runs - the form a platform-embedded table needs, since no client
 * vector matches its column. The name is always `q` on the platform side;
 * code-context's names only pick the text. A text the platform's syntax
 * cannot carry (it holds `}}` or a double quote - there is no escaping) is
 * refused rather than truncated into a different query. */
export function applyPlatformEmbeds(sql: string, embeds: Record<string, string> | undefined): string {
  const referenced = placeholderNames(sql);
  if (referenced.length === 0) return sql;
  if (!embeds) throw noEmbedMap(referenced);
  const literals = new Map<string, string>();
  for (const name of referenced) {
    const text = embedTextFor(name, embeds);
    const bad = PLATFORM_PLACEHOLDER_UNESCAPABLE.find((seq) => text.includes(seq));
    if (bad !== undefined) {
      throw new Error(
        `embed text for {{${name}}} contains ${JSON.stringify(bad)}, which the platform's {{q:"..."}} placeholder cannot carry (it has no escaping) - reword the text`,
      );
    }
    literals.set(name, `${PLATFORM_PLACEHOLDER_OPEN}${text}${PLATFORM_PLACEHOLDER_CLOSE}`);
  }
  return sql.replace(PLACEHOLDER, (full, name) => literals.get(name) ?? full);
}

/** Read-only guard: one statement, must be SELECT/WITH. The index is a
 * derived artifact - mutating it through SQL is never useful; re-index instead. */
export function guardSql(sql: string): string {
  const stripped = sql.trim().replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("only a single statement is allowed");
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error("only read-only SELECT / WITH queries are allowed (the index is rebuilt by `cx index`, not mutated through SQL)");
  }
  return stripped;
}

export async function runSql(
  handle: IndexHandle,
  embedder: Embedder | null,
  sql: string,
  embeds?: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  // Guard before substituting: the embed text is never part of the statement
  // the guard reads (a `;` inside a platform placeholder's text is the
  // platform's to embed, not a second statement), and floats carry nothing
  // the guard cares about either way.
  const guarded = guardSql(sql);
  let statement: string;
  if (handle.hosted && platformEmbedded(handle.manifest)) {
    statement = applyPlatformEmbeds(guarded, embeds);
  } else {
    // The mismatch guard applies to every path that embeds a query, not just
    // `search` - a same-dimension model swap would otherwise return silently
    // wrong vector_search/hybrid_search results through SQL.
    if (embedder && placeholderNames(guarded).length > 0) checkQueryEmbedder(handle.manifest, embedder);
    statement = await applyEmbeds(guarded, embeds, embedder);
  }
  return handle.hosted
    ? handle.hosted.querySql(statement)
    : (localDb(handle).querySql(statement) as Array<Record<string, unknown>>);
}
