// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The `subagent` tool, hosted mode only: one question or task handed to the
// platform's retrieval agent (`POST /v1/ask/{database}`), which searches the
// chunks table and, in the default `sql` answer mode, submits one statement
// whose rows answer the question. What comes back to the outer agent is
// FACTS and only facts: the rows the loop retrieved and the rows its
// statement returns, each with its exact path, start_line, end_line and the
// code (the shape of a search hit), plus any aggregate rows (counts,
// rankings) and the queries that produced them. Nothing the inner model
// wrote is returned: a summary in the tool result becomes the outer agent's
// answer verbatim, and the judge finds what it asserted "matches no
// verifiable metric" - the rows are what it can verify and cite. The loop's
// own spend (turns, tokens) travels beside the result to the usage ledger;
// the transcript itself is never returned.

import type { HostedDb, RowRecord } from "./hosted.js";
import { DEFAULT_SEARCH_K } from "./config.js";

/** Place-naming rows kept in one result: as many as a search returns by
 * default, so a subagent result costs the outer agent what a search does.
 * Measured at 50: the loop's four or five queries at 25 rows each filled the
 * cap and a result averaged 10.9k tokens, which is where the lane's token
 * bill went. The platform retrieves and ranks more than this before
 * answering; the statement's rows lead, and `hitsTotal` says what was cut. */
export const MAX_HITS = DEFAULT_SEARCH_K;

/** Aggregate rows (a count or rank per path) kept in one result: small rows,
 * so a longer list still costs less than a few hits - but a ranking past
 * fifty paths is a survey, not an answer. */
export const MAX_ROWS = 50;

/** Characters kept of a hit's content: search's own cap on a chunk, so a
 * subagent hit reads exactly like a search hit. */
export const HIT_CONTENT_CHARS = 4000;

/** The platform's `terminate` value for a loop that submitted an accepted
 * answer (serialized snake_case). */
export const TERMINATE_ANSWERED = "answered";

/** The inner agent's answer-submission tool: a call to it is the answer, not
 * a query, so it is left out of the queries list. */
const FINAL_ANSWER_TOOL = "final_answer";

/** Transcript roles the result is read from: the assistant's tool calls and
 * the tool results keyed back to them by id. */
const ROLE_ASSISTANT = "assistant";
const ROLE_TOOL = "tool";

/** The row columns a hit is built from: the chunks table's path and line
 * range, its text, and the two descriptors search hits also carry. */
const COL_PATH = "path";
const COL_START_LINE = "start_line";
const COL_END_LINE = "end_line";
const COL_CONTENT = "content";
const COL_SYMBOL = "symbol";
const COL_LANG = "lang";

/** Why a loop ended without an answer, in the outer agent's terms: each maps a
 * platform `terminate` value to the reason. */
const NO_ANSWER_REASONS: Record<string, string> = {
  turn_cap: "the retrieval agent ran out of turns",
  wall_cap: "the retrieval agent ran out of time",
  error: "the retrieval agent's model endpoint failed",
};

/** What the outer agent is told when the loop did not finish: the rows are
 * still what it found on the way. */
const NO_ANSWER_HINT = "the hits and rows below are what it retrieved before stopping";

/** The answer contract, as the platform's ask request spells it. `sql` (the
 * default) asks for one statement whose rows answer the question; `text` lets
 * the loop reason toward a written answer, which is then discarded here - the
 * rows it retrieved on the way are the result either way. */
export type RetrievalAgentAnswerType = "text" | "scalar" | "sql";

export interface RetrievalAgentRequest {
  question: string;
  answer: RetrievalAgentAnswerType;
}

export interface RetrievalAgentBudget {
  /** Model turns the inner loop may take (the platform lowers a value above its own cap). */
  maxTurns: number;
  /** Wall clock for the inner loop, in seconds (likewise capped server-side). */
  maxWallSecs: number;
}

/** One place the loop retrieved: a search hit's shape, so the outer agent
 * cites it as path:line and answers from the content. */
export interface RetrievalAgentHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  symbol?: string;
  lang?: string;
}

/** One query the inner agent ran: the tool, and the statement (query_sql) or
 * the search terms (the search tools). */
export interface RetrievalAgentQuery {
  tool: string;
  sql?: string;
  query?: string;
}

/** What the `subagent` tool returns to the outer agent: facts. */
export interface RetrievalAgentResult {
  question: string;
  /** The statement whose rows answer the question, when the loop produced one. */
  sql?: string;
  /** Rows naming a place in the code, the statement's first, then the loop's
   * retrievals in transcript order; one per path:start_line, the first MAX_HITS. */
  hits: RetrievalAgentHit[];
  /** Rows that name no place - aggregates such as a count or a rank per path -
   * with their scalar columns as returned; the first MAX_ROWS. */
  rows: RowRecord[];
  /** Distinct hits and rows seen before the caps. */
  hitsTotal: number;
  rowsTotal: number;
  queries: RetrievalAgentQuery[];
  turns: number;
  /** Present when the loop did not finish (or its statement failed): why. */
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

/** One transcript message: the OpenAI chat shape, read defensively. */
interface TranscriptMessage {
  role?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  content?: unknown;
}

interface TranscriptToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** One tool call paired with the rows of its result, as read from the
 * transcript before it is split into the queries and the facts. */
export interface TranscriptStep {
  query: RetrievalAgentQuery;
  rows: unknown[];
}

/** The facts in a set of row lists, split into hits and aggregate rows. */
export interface Facts {
  hits: RetrievalAgentHit[];
  rows: RowRecord[];
  hitsTotal: number;
  rowsTotal: number;
}

/** Hand the platform's retrieval agent one question over the hosted
 * database and return what it retrieved. The transcript is requested so the
 * rows can be read from it, and dropped again here. When the loop answers
 * with a statement, the statement is run and its rows lead the result; a
 * statement that fails to run is reported in `error` and the transcript's
 * rows still come back. Retryable platform states are handled inside the
 * client; a terminal failure (no agent configured, bad key) surfaces as its
 * error. */
export async function runRetrievalAgent(
  hosted: Pick<HostedDb, "ask" | "querySql">,
  request: RetrievalAgentRequest,
  budget: RetrievalAgentBudget,
): Promise<RetrievalAgentRun> {
  const response = await hosted.ask({
    question: request.question,
    answer: request.answer,
    max_turns: budget.maxTurns,
    max_wall_secs: budget.maxWallSecs,
    include_transcript: true,
  });
  const sql = statementOf(response);
  let statementRows: unknown[] = [];
  let statementError: string | undefined;
  if (sql !== undefined) {
    try {
      statementRows = await hosted.querySql(sql);
    } catch (err) {
      statementError = `the statement failed to run: ${(err as Error).message}`;
    }
  }
  return retrievalAgentRunFrom(request.question, response, { statementRows, statementError });
}

/** The statement a `sql`-mode loop submitted, when the response carries one:
 * the platform serializes it as the JSON text `{"sql": "..."}` in `answer`. A
 * loop that answered in prose instead (or did not answer) has none. */
export function statementOf(response: unknown): string | undefined {
  const body = asRecord(response);
  if (body.terminate !== TERMINATE_ANSWERED || typeof body.answer !== "string") return undefined;
  try {
    const parsed = asRecord(JSON.parse(body.answer));
    return typeof parsed.sql === "string" && parsed.sql.length > 0 ? parsed.sql : undefined;
  } catch {
    return undefined;
  }
}

/** The run for one platform response, plus the rows of its statement when one
 * was run. A loop that ended without an accepted answer is still a result,
 * not a tool error: `error` says why and the rows it found on the way still
 * come back. A body that is not an agent response at all (no `terminate`) is
 * the one thing that throws. */
export function retrievalAgentRunFrom(
  question: string,
  response: unknown,
  executed: { statementRows?: unknown[]; statementError?: string } = {},
): RetrievalAgentRun {
  const body = asRecord(response);
  if (typeof body.terminate !== "string") {
    throw new Error("subagent: the platform's response is not an agent result (no `terminate` field)");
  }
  const terminate = body.terminate;
  const steps = stepsFrom(Array.isArray(body.transcript) ? body.transcript : []);
  const sql = statementOf(body);
  const facts = factsFrom([executed.statementRows ?? [], ...steps.map((s) => s.rows)]);
  const result: RetrievalAgentResult = {
    question,
    ...(sql !== undefined ? { sql } : {}),
    ...facts,
    queries: steps.map((s) => s.query),
    turns: numberField(body.turns),
  };
  const problems: string[] = [];
  if (terminate !== TERMINATE_ANSWERED) problems.push(noAnswerMessage(terminate, body.error));
  if (executed.statementError) problems.push(executed.statementError);
  if (problems.length > 0) result.error = `${problems.join("; ")} - ${NO_ANSWER_HINT}`;
  const spend: RetrievalAgentSpend = {
    promptTokens: numberField(body.prompt_tokens),
    completionTokens: numberField(body.completion_tokens),
  };
  return { result, spend };
}

/** Why the loop did not finish: the platform's reason for the way it ended
 * and, when the endpoint itself failed, its words. */
function noAnswerMessage(terminate: string, detail: unknown): string {
  const reason = NO_ANSWER_REASONS[terminate] ?? `the retrieval agent ended with "${terminate}"`;
  const words = typeof detail === "string" && detail.length > 0 ? `: ${detail}` : "";
  return `${reason}${words}`;
}

/** The facts in row lists, in order: every row that names a place in the
 * code (path + start_line + end_line) becomes a hit with its content, one per
 * path:start_line; every other row with a scalar column becomes an aggregate
 * row, one per distinct set of scalar cells. Both lists are capped, and the
 * totals count what was seen. */
export function factsFrom(rowLists: unknown[][]): Facts {
  const hits: RetrievalAgentHit[] = [];
  const rows: RowRecord[] = [];
  const seenHits = new Set<string>();
  const seenRows = new Set<string>();
  for (const list of rowLists) {
    for (const raw of list) {
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
      if (rows.length < MAX_ROWS) rows.push(row);
    }
  }
  return { hits, rows, hitsTotal: seenHits.size, rowsTotal: seenRows.size };
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

/** The tool calls in a transcript: every tool call of every assistant message
 * (the answer submission excluded) paired with the rows of its result by
 * `tool_call_id`. */
export function stepsFrom(transcript: unknown[]): TranscriptStep[] {
  const messages = transcript.map((m) => asRecord(m) as TranscriptMessage);
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === ROLE_TOOL && typeof m.tool_call_id === "string" && typeof m.content === "string") {
      results.set(m.tool_call_id, m.content);
    }
  }
  const steps: TranscriptStep[] = [];
  for (const m of messages) {
    if (m.role !== ROLE_ASSISTANT || !Array.isArray(m.tool_calls)) continue;
    for (const raw of m.tool_calls) {
      const call = asRecord(raw) as TranscriptToolCall;
      const tool = typeof call.function?.name === "string" ? call.function.name : "";
      if (tool.length === 0 || tool === FINAL_ANSWER_TOOL) continue;
      const args = parseArguments(call.function?.arguments);
      const query: RetrievalAgentQuery = { tool };
      if (typeof args.sql === "string") query.sql = args.sql;
      if (typeof args.query === "string") query.query = args.query;
      const content = typeof call.id === "string" ? results.get(call.id) : undefined;
      steps.push({ query, rows: content === undefined ? [] : rowsOf(content) });
    }
  }
  return steps;
}

/** A tool call's arguments as an object. Providers send them as a JSON
 * string; one that is not JSON, or already an object, is read as it came. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return asRecord(raw);
}

/** The rows of one tool result. The platform renders a result as
 * `{"rows": [...], "note"?}` and a failed call as `{"error": "..."}`; a
 * body of any other shape has no rows a fact could be read from. */
function rowsOf(content: string): unknown[] {
  try {
    const parsed = asRecord(JSON.parse(content));
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
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
