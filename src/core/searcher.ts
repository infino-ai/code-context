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
// Every door runs against the LOCAL index (the in-process engine on the
// handle). The platform table the `ask` and `explore` tools read is the
// same index in another place; these doors never reach for it. What a
// platform call cost goes to the usage ledger (hostedTelemetry), not into a
// result.

import { localDb, EMBEDDING_COLUMN, type IndexHandle } from "./context.js";
import { TABLE, DEFAULT_SEARCH_K, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "./config.js";
import type { Embedder } from "./embedder.js";
import type { Manifest } from "./manifest.js";
import type { HostedDb } from "./hosted.js";
import { analyzerOf, analyzerTokens, hasIndexableToken } from "./analyzer.js";

// The analyzer mirror is re-exported from the door that uses it: `find`
// decides what the index can look up with `analyzerOf(handle.manifest)`, and
// the analyzer is always named - there is no default, because which one a
// table has depends on where the table lives (see analyzer.ts).
export { analyzerOf, analyzerTokens };

/** The FTS-indexed column every door queries. */
export const CONTENT_COLUMN = "content";

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

/** The ledger's record of what the platform call behind an `ask` or
 * `explore` result cost: the round trip of the answering request and the
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

/** `text` as a SQL string literal: single-quoted, with each quote doubled -
 * the engine's own quoting, and the platform's (`sql_literal`). */
export function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

// --- statements -------------------------------------------------------------
//
// A search or a find is not written as SQL by the caller, but the platform's
// retrieval contract reads the statement that produced a result to tell an
// aggregate from a row-returning query (and never for its literals). These
// render each call the way the platform's own answering loop names the same
// call beside its rows - `hybrid_search(...)`, `bm25_search(...)`, `find(...)`
// - so the verdict on a client search is the verdict the loop would reach on
// its own.

/** The statement a `search` ran as, in the loop's own shape for the same call. */
export function searchStatement(query: string, k: number, ranking: "hybrid" | "keyword"): string {
  const projection = PROJECTION.join(", ");
  return ranking === "hybrid"
    ? `SELECT ${projection} FROM hybrid_search(${sqlLiteral(TABLE)}, ${sqlLiteral(CONTENT_COLUMN)}, ${sqlLiteral(query)}, ${sqlLiteral(EMBEDDING_COLUMN)}, {{q}}, ${k})`
    : `SELECT ${projection} FROM bm25_search(${sqlLiteral(TABLE)}, ${sqlLiteral(CONTENT_COLUMN)}, ${sqlLiteral(query)}, ${k})`;
}

/** The statement a `find` ran as: `find(<table>, <column>, <literal>)`, the
 * loop's own name for a line-grain literal search, which its contract never
 * reads as an aggregate whatever the literal says. */
export function findStatement(query: string): string {
  return `find(${sqlLiteral(TABLE)}, ${sqlLiteral(CONTENT_COLUMN)}, ${sqlLiteral(query)})`;
}

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

/** Async so a rejected validation surfaces as a rejection like every other
 * door's; the engine call underneath is synchronous. */
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

  const terms = plainTerms(query);
  const candidates = localDb(handle).openTable(TABLE).tokenMatch(CONTENT_COLUMN, terms, { mode: "and", projection: FIND_PROJECTION });

  // Fixed-window chunks overlap, so one line can arrive in two chunks; key by path:line.
  const seen = new Set<string>();
  const all: FindMatch[] = [];
  // A line in a chunk that declares the query is kept even when the same line
  // arrives again from an overlapping chunk that does not, so the declaring
  // chunk always wins the dedupe rather than whichever chunk came first.
  const declaring = new Set<string>();
  // A prefix with no trailing slash still means "this directory", so `src` and
  // `src/` both scope to the subtree rather than also matching `src-gen/`. A
  // prefix naming a single file is left as given.
  const under = opts.under?.replace(/\/+$/, "");
  for (const row of candidates) {
    const path = String(row.path);
    if (under !== undefined && under !== "" && path !== under && !path.startsWith(`${under}/`)) continue;
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
    ...(under !== undefined && under !== "" ? { under } : {}),
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
