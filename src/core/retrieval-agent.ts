// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The `ask` tool, registered when a platform database is configured: one
// question or task handed to the platform's retrieval loop over the index's
// platform copy (`POST /v1/sub_agent/{database}`), which answers
// with FACTS - the first k rows of the query that validated, and that query
// verbatim - and never with anything the model wrote. This file turns that
// response into the tool result and nothing more: the statement, and the
// fact rows - each that names a place in the code (path, start_line,
// end_line) as a search-shaped hit with whatever content the query selected,
// the rest as aggregate rows (counts, rankings) - with the platform's
// coverage of the result. Over a hosted table of another shape (the request
// carries its TableShape) every fact is a row instead, its text columns cut
// to snippets as a search hit's are. The loop's transcript is its own
// business and is never requested. The loop's spend (turns, tokens) travels
// beside the result to the usage ledger.

import type { HostedDb, RowRecord } from "./hosted.js";
import { DEFAULT_SEARCH_K } from "./config.js";
import { normalizeUnder, numberLines } from "./searcher.js";
import { rowFact, type TableShape } from "./table-shape.js";

/** Place-naming rows kept in one result: as many as a search returns by
 * default, so an ask result costs the outer agent what a search does.
 * Measured at 50: a result averaged 10.9k tokens, which is where the lane's
 * token bill went. The platform retrieves and ranks more than this before
 * answering; `hitsTotal` says what was cut. */
export const MAX_HITS = DEFAULT_SEARCH_K;

/** Aggregate rows (a count or rank per path) kept in one result: small rows,
 * so a longer list still costs less than a few hits - but a ranking past
 * fifty paths is a survey, not an answer. */
export const MAX_ROWS = 50;

/** Characters kept of a hit's content: search's own cap on a chunk, so a
 * ask hit reads exactly like a search hit. */
export const HIT_CONTENT_CHARS = 4000;

/** The platform's `terminate` value for a loop whose query validated
 * (serialized snake_case). */
export const TERMINATE_ANSWERED = "answered";

/** The platform's `terminate` value for a loop that tried its attempts and
 * validated no query; `error` then carries the model's account of why. */
export const TERMINATE_ESCALATED = "escalated";

/** The row columns a hit is built from: the chunks table's path and line
 * range, its text, and the two descriptors search hits also carry. */
const COL_PATH = "path";
const COL_START_LINE = "start_line";
const COL_END_LINE = "end_line";
const COL_CONTENT = "content";
const COL_SYMBOL = "symbol";
const COL_LANG = "lang";

/** The columns a search or find fact is asked to carry beside its text and
 * score when the request names none: the chunks table's - the ones that
 * place it in the code, so every fact can be cited, and the definitions the
 * row holds, so a citation can be checked against the definition it names
 * rather than the row's whole span. */
export const FACT_PROJECTION: readonly string[] = [COL_PATH, COL_START_LINE, COL_END_LINE, COL_SYMBOL];

/** Why a loop ended without facts, in the outer agent's terms: each maps a
 * platform `terminate` value to the reason. */
const NO_ANSWER_REASONS: Record<string, string> = {
  [TERMINATE_ESCALATED]: "the retrieval agent found no query that answers this",
  turn_cap: "the retrieval agent ran out of turns without an answer - the facts and chain are what it read before stopping",
  wall_cap: "the retrieval agent ran out of time without an answer - the facts and chain are what it read before stopping",
  error: "the retrieval agent's model endpoint failed",
};

/** What the outer agent is told when there are no facts. */
const NO_ANSWER_HINT = "ask again more narrowly, or use find or search";

export interface RetrievalAgentRequest {
  question: string;
  /** Repo-relative path prefix the question is about, read the way `find`
   * reads its own: one subtree of the index rather than all of it. Absent
   * asks about the whole repository. Reaches the loop inside `context` - see
   * `agentContext` for why, and for what that does and does not promise. */
  under?: string;
  /** Background the loop's model reads beside the question - the
   * repository's own instructions (see `devContext`) - and not part of what
   * a result must contain. Sent as the platform's `context` field. */
  context?: string;
  /** The columns a search or find fact carries beside its text and score,
   * for a caller who knows which columns place a row in its table. Absent,
   * the chunks table's (FACT_PROJECTION). Empty, none is sent and the
   * platform gives each fact its table's key columns, or the engine's row id
   * when it has none - the form for a table whose key is that id, since the
   * platform refuses a projection naming no column of any table. */
  projection?: readonly string[];
  /** The shape of the table the facts are rows of, when the doors run over
   * a hosted table of another shape. Every fact is then a row in `rows`,
   * never a hit - nothing places a row in code - rendered as a search hit
   * over that table is (`rowFact`): the key, the scalar columns, list cells
   * as they came, the text columns as snippets, and the statement's own
   * aliases. A job description runs to thousands of characters of HTML, and
   * ten of those whole per call cost more than the answer, exactly as they
   * would in a search. Absent, the chunks table's rule stands unchanged. */
  shape?: TableShape;
  /** The hosted table the question is about - the one this client reads
   * (`TABLE`). Sent as the platform's `table` field so the loop is shown that
   * table's card alone. Unlike `under`, this one IS a filter on the platform:
   * a database holding two code indexes and a jobs table answered every
   * question about the second index from the first until the loop was told
   * which table (2026-09-12). Absent, the loop sees every table's card. */
  table?: string;
}

/** The `projection` field of a sub_agent request for `request`: the caller's
 * columns, the chunks table's when it named none, and no field at all for
 * an empty list. */
function factProjection(request: RetrievalAgentRequest): { projection: string[] } | Record<string, never> {
  const columns = request.projection ?? FACT_PROJECTION;
  return columns.length > 0 ? { projection: [...columns] } : {};
}

/** `under` as the one sentence that tells the loop where to look. */
function scopeInstruction(under: string): string {
  return `Scope: answer only from files whose repo-relative path starts with \`${under}\` - ignore everything outside that prefix.`;
}

/** The `context` field of a sub_agent request for `request`: the caller's
 * background and the scope, whichever are there, and no field at all for
 * neither.
 *
 * This is where `under` becomes an INSTRUCTION rather than a filter. The
 * sub_agent request type rejects unknown keys and has no path field of any
 * kind, so free text beside the question is the only carrier a prefix has.
 * The loop is asked to hold to the prefix and nothing on the platform makes
 * it - a scoped call must not be read as a guarantee that every fact came
 * from inside the prefix, which is what the echoed `under` on the result is
 * for.
 *
 * The repository's own instructions and the scope are both background, so a
 * scoped call keeps the instructions rather than replacing them; the scope
 * goes last, where the shorter of the two is still read after a long
 * instruction file. */
function agentContext(request: RetrievalAgentRequest, under: string | undefined): { context: string } | Record<string, never> {
  const parts: string[] = [];
  if (request.context !== undefined) parts.push(request.context);
  if (under !== undefined) parts.push(scopeInstruction(under));
  return parts.length > 0 ? { context: parts.join("\n\n") } : {};
}

/** The result with `under` echoed on it when the call named a scope, the same
 * echo `find` makes: facts from a subtree must not read as the repository's. */
function scoped<T extends RetrievalAgentResult>(result: T, under: string | undefined): T {
  return under === undefined ? result : { ...result, under };
}

export interface RetrievalAgentBudget {
  /** Model turns the inner loop may take (the platform lowers a value above
   * its own cap); absent leaves the platform's budget in force. */
  maxTurns?: number;
  /** Wall clock for the inner loop, in seconds (likewise capped server-side). */
  maxWallSecs: number;
  /** Facts asked for, and the most hits kept in the result; MAX_HITS when absent. */
  k?: number;
}

/** One row of the table that names a place in the code: a search hit's
 * shape, so the outer agent cites it as path:line and answers from the
 * content when the statement selected it. */
export interface RetrievalAgentHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  symbol?: string;
  lang?: string;
}

/** How much of the query's result the platform returned: `facts` holds the
 * first k rows, and a caller wanting the rest runs the statement again with
 * LIMIT/OFFSET. */
export interface RetrievalAgentCoverage {
  rowsTotal: number;
  rowsReturned: number;
  truncated: boolean;
  /** True when the platform ranked the facts against the question before
   * returning the first k; absent when the query's own order stands. */
  ranked?: boolean;
}

/** What the `ask` tool returns to the outer agent: the facts. */
export interface RetrievalAgentResult {
  question: string;
  /** The query whose rows are the facts, verbatim (SQL, or a `find(...)`), when one validated. */
  sql?: string;
  /** How much of the query's result the platform returned. */
  coverage?: RetrievalAgentCoverage;
  /** The facts that name a place in the code, one per path:start_line, the first MAX_HITS. */
  hits: RetrievalAgentHit[];
  /** The other facts - aggregates such as a count or a rank per path, or rows
   * without the place columns - with their scalar columns as returned; the
   * first MAX_ROWS. Over a table of another shape (a request with a `shape`),
   * every fact, as `rowFact` renders it. */
  rows: RowRecord[];
  /** Distinct hits and rows among the facts before the caps. */
  hitsTotal: number;
  rowsTotal: number;
  turns: number;
  /** Present when the loop found no query that answers: why, in the platform's
   * words (on `escalated`, the model's own account of the problem). */
  error?: string;
  /** Present when the platform accepted the answer but its audit could not
   * run - the platform's account of why. The answer stands unaudited, and the
   * caller should weigh it knowing that. Absent when the audit ran. */
  unaudited?: string;
  /** Echoed when `under` scoped the question, so a caller reading the facts
   * knows they answer for a subtree and not the repository. */
  under?: string;
}

/** What the loop cost on the platform, for the usage ledger and receipt:
 * never part of the tool result. The platform reports one number per call,
 * `model_tokens` - the prompt and completion tokens of every model call the
 * loop made, together, the count the call is billed on - and nothing about
 * which models or how many calls. This is what lets a bill be checked
 * against the responses. */
export interface RetrievalAgentSpend {
  modelTokens: number;
}

/** One run: the tool result and, beside it, the spend. */
export interface RetrievalAgentRun {
  result: RetrievalAgentResult;
  spend: RetrievalAgentSpend;
}

/** The facts in a set of rows, split into hits and aggregate rows. */
export interface Facts {
  hits: RetrievalAgentHit[];
  rows: RowRecord[];
  hitsTotal: number;
  rowsTotal: number;
}

/** Hand the platform's retrieval loop one question over the hosted database
 * and return its facts. `k` asks for as many facts as a search returns by
 * default; the loop's own searches fetch more than that before validating.
 * Retryable platform states are handled inside the client; a terminal
 * failure (no agent configured, bad key) surfaces as its error. */
export async function runRetrievalAgent(
  hosted: Pick<HostedDb, "subAgent">,
  request: RetrievalAgentRequest,
  budget: RetrievalAgentBudget,
): Promise<RetrievalAgentRun> {
  const k = budget.k ?? MAX_HITS;
  const under = normalizeUnder(request.under);
  const response = await hosted.subAgent({
    question: request.question,
    ...agentContext(request, under),
    k,
    ...factProjection(request),
    ...(budget.maxTurns !== undefined ? { max_turns: budget.maxTurns } : {}),
    max_wall_secs: budget.maxWallSecs,
    ...(request.table !== undefined ? { table: request.table } : {}),
  });
  const run = retrievalAgentRunFrom(request.question, response, k, request.shape);
  return { ...run, result: scoped(run.result, under) };
}

/** The fact rows of a response: each entry of `facts` carries its row as a
 * record (and the table it came from, which the hits do not need). An entry
 * of another shape contributes nothing. */
export function factRowsOf(response: unknown): RowRecord[] {
  const facts = asRecord(response).facts;
  if (!Array.isArray(facts)) return [];
  const rows: RowRecord[] = [];
  for (const raw of facts) {
    const row = asRecord(raw).row;
    if (typeof row === "object" && row !== null && !Array.isArray(row)) rows.push(row as RowRecord);
  }
  return rows;
}

/** The response's coverage of the statement's result, when it carries one. */
function coverageOf(response: unknown): RetrievalAgentCoverage | undefined {
  const c = asRecord(asRecord(response).coverage);
  if (!isFiniteNumber(c.rows_total) || !isFiniteNumber(c.rows_returned)) return undefined;
  const coverage: RetrievalAgentCoverage = { rowsTotal: c.rows_total, rowsReturned: c.rows_returned, truncated: c.truncated === true };
  // The platform names what ranked the facts when it did; the client keeps
  // only that it happened.
  if (typeof c.ranker === "string" && c.ranker.length > 0) coverage.ranked = true;
  return coverage;
}

/** The run for one platform response. A loop that found no query is still a
 * result, not a tool error: `error` says why, and the outer agent decides
 * what to do next. A body that is not an agent response at all (no
 * `terminate`) is the one thing that throws. With a `shape` the facts are
 * rows of that table (see `RetrievalAgentRequest.shape`). */
export function retrievalAgentRunFrom(question: string, response: unknown, maxHits: number = MAX_HITS, shape?: TableShape): RetrievalAgentRun {
  const body = asRecord(response);
  if (typeof body.terminate !== "string") {
    throw new Error("ask: the platform's response is not an agent result (no `terminate` field)");
  }
  const terminate = body.terminate;
  const statement = typeof body.statement === "string" && body.statement.length > 0 ? body.statement : undefined;
  const coverage = coverageOf(body);
  const result: RetrievalAgentResult = {
    question,
    ...(statement ? { sql: statement } : {}),
    ...(coverage ? { coverage } : {}),
    ...factsFrom(factRowsOf(body), maxHits, shape),
    turns: numberField(body.turns),
  };
  if (terminate !== TERMINATE_ANSWERED) result.error = `${noAnswerMessage(terminate, body.error)} - ${NO_ANSWER_HINT}`;
  const unaudited = unauditedOf(body);
  if (unaudited) result.unaudited = unaudited;
  const spend: RetrievalAgentSpend = { modelTokens: numberField(body.model_tokens) };
  return { result, spend };
}

/** The platform's account of an audit that could not run, when the response
 * carries one: its `unaudited` field as a reason, or a bare `true` when it
 * gives none. Undefined means the audit ran, or the response predates the
 * field. */
function unauditedOf(body: Record<string, unknown>): string | undefined {
  const value = body.unaudited;
  if (typeof value === "string" && value.length > 0) return value;
  if (value === true) return "the platform did not say why";
  return undefined;
}

/** Why there are no facts: the platform's reason for the way the loop ended
 * and its words when it has them - the model's own account on `escalated`,
 * the endpoint's failure on `error`. */
function noAnswerMessage(terminate: string, detail: unknown): string {
  const reason = NO_ANSWER_REASONS[terminate] ?? `the retrieval agent ended with "${terminate}"`;
  const words = typeof detail === "string" && detail.length > 0 ? `: ${detail}` : "";
  return `${reason}${words}`;
}

/** The fact rows split, in order: every row that names a place in the code
 * (path + start_line + end_line) becomes a hit with its content, one per
 * path:start_line; every other row with a scalar column becomes an aggregate
 * row, one per distinct set of scalar cells. Both lists are capped - hits at
 * `maxHits` (the k the call asked for), rows at MAX_ROWS - and the totals
 * count what was seen. With a `shape` every fact is a row of that table
 * (`rowFact`: text as snippets, list cells kept, the statement's aliases
 * kept) and `hits` stays empty: a row of a hydrated table names no place in
 * code even where its columns happen to be called path and start_line. */
export function factsFrom(rows: unknown[], maxHits: number = MAX_HITS, shape?: TableShape): Facts {
  const hits: RetrievalAgentHit[] = [];
  const aggregates: RowRecord[] = [];
  const seenHits = new Set<string>();
  const seenRows = new Set<string>();
  const keepRow = (row: RowRecord) => {
    const key = JSON.stringify(row);
    if (seenRows.has(key)) return;
    seenRows.add(key);
    if (aggregates.length < MAX_ROWS) aggregates.push(row);
  };
  for (const raw of rows) {
    if (shape) {
      const row = rowFact(asRecord(raw), shape);
      if (Object.keys(row).length > 0) keepRow(row);
      continue;
    }
    const hit = hitFromRow(raw);
    if (hit) {
      const key = `${hit.path}:${hit.startLine}`;
      if (seenHits.has(key)) continue;
      seenHits.add(key);
      if (hits.length < maxHits) hits.push(hit);
      continue;
    }
    const row = scalarRow(raw);
    if (row !== null) keepRow(row);
  }
  return { hits, rows: aggregates, hitsTotal: seenHits.size, rowsTotal: seenRows.size };
}

/** A row as a hit, or null when it does not name a place in the code. The
 * content is cut at HIT_CONTENT_CHARS and numbered by line like a search
 * hit's — the two must stay the same shape, or a caller could tell an `ask`
 * fact from a `search` hit and would have to cite them differently; a row
 * with the place columns and no content is a hit with empty content (the
 * citation is the fact). */
function hitFromRow(raw: unknown): RetrievalAgentHit | null {
  const row = asRecord(raw);
  const path = row[COL_PATH];
  const startLine = row[COL_START_LINE];
  const endLine = row[COL_END_LINE];
  if (typeof path !== "string" || !isFiniteNumber(startLine) || !isFiniteNumber(endLine)) return null;
  const content =
    typeof row[COL_CONTENT] === "string"
      ? numberLines((row[COL_CONTENT] as string).slice(0, HIT_CONTENT_CHARS), startLine)
      : "";
  const hit: RetrievalAgentHit = { path, startLine, endLine, content };
  if (typeof row[COL_SYMBOL] === "string" && row[COL_SYMBOL] !== "") hit.symbol = row[COL_SYMBOL] as string;
  if (typeof row[COL_LANG] === "string" && row[COL_LANG] !== "") hit.lang = row[COL_LANG] as string;
  return hit;
}

/** The scalar cells of a row (vectors and nested objects dropped), or null
 * when nothing scalar is left. */
function scalarRow(raw: unknown): RowRecord | null {
  const row = asRecord(raw);
  const out: RowRecord = {};
  let any = false;
  for (const [name, value] of Object.entries(row)) {
    if (isScalar(value) || value === null) {
      out[name] = value;
      any = true;
    }
  }
  return any ? out : null;
}

/** `value` as a record; anything else (null, an array, a scalar) is empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A value that is a fact on its own: a string, number or boolean. */
const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** A numeric field, 0 when absent or not a finite number. */
function numberField(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}
