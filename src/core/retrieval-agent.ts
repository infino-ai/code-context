// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The `subagent` tool, hosted mode only: one question or task handed to the
// platform's retrieval loop (`POST /v1/sub_agent/{database}`), which answers
// with a FACT TABLE - the statement it settled on and the rows the database
// returned for it - and never with anything the model wrote. This file turns
// that response into the tool result and nothing more: the statement, and
// the table's rows - each that names a place in the code (path, start_line,
// end_line) as a search-shaped hit with whatever content the statement
// selected, the rest as aggregate rows (counts, rankings) - with the
// platform's coverage of the result. The loop's transcript is its own
// business and is never requested. The loop's spend (turns, tokens) travels
// beside the result to the usage ledger.

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

/** The platform's `terminate` value for a loop that submitted an accepted
 * statement (serialized snake_case). */
export const TERMINATE_ANSWERED = "answered";

/** The row columns a hit is built from: the chunks table's path and line
 * range, its text, and the two descriptors search hits also carry. */
const COL_PATH = "path";
const COL_START_LINE = "start_line";
const COL_END_LINE = "end_line";
const COL_CONTENT = "content";
const COL_SYMBOL = "symbol";
const COL_LANG = "lang";

/** Why a loop ended without a statement, in the outer agent's terms: each
 * maps a platform `terminate` value to the reason. */
const NO_ANSWER_REASONS: Record<string, string> = {
  turn_cap: "the retrieval agent ran out of turns without settling on a statement",
  wall_cap: "the retrieval agent ran out of time without settling on a statement",
  error: "the retrieval agent's model endpoint failed",
};

/** What the outer agent is told when there is no table. */
const NO_ANSWER_HINT = "ask again more narrowly, or use find or search";

export interface RetrievalAgentRequest {
  question: string;
}

export interface RetrievalAgentBudget {
  /** Model turns the inner loop may take (the platform lowers a value above its own cap). */
  maxTurns: number;
  /** Wall clock for the inner loop, in seconds (likewise capped server-side). */
  maxWallSecs: number;
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

/** How much of the statement's result the platform returned: the table is
 * bounded server-side, and a caller wanting the rest runs the statement
 * again with LIMIT/OFFSET. */
export interface RetrievalAgentCoverage {
  rowsTotal: number;
  rowsReturned: number;
  truncated: boolean;
}

/** What the `subagent` tool returns to the outer agent: the fact table. */
export interface RetrievalAgentResult {
  question: string;
  /** The statement whose rows answer the question, when the loop settled on one. */
  sql?: string;
  /** How much of the statement's result the platform returned; absent with no statement. */
  coverage?: RetrievalAgentCoverage;
  /** The table's rows that name a place in the code, one per path:start_line, the first MAX_HITS. */
  hits: RetrievalAgentHit[];
  /** The table's other rows - aggregates such as a count or a rank per path -
   * with their scalar columns as returned; the first MAX_ROWS. */
  rows: RowRecord[];
  /** Distinct hits and rows in the table before the caps. */
  hitsTotal: number;
  rowsTotal: number;
  turns: number;
  /** Present when the loop did not settle on a statement: why. */
  error?: string;
}

/** What the loop cost on the platform, for the usage ledger and receipt:
 * never part of the tool result. */
export interface RetrievalAgentSpend {
  promptTokens: number;
  completionTokens: number;
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
 * and return its fact table. Retryable platform states are handled inside
 * the client; a terminal failure (no agent configured, bad key) surfaces as
 * its error. */
export async function runRetrievalAgent(
  hosted: Pick<HostedDb, "subAgent">,
  request: RetrievalAgentRequest,
  budget: RetrievalAgentBudget,
): Promise<RetrievalAgentRun> {
  const response = await hosted.subAgent({
    question: request.question,
    max_turns: budget.maxTurns,
    max_wall_secs: budget.maxWallSecs,
  });
  return retrievalAgentRunFrom(request.question, response);
}

/** The fact table of a response, when the loop settled on a statement: the
 * statement and its rows as records (the platform sends columns and
 * positional rows). Null when `table` is null or malformed. */
export function tableOf(response: unknown): { statement: string; rows: RowRecord[] } | null {
  const table = asRecord(asRecord(response).table);
  if (typeof table.statement !== "string" || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
  const columns = table.columns.map((c) => String(c));
  const rows: RowRecord[] = [];
  for (const raw of table.rows) {
    if (!Array.isArray(raw)) continue;
    const row: RowRecord = {};
    columns.forEach((name, i) => {
      row[name] = raw[i];
    });
    rows.push(row);
  }
  return { statement: table.statement, rows };
}

/** The response's coverage of the statement's result, when it carries one. */
function coverageOf(response: unknown): RetrievalAgentCoverage | undefined {
  const c = asRecord(asRecord(response).coverage);
  if (!isFiniteNumber(c.rows_total) || !isFiniteNumber(c.rows_returned)) return undefined;
  return { rowsTotal: c.rows_total, rowsReturned: c.rows_returned, truncated: c.truncated === true };
}

/** The run for one platform response. A loop that ended without a statement
 * is still a result, not a tool error: `error` says why, and the outer agent
 * decides what to do next. A body that is not an agent response at all (no
 * `terminate`) is the one thing that throws. */
export function retrievalAgentRunFrom(question: string, response: unknown): RetrievalAgentRun {
  const body = asRecord(response);
  if (typeof body.terminate !== "string") {
    throw new Error("subagent: the platform's response is not an agent result (no `terminate` field)");
  }
  const terminate = body.terminate;
  const table = tableOf(body);
  const coverage = table ? coverageOf(body) : undefined;
  const result: RetrievalAgentResult = {
    question,
    ...(table ? { sql: table.statement } : {}),
    ...(coverage ? { coverage } : {}),
    ...factsFrom(table?.rows ?? []),
    turns: numberField(body.turns),
  };
  if (terminate !== TERMINATE_ANSWERED || !table) result.error = `${noAnswerMessage(terminate, body.error)} - ${NO_ANSWER_HINT}`;
  const spend: RetrievalAgentSpend = {
    promptTokens: numberField(body.prompt_tokens),
    completionTokens: numberField(body.completion_tokens),
  };
  return { result, spend };
}

/** Why there is no table: the platform's reason for the way the loop ended
 * and, when the endpoint itself failed, its words. An `answered` loop
 * without a table is reported as such rather than invented. */
function noAnswerMessage(terminate: string, detail: unknown): string {
  const reason =
    terminate === TERMINATE_ANSWERED
      ? "the retrieval agent reported a statement but sent no table"
      : (NO_ANSWER_REASONS[terminate] ?? `the retrieval agent ended with "${terminate}"`);
  const words = typeof detail === "string" && detail.length > 0 ? `: ${detail}` : "";
  return `${reason}${words}`;
}

/** The facts in the table's rows, in order: every row that names a place in
 * the code (path + start_line + end_line) becomes a hit with its content,
 * one per path:start_line; every other row with a scalar column becomes an
 * aggregate row, one per distinct set of scalar cells. Both lists are
 * capped, and the totals count what was seen. */
export function factsFrom(rows: unknown[]): Facts {
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
      if (hits.length < MAX_HITS) hits.push(hit);
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
