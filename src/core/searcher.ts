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
// `find` runs against the LOCAL index (the in-process engine on the handle),
// and so do `search` and `sql` unless the MCP server is told otherwise. The
// platform table the `ask` tool reads is the same index in
// another place, and the doors reach for it in two cases: under
// CX_REMOTE_SEARCH the hosted table is the index, so `search` goes through
// `searchHosted` and every `sql` statement through `runSqlRows`; and a `sql`
// statement that embeds a query (`embedsAQuery`) goes through `runSqlRows`
// whenever a database is configured at all, because the platform embeds it
// with the table's own model and the local side is lexical. The row doors at
// the end of this file serve a hosted table of another shape. What a platform
// call cost goes to the usage ledger (hostedTelemetry), not into a result.

import { localDb, CONTENT_COLUMN, EMBEDDING_COLUMN, type IndexHandle } from "./context.js";
import { TABLE, DEFAULT_SEARCH_K, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "./config.js";
import type { Embedder } from "./embedder.js";
import type { Manifest } from "./manifest.js";
import type { HostedDb, RowRecord } from "./hosted.js";
import { analyzerOf, analyzerTokens, hasIndexableToken, PLATFORM_DEFAULT_ANALYZER, type Analyzer } from "./analyzer.js";
import { rowHit, sqlIdentifier, sqlLiteral, type TableShape } from "./table-shape.js";

// The analyzer mirror is re-exported from the door that uses it: `find`
// decides what the index can look up with `analyzerOf(handle.manifest)`, and
// the analyzer is always named - there is no default, because which one a
// table has depends on where the table lives (see analyzer.ts).
export { analyzerOf, analyzerTokens };

// The chunks table's text column lives with its vector column (context.ts);
// it is re-exported here because every door reaches for it as the searcher's.
export { CONTENT_COLUMN };

/** Refuse to embed a query with a model other than the one the index was
 * built with: a same-dimension swap would return silently wrong vector
 * results. Shared by every path that embeds a query (search, sql). Nothing to
 * check when the index recorded no model. */
function checkQueryEmbedder(manifest: Manifest, embedder: Embedder): void {
  const indexed = manifest.embedder;
  if (!indexed || indexed.model === embedder.model) return;
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

// The bigint-safe JSON.stringify lives in json.ts so the hosted client can
// share it without importing this module (and the local engine with it); it
// is re-exported here for the callers that always found it on the searcher.
export { jsonify } from "./json.js";

/** The ledger's record of what the platform call behind an `ask` result
 * cost: the round trip of the answering request and the
 * tokens the platform metered. Read right after the call, while the client's
 * last call is that one. Undefined when there is no platform client, so
 * callers spread it into the usage entry unconditionally. Ledger-only: never
 * part of a tool result. */
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

// A `search` and a `find` used to be rendered as the statement that produced
// them, so the platform's retrieval contract could judge their rows the way
// it judges the answering loop's. Measured 2026-09-11 and removed: the
// verdict on a ranked search cost quality (see VALIDATION_NOTE in the MCP
// server). `sql` sends the statement the caller actually wrote, so nothing
// renders one here any more.

/** One engine row as a hit. Shared by the local and the hosted search so the
 * two cannot drift: a caller must not be able to tell from the shape of a hit
 * which index answered, or a lane comparing them would be comparing the
 * mapping as well as the index. */
function toHit(r: Record<string, unknown>): SearchHit {
  const full = String(r.content);
  const startLine = Number(r.start_line);
  return {
    path: String(r.path),
    startLine,
    endLine: Number(r.end_line),
    lang: String(r.lang ?? ""),
    score: Number(r.score),
    ...(r.symbol ? { symbol: String(r.symbol) } : {}),
    // Cut first, then number: the cap is on the code, so the prefixes never
    // eat into how much of the chunk a hit carries, and a prefix can never
    // be cut in half. The kept text is a prefix of the chunk either way, so
    // its lines still run consecutively from the chunk's first line.
    content: numberLines(full.slice(0, HIT_CONTENT_CAP), startLine),
    ...(full.length > HIT_CONTENT_CAP ? { truncated: true } : {}),
  };
}

/** `search` against the HOSTED index: the platform fuses both legs and embeds
 * the query with the column's own model, so this needs no local index, no
 * embedder and no vectors.
 *
 * Always "hybrid": the hosted table's embedding column is filled by the
 * platform at ingest, so the vector leg is there by construction - there is no
 * backfill window to warn about the way the local path has.
 *
 * No `partial` either. That marker means the LOCAL index skipped files over
 * its size cap; what the hosted table holds was decided when it was loaded,
 * and this caller has no way to know it. Reporting the local index's
 * completeness beside hosted hits would be a claim about the wrong index. */
export async function searchHosted(
  hosted: { hybridSearch: (t: string, tf: string, vf: string, q: string, k: number, p: string[]) => Promise<Array<Record<string, unknown>>> },
  query: string,
  k = DEFAULT_SEARCH_K,
): Promise<SearchResult> {
  const rows = await hosted.hybridSearch(TABLE, CONTENT_COLUMN, EMBEDDING_COLUMN, query, k, PROJECTION);
  return { query, ranking: "hybrid", hits: rows.map(toHit) };
}

/** The vector leg of a search, or null for a keyword-only pass: the locally
 * embedded query when the index has vectors and an embedder is at hand;
 * nothing otherwise (no vector to fuse means the search stays
 * keyword-ranked). */
async function vectorLeg(manifest: Manifest, embedder: Embedder | null, query: string): Promise<number[] | null> {
  if (manifest.vectors !== "ready" || !embedder) return null;
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
  const table = localDb(handle).openTable(TABLE);
  const rows: Array<Record<string, unknown>> = leg
    ? table.hybridSearch(CONTENT_COLUMN, query, EMBEDDING_COLUMN, leg, k, { projection: PROJECTION })
    : table.bm25Search(CONTENT_COLUMN, query, k, { projection: PROJECTION });
  return {
    query,
    ranking,
    hits: rows.map(toHit),
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
// `standard` rules could drift, e.g. on CJK segmentation). What the client
// does strip is the engine's *query grammar* - see plainTerms below.

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
  /** Set when `defines` narrowed the result: how many matching lines there
   * were before the filter, so the caller can see what it skipped rather than
   * mistake a narrow answer for a rare name. Named as the platform route's
   * `defined_from`, which reports the same thing. */
  definedFrom?: number;
  /** Echoed when `under` scoped the result, so a caller reading the answer
   * knows the counts describe a subtree and not the repository. */
  under?: string;
}

export interface FindOptions {
  /** Match regardless of letter case. Default false: case-sensitive, like grep. */
  ignoreCase?: boolean;
  /** Maximum matches returned: a positive integer, clamped to MAX_FIND_LIMIT. */
  limit?: number;
  /** Keep only matches inside a chunk that *defines* the query - the handful
   * of places a name is declared, rather than every place it appears. See
   * `definesName` for exactly what that means and what it cannot see.
   *
   * Named as the platform route's `defines`, which answers the same question
   * over the same column. A boolean here and a column name there: this side
   * writes the index and knows the column, while the platform's find is
   * generic over any table and has to be told. */
  defines?: boolean;
  /** Keep only matches whose path starts with this prefix - one repository of
   * a workspace, one subtree of a monorepo, one branch's worktree.
   *
   * Exact, unlike the same idea on a ranked search: `find` retrieves every
   * candidate and cuts to the limit afterwards, so narrowing the candidates
   * loses nothing and `total`, `files` and `byFile` all describe the scoped
   * answer. A prefix filter over a top-k ranked search would instead drop hits
   * that ranked below the cutoff and report the remainder as the whole answer,
   * which is why `search` has no such option: a scoped RANKED search is `sql`
   * over a search relation, where the filter composes in the same pass. */
  under?: string;
}

/** Does this chunk's `symbol` column declare `name`?
 *
 * The column holds the definition names that START inside the chunk's span,
 * comma-joined by the chunker, so a match here means the chunk defines the
 * name rather than merely mentioning it. That is the distinction the `find`
 * text search cannot draw on its own: a use site, a doc comment and a
 * declaration are all just lines containing the word.
 *
 * Two things it deliberately does not do. It compares whole names, so `select`
 * does not match a chunk declaring `selection`. And it says the *chunk*
 * declares the name, not that the *matching line* is the declaration - the
 * line could be a recursive call inside the body it defines. Narrowing to the
 * declaring chunk is the useful part; pinning the statement would need the
 * per-line definition rows, which the index does not carry. */
export function definesName(symbolColumn: string | undefined, name: string, ignoreCase = false): boolean {
  if (!symbolColumn) return false;
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const wanted = fold(name.trim());
  if (wanted === "") return false;
  return symbolColumn
    .split(",")
    .map((s) => fold(s.trim()))
    .includes(wanted);
}

/** Per-line cap so one minified or generated line cannot flood the result. */
const FIND_LINE_CAP = 240;

/** Characters kept ahead of the match when a long line is cut to a window, so
 * the excerpt shows what leads into the match rather than starting on it. */
const FIND_EXCERPT_LEAD = 60;

/** Columns a find reads from its candidate chunks: no `end_line` (each match
 * cites its own line) and no `score` (there is none - matches are unranked). */
const FIND_PROJECTION = ["path", "start_line", "symbol", "content"];

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

/** What separates a line's number from the line, matching the platform's
 * renderer so a model reading rows from either side sees one format. */
const LINE_NUMBER_SEPARATOR = ": ";

/** `text` with each line prefixed by its own number in the file, counting
 * from 1-based `startLine` — `418: pub fn commit(` — the way a file reader
 * shows a file.
 *
 * A chunk's line range is wider than anything inside it, so a model handed
 * only the range has to count lines to cite one thing in it. The platform's
 * renderer numbers its rows for exactly this reason, and records what
 * happened when it did not: the residual after its range check was citations
 * that "overshoot or start in the wrong function", because a model cannot
 * count lines inside a block of text. Numbering costs a few characters a
 * line and no extra call — the rows are already in hand.
 *
 * Empty text stays empty: a row that carries a place and no text is a fact
 * whose citation is the whole of it, and numbering it would invent a line of
 * content that does not exist. */
export function numberLines(text: string, startLine: number): string {
  if (text === "") return "";
  return text
    .split("\n")
    .map((line, i) => `${startLine + i}${LINE_NUMBER_SEPARATOR}${line}`)
    .join("\n");
}

/** A column name that carries a row's first line, by the same rule the
 * platform's renderer uses: the name contains "start". */
const SPAN_START_MARK = "start";

/** `row` with every multi-line text cell numbered from the row's own line
 * span, when the row carries one. A row with no start-line column comes back
 * untouched: nothing places its text, so any number would be invented. Used
 * for arbitrary SQL rows, where the projection is the caller's choice — a
 * `SELECT path, content` cannot be numbered and must not be. */
export function numberRowLines(row: Record<string, unknown>): Record<string, unknown> {
  const starts = Object.entries(row)
    .filter(([name]) => name.toLowerCase().includes(SPAN_START_MARK))
    .map(([, cell]) => Number(cell))
    .filter((n) => Number.isInteger(n) && n >= 1);
  if (starts.length === 0) return row;
  const start = Math.min(...starts);
  const out: Record<string, unknown> = {};
  for (const [name, cell] of Object.entries(row)) {
    out[name] = typeof cell === "string" && cell.includes("\n") ? numberLines(cell, start) : cell;
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

/** An `under` prefix as the scope it names, or undefined when it names none.
 *
 * A prefix with no trailing slash still means "this directory", so `src` and
 * `src/` both scope to the subtree rather than also matching `src-gen/`. A
 * prefix naming a single file is left as given, and one that is empty once the
 * slashes come off scopes nothing at all.
 *
 * Exported because the platform tools take the same prefix and have to read it
 * the same way: `under` is one concept, and a second spelling of it there would
 * drift from this one the first time either side changed. */
export function normalizeUnder(under: string | undefined): string | undefined {
  const trimmed = under?.replace(/\/+$/, "");
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** What every find - over chunks or over rows - refuses before it asks the
 * index: an empty query, a query spanning lines, one the index's analyzer
 * keeps no token from (it would match nothing and read as "no occurrences"
 * rather than "cannot look this up"), and a malformed limit (rejected rather
 * than clamped: NaN would slice to nothing and report nothing, which reads as
 * "no matches"). Returns the limit to apply. `column` names the searched
 * column in the message's sql suggestion. */
function checkFindQuery(query: string, analyzer: Analyzer, column: string, limit: number | undefined): number {
  if (query.length === 0) throw new Error("find needs a non-empty string to look for");
  if (/[\r\n]/.test(query)) {
    throw new Error("find matches within a single line - the query must not contain a newline");
  }
  if (!hasIndexableToken(query, analyzer)) {
    throw new Error(
      `find needs at least one word or number the index can look up, and its ${analyzer} analyzer keeps ` +
        "none from this query (only punctuation, or text it does not index) - try search, or sql with " +
        `regexp_like(${column}, ...)`,
    );
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
}

/** Async so a rejected validation surfaces as a rejection like every other
 * door's; the engine call underneath is synchronous. */
export async function find(handle: IndexHandle, query: string, opts: FindOptions = {}): Promise<FindResult> {
  const limit = checkFindQuery(query, analyzerOf(handle.manifest), CONTENT_COLUMN, opts.limit);
  const ignoreCase = opts.ignoreCase ?? false;
  const partial = partialIndex(handle.manifest);

  const terms = plainTerms(query);
  const candidates = localDb(handle).openTable(TABLE).tokenMatch(CONTENT_COLUMN, terms, { mode: "and", projection: FIND_PROJECTION });

  // Fixed-window chunks overlap, so one line can arrive in two chunks; key by path:line.
  const seen = new Set<string>();
  const all: FindMatch[] = [];
  // A line in a chunk that declares the query is kept even when the same line
  // arrives again from an overlapping chunk that does not, so the declaring
  // chunk always wins the dedupe rather than whichever chunk came first.
  const declaring = new Set<string>();
  const under = normalizeUnder(opts.under);
  for (const row of candidates) {
    const path = String(row.path);
    if (under !== undefined && path !== under && !path.startsWith(`${under}/`)) continue;
    const symbol = row.symbol ? String(row.symbol) : undefined;
    const declares = definesName(symbol, query, ignoreCase);
    for (const m of matchLines(String(row.content), Number(row.start_line), query, ignoreCase)) {
      const key = `${path} ${m.line}`;
      if (declares) declaring.add(key);
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

  const matched = all.length;
  const rows = opts.defines ? all.filter((m) => declaring.has(`${m.path} ${m.line}`)) : all;

  // Per-file counts over every match, not the cut list: `grep -c` in one call.
  // Counted after the defines filter so the counts describe what was returned.
  const counts = new Map<string, number>();
  for (const m of rows) counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
  const byFile: FindFileCount[] = [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    query,
    ignoreCase,
    matches: rows.slice(0, limit),
    total: rows.length,
    files: byFile.length,
    byFile,
    ...(rows.length > limit ? { truncated: true } : {}),
    ...(partial ? { partial } : {}),
    ...(opts.defines ? { definedFrom: matched } : {}),
    ...(under !== undefined ? { under } : {}),
  };
}

// --- sql --------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The distinct `{{name}}` placeholders a statement references, in order. */
function placeholderNames(sql: string): string[] {
  const referenced = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER)) referenced.add(m[1]);
  return [...referenced];
}

/** Whether a statement embeds a query - carries a `{{name}}` placeholder,
 * which only the vector functions (vector_search, hybrid_search) take. The
 * MCP server reads this to send such a statement to the platform when a
 * database is configured: the query is embedded there with the table's own
 * model, and the local side stays lexical. */
export const embedsAQuery = (sql: string): boolean => placeholderNames(sql).length > 0;

/** The embed text for one placeholder; a referenced placeholder with no
 * supplied text is a hard error. */
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
    throw new Error(`query has placeholder(s) {{${referenced.join("}}, {{")}}} but no embedder is configured (CX_NO_EMBED)`);
  }
  const literals = new Map<string, string>();
  for (const name of referenced) {
    const [vec] = await embedder.embed([embedTextFor(name, embeds)]);
    literals.set(name, `'${vec.join(",")}'`);
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
  // the guard reads, and floats carry nothing the guard cares about.
  const guarded = guardSql(sql);
  // The mismatch guard applies to every path that embeds a query, not just
  // `search` - a same-dimension model swap would otherwise return silently
  // wrong vector_search/hybrid_search results through SQL.
  if (embedder && placeholderNames(guarded).length > 0) checkQueryEmbedder(handle.manifest, embedder);
  const statement = await applyEmbeds(guarded, embeds, embedder);
  return localDb(handle).querySql(statement) as Array<Record<string, unknown>>;
}

// --- rows: the doors over a hosted table of another shape --------------------
//
// With CX_REMOTE_SEARCH the hosted table is the index, and it need not be the
// chunks table this client builds: CX_TABLE can name a table hydrated from a
// data set - job postings, tickets - whose columns the doors' constants do not
// describe. These are the same three doors over such a table, driven by its
// TableShape (table-shape.ts): `search` fuses the table's own text and
// embedding columns on the platform, `find` is the token intersection over
// its text column through the engine's `token_match` relation, and `sql` runs
// on the platform, where the `{{q:"..."}}` placeholder is embedded with the
// table's own model. Hits are rows, not chunks: a score, the key, the scalar
// columns, and the text columns as snippets. Nothing here touches the local
// engine or the local index, which is the point - a local build would drop
// and recreate the platform table it was pointed at.

/** One row as a hit: `score`, the key, the scalars, the text as snippets
 * (see `rowHit`). */
export type RowHit = RowRecord;

export interface RowSearchResult {
  query: string;
  /** "hybrid" when the table has an embedding column; "keyword" when the
   * platform ranked by BM25 alone because there is none to fuse. */
  ranking: "hybrid" | "keyword";
  table: string;
  /** The column that names a row in `hits`. */
  key: string;
  hits: RowHit[];
}

/** `search` over the rows of a hosted table: the platform fuses BM25 over
 * the table's text column with the vector leg over its embedding column,
 * embedding the query with the column's own model, or ranks by BM25 alone
 * when the table has no embedding column. The projection is the table's
 * (every column but the vectors), so a hit carries the row. */
export async function searchRows(
  hosted: Pick<HostedDb, "hybridSearch" | "bm25Search">,
  shape: TableShape,
  query: string,
  k = DEFAULT_SEARCH_K,
): Promise<RowSearchResult> {
  if (shape.primaryText === "") throw new Error(`${shape.table} has no text column to search`);
  const rows = shape.vectorColumn
    ? await hosted.hybridSearch(shape.table, shape.primaryText, shape.vectorColumn, query, k, shape.projection)
    : await hosted.bm25Search(shape.table, shape.primaryText, query, k, shape.projection);
  return {
    query,
    ranking: shape.vectorColumn ? "hybrid" : "keyword",
    table: shape.table,
    key: shape.keyColumn,
    hits: rows.map((row) => rowHit(row, shape)),
  };
}

export interface RowFindResult {
  query: string;
  table: string;
  /** The text column every token of the query was matched in. */
  column: string;
  /** The column that names a row in `matches`. */
  key: string;
  /** Rows holding every token, as hits, cut at the limit. */
  matches: RowHit[];
  /** Rows holding every token across the table, before the limit. */
  total: number;
  /** Set when `total` exceeded the limit and `matches` was cut. */
  truncated?: boolean;
}

/** The alias the table-wide count travels under beside each row: a name no
 * schema carries, so stripping it from a match can never take a column of
 * the table's own with it (a table may well have a `total`). */
const FIND_TOTAL_COLUMN = "__cx_total";

/** The statement a row find runs: every column of the row (the shape's
 * rowColumns) for the rows whose text column holds every token of `terms`
 * (`token_match` in `and` mode - the engine's inverted-list intersection,
 * unranked and complete), cut at `limit`, with the count of all such rows
 * beside each one. `COUNT(*) OVER ()` runs over the whole relation before
 * the cut, so the total and the rows come from one snapshot and cost one
 * metered call rather than a second statement. No search `score`: a token
 * match has no rank. `terms` travels as a SQL string literal, quotes
 * doubled. */
export function findRowsSql(shape: TableShape, terms: string, limit: number): string {
  const projection = shape.rowColumns.map(sqlIdentifier).join(", ");
  return (
    `SELECT COUNT(*) OVER () AS ${FIND_TOTAL_COLUMN}, ${projection} ` +
    `FROM token_match(${sqlLiteral(shape.table)}, ${sqlLiteral(shape.primaryText)}, ${sqlLiteral(terms)}, 'and') ` +
    `LIMIT ${limit}`
  );
}

/** `find` over the rows of a hosted table: the rows whose text column holds
 * every token of `query`, matched by the index's own analyzer. Token
 * semantics, not grep's: a code chunk can be checked line by line for the
 * literal afterwards, but a row is one long text with no line to cite, so
 * the index's answer is the answer. The analyzer named in a refusal is the
 * platform's default for a bare column; both analyzers agree on whether a
 * query holds a token at all. */
export async function findRows(
  hosted: Pick<HostedDb, "querySql">,
  shape: TableShape,
  query: string,
  opts: { limit?: number } = {},
): Promise<RowFindResult> {
  if (shape.primaryText === "") throw new Error(`${shape.table} has no text column to match in`);
  const limit = checkFindQuery(query, PLATFORM_DEFAULT_ANALYZER, shape.primaryText, opts.limit);
  const rows = await hosted.querySql(findRowsSql(shape, plainTerms(query), limit));
  const total = rows.length > 0 ? Number(rows[0][FIND_TOTAL_COLUMN]) : 0;
  const matches = rows.map(({ [FIND_TOTAL_COLUMN]: _total, ...row }) => rowHit(row, shape));
  return {
    query,
    table: shape.table,
    column: shape.primaryText,
    key: shape.keyColumn,
    matches,
    total,
    ...(total > matches.length ? { truncated: true } : {}),
  };
}

/** The platform's own placeholder - `{{q:"text"}}`, the text embedded with
 * the table's model before the statement runs - is the only name it reads;
 * a `{{name}}` from the embed map is folded into it by text alone. */
const HOSTED_PLACEHOLDER_OPEN = '{{q:"';
const HOSTED_PLACEHOLDER_CLOSE = '"}}';

/** `sql` with every `{{name}}` placeholder the caller supplied embed text
 * for rewritten to the platform's inline `{{q:"text"}}`, which the platform
 * embeds server-side - there is no local embedder in this path, and none is
 * wanted: the table's column was embedded by the platform's model, and a
 * query vector from any other would rank against a space it does not belong
 * to. A placeholder already in the inline form has no `{{name}}` to match
 * and passes through untouched; a `{{name}}` with no text is the same error
 * as locally. The platform reads the text up to the first `"}}`, so a text
 * containing that sequence cannot be sent. */
export function foldEmbeds(sql: string, embeds: Record<string, string> | undefined): string {
  const referenced = placeholderNames(sql);
  if (referenced.length === 0) return sql;
  if (!embeds) throw noEmbedMap(referenced);
  return sql.replace(PLACEHOLDER, (full, name: string) => {
    const text = embedTextFor(name, embeds);
    if (text.includes(HOSTED_PLACEHOLDER_CLOSE)) {
      throw new Error(`the embed text for {{${name}}} contains ${HOSTED_PLACEHOLDER_CLOSE}, which ends the platform's placeholder`);
    }
    return `${HOSTED_PLACEHOLDER_OPEN}${text}${HOSTED_PLACEHOLDER_CLOSE}`;
  });
}

/** `sql` over the rows of a hosted table: the same read-only guard, then the
 * statement runs on the platform with its placeholders folded into the form
 * the platform embeds. */
export async function runSqlRows(
  hosted: Pick<HostedDb, "querySql">,
  sql: string,
  embeds?: Record<string, string>,
): Promise<RowRecord[]> {
  return hosted.querySql(foldEmbeds(guardSql(sql), embeds));
}
