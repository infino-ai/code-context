// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The `subagent` tool, hosted mode only: one question or task handed to the
// platform's retrieval loop (`POST /v1/sub_agent/{database}`), which answers
// with FACTS - the first k rows of the query that validated, and that query
// verbatim - and never with anything the model wrote. This file turns that
// response into the tool result and nothing more: the statement, and the
// fact rows - each that names a place in the code (path, start_line,
// end_line) as a search-shaped hit with whatever content the query selected,
// the rest as aggregate rows (counts, rankings) - with the platform's
// coverage of the result. The loop's transcript is its own business and is
// never requested. The loop's spend (turns, tokens) travels beside the
// result to the usage ledger.

import type { HostedDb, RowRecord } from "./hosted.js";
import { DEFAULT_SEARCH_K } from "./config.js";

/** Place-naming rows kept in one result: as many as a search returns by
 * default, so a subagent result costs the outer agent what a search does.
 * Measured at 50: a result averaged 10.9k tokens, which is where the lane's
 * token bill went. The platform retrieves and ranks more than this before
 * answering; `hitsTotal` says what was cut. */
export const MAX_HITS = DEFAULT_SEARCH_K;

/** Aggregate rows (a count or rank per path) kept in one result: small rows,
 * so a longer list still costs less than a few hits - but a ranking past
 * fifty paths is a survey, not an answer. */
export const MAX_ROWS = 50;

/** Characters kept of a hit's content: search's own cap on a chunk, so a
 * subagent hit reads exactly like a search hit. */
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
 * score: the ones that place it in the code, so every fact can be cited. */
const FACT_PROJECTION = [COL_PATH, COL_START_LINE, COL_END_LINE];

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

/** What the `explore` tool returns: the retrieval result of the LAST query
 * that returned rows, plus the model's written answer and the chain of
 * queries that got there - explore is the one mode whose words reach the
 * caller. */
export interface ExploreResult extends RetrievalAgentResult {
  /** The written answer, when the exploration finished with one. */
  answer?: string;
  /** Every query that returned rows, in order, as the platform records it. */
  chain: string[];
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

/** What the `subagent` tool returns to the outer agent: the facts. */
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
   * first MAX_ROWS. */
  rows: RowRecord[];
  /** Distinct hits and rows among the facts before the caps. */
  hitsTotal: number;
  rowsTotal: number;
  turns: number;
  /** Present when the loop found no query that answers: why, in the platform's
   * words (on `escalated`, the model's own account of the problem). */
  error?: string;
}

/** What the loop cost on the platform, for the usage ledger and receipt:
 * never part of the tool result. */
export interface RetrievalAgentSpend {
  promptTokens: number;
  completionTokens: number;
  /** One entry per model call the loop made, when the platform reports them:
   * the tokens of that call, its wall time, and the rung of the platform's
   * model ladder that answered it (the rung sets the rate the platform
   * meters the call at, so the ledger can reproduce the platform's spend
   * figure exactly). Ledger only. */
  calls?: RetrievalAgentCall[];
}

export interface RetrievalAgentCall {
  promptTokens: number;
  completionTokens: number;
  ms?: number;
  rung?: number;
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
  const response = await hosted.subAgent({
    question: request.question,
    k,
    projection: FACT_PROJECTION,
    ...(budget.maxTurns !== undefined ? { max_turns: budget.maxTurns } : {}),
    max_wall_secs: budget.maxWallSecs,
  });
  return retrievalAgentRunFrom(request.question, response, k);
}

/** Hand the platform's loop one question in `explore` mode: it reads what it
 * finds and queries again, and returns a written answer beside the facts of
 * its last query and the chain of queries. A `maxTurns` in the budget lowers
 * the platform's explore budget; absent leaves it in force. */
export async function runExploreAgent(
  hosted: Pick<HostedDb, "subAgent">,
  request: RetrievalAgentRequest,
  budget: RetrievalAgentBudget,
): Promise<{ result: ExploreResult; spend: RetrievalAgentSpend }> {
  const k = budget.k ?? MAX_HITS;
  const response = await hosted.subAgent({
    question: request.question,
    mode: "explore",
    k,
    projection: FACT_PROJECTION,
    ...(budget.maxTurns !== undefined ? { max_turns: budget.maxTurns } : {}),
    max_wall_secs: budget.maxWallSecs,
  });
  return exploreRunFrom(request.question, response, k);
}

/** The explore run for one platform response: the retrieval run of the last
 * query's facts, plus `answer` and `chain`. */
export function exploreRunFrom(question: string, response: unknown, maxHits: number = MAX_HITS): { result: ExploreResult; spend: RetrievalAgentSpend } {
  const base = retrievalAgentRunFrom(question, response, maxHits);
  const body = asRecord(response);
  const answer = typeof body.answer === "string" && body.answer.length > 0 ? body.answer : undefined;
  const chain = Array.isArray(body.chain) ? body.chain.filter((s): s is string => typeof s === "string") : [];
  return { result: { ...base.result, ...(answer ? { answer } : {}), chain }, spend: base.spend };
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
 * `terminate`) is the one thing that throws. */
export function retrievalAgentRunFrom(question: string, response: unknown, maxHits: number = MAX_HITS): RetrievalAgentRun {
  const body = asRecord(response);
  if (typeof body.terminate !== "string") {
    throw new Error("subagent: the platform's response is not an agent result (no `terminate` field)");
  }
  const terminate = body.terminate;
  const statement = typeof body.statement === "string" && body.statement.length > 0 ? body.statement : undefined;
  const coverage = coverageOf(body);
  const result: RetrievalAgentResult = {
    question,
    ...(statement ? { sql: statement } : {}),
    ...(coverage ? { coverage } : {}),
    ...factsFrom(factRowsOf(body), maxHits),
    turns: numberField(body.turns),
  };
  if (terminate !== TERMINATE_ANSWERED) result.error = `${noAnswerMessage(terminate, body.error)} - ${NO_ANSWER_HINT}`;
  const spend: RetrievalAgentSpend = {
    promptTokens: numberField(body.prompt_tokens),
    completionTokens: numberField(body.completion_tokens),
  };
  const calls = callsOf(body.usage);
  if (calls.length > 0) spend.calls = calls;
  return { result, spend };
}

/** The platform's per-model-call accounting (`usage[]`), one record per call:
 * its tokens, and its wall time and rung when reported. Entries of another
 * shape contribute nothing. */
function callsOf(usage: unknown): RetrievalAgentCall[] {
  if (!Array.isArray(usage)) return [];
  const calls: RetrievalAgentCall[] = [];
  for (const raw of usage) {
    const u = asRecord(raw);
    if (!isFiniteNumber(u.prompt_tokens) && !isFiniteNumber(u.completion_tokens)) continue;
    const call: RetrievalAgentCall = { promptTokens: numberField(u.prompt_tokens), completionTokens: numberField(u.completion_tokens) };
    if (isFiniteNumber(u.ms)) call.ms = u.ms;
    if (isFiniteNumber(u.rung)) call.rung = u.rung;
    calls.push(call);
  }
  return calls;
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
 * count what was seen. */
export function factsFrom(rows: unknown[], maxHits: number = MAX_HITS): Facts {
  const hits: RetrievalAgentHit[] = [];
  const aggregates: RowRecord[] = [];
  const seenHits = new Set<string>();
  const seenRows = new Set<string>();
  for (const raw of rows) {
    const hit = hitFromRow(raw);
    if (hit) {
      const key = `${hit.path}:${hit.startLine}`;
      if (seenHits.has(key)) continue;
      seenHits.add(key);
      if (hits.length < maxHits) hits.push(hit);
      continue;
    }
    const row = scalarRow(raw);
    if (row === null) continue;
    const key = JSON.stringify(row);
    if (seenRows.has(key)) continue;
    seenRows.add(key);
    if (aggregates.length < MAX_ROWS) aggregates.push(row);
  }
  return { hits, rows: aggregates, hitsTotal: seenHits.size, rowsTotal: seenRows.size };
}

/** A row as a hit, or null when it does not name a place in the code. The
 * content is cut at HIT_CONTENT_CHARS like a search hit's; a row with the
 * place columns and no content is a hit with empty content (the citation is
 * the fact). */
function hitFromRow(raw: unknown): RetrievalAgentHit | null {
  const row = asRecord(raw);
  const path = row[COL_PATH];
  const startLine = row[COL_START_LINE];
  const endLine = row[COL_END_LINE];
  if (typeof path !== "string" || !isFiniteNumber(startLine) || !isFiniteNumber(endLine)) return null;
  const content = typeof row[COL_CONTENT] === "string" ? (row[COL_CONTENT] as string).slice(0, HIT_CONTENT_CHARS) : "";
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
