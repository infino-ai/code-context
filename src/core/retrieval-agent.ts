// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The `retrieval_agent` door, hosted mode only: one question handed to the
// platform's own agent (`POST /v1/ask/{database}`), which answers it over the
// chunks table. This file turns the platform's response into what the outer
// agent sees, shaped like the other retrieval tools so it can cite from it:
// the answer, the HITS (path, line range, a line of text - the places the
// inner agent's queries touched, distilled from the transcript), and the
// QUERIES it ran (statements and search terms, without their rows). The
// loop's own spend (turns, tokens) is not part of the tool result: it travels
// beside it to the usage ledger. The whole transcript is never returned: it
// is paid for on every later turn of the outer agent and says nothing the
// hits and queries do not.

import type { HostedDb } from "./hosted.js";

/** Hits kept in one result. The platform caps a tool result at 25 rows and
 * the inner agent may run several; twenty cited places is the top of any
 * ranking and more than a search call returns. */
export const MAX_HITS = 20;

/** Characters kept of a hit's text: the first line of the chunk, cut so a
 * result of MAX_HITS hits stays a few hundred tokens. */
export const HIT_TEXT_CHARS = 120;

/** The platform's `terminate` value for a loop that submitted an accepted
 * answer (`TerminateReason::Answered`, serialized snake_case). */
export const TERMINATE_ANSWERED = "answered";

/** The inner agent's answer-submission tool: a call to it is the answer, not
 * a query, so it is left out of the queries list. */
const FINAL_ANSWER_TOOL = "final_answer";

/** Transcript roles the result is read from: the assistant's tool calls and
 * the tool results keyed back to them by id. */
const ROLE_ASSISTANT = "assistant";
const ROLE_TOOL = "tool";

/** The row columns a hit is built from: the chunks table's path and line
 * range, and its text. A row without the first three is not a place in the
 * code and contributes no hit. */
const COL_PATH = "path";
const COL_START_LINE = "start_line";
const COL_END_LINE = "end_line";
const COL_CONTENT = "content";

/** Separator between the scalar columns of a row rendered as a hit's text
 * when the row carries no content column (an aggregate: a count, a sum). */
const COLUMN_SEPARATOR = ", ";

/** Why a loop ended without an answer, in the outer agent's terms: each maps a
 * platform `terminate` value to the reason and the fallback. */
const NO_ANSWER_REASONS: Record<string, string> = {
  turn_cap: "the retrieval agent ran out of turns without an answer",
  wall_cap: "the retrieval agent ran out of time without an answer",
  error: "the retrieval agent's model endpoint failed",
};

/** What the outer agent is told to do when there is no answer. */
const FALLBACK_HINT = "fall back to search or sql";

/** The answer contract, as the platform's `AskRequest.answer` spells it. */
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

/** One place the inner agent's queries touched: the same path and line range
 * a search hit carries, so the outer agent cites it as path:line, plus one
 * line of text saying what is there. */
export interface RetrievalAgentHit {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** One query the inner agent ran: the tool, and the statement (query_sql) or
 * the search terms (the search tools). Rows are not repeated here - the
 * places they named are the hits. */
export interface RetrievalAgentQuery {
  tool: string;
  sql?: string;
  query?: string;
}

/** What the `retrieval_agent` tool returns to the outer agent. */
export interface RetrievalAgentResult {
  question: string;
  /** The answer in the requested shape, or null when the loop ended without one. */
  answer: string | null;
  hits: RetrievalAgentHit[];
  queries: RetrievalAgentQuery[];
  turns: number;
  /** Present when `answer` is null: why, and what to do instead. */
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
 * transcript before it is split into the queries and the hits. */
export interface TranscriptStep {
  query: RetrievalAgentQuery;
  rows: unknown[];
}

/** Hand the platform's retrieval agent one question over the hosted
 * database. The transcript is requested so the hits and queries can be read
 * from it, and dropped again here. Retryable platform states are handled
 * inside the client; a terminal failure (no agent configured, bad key)
 * surfaces as its error. */
export async function runRetrievalAgent(
  hosted: Pick<HostedDb, "ask">,
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
  return retrievalAgentRunFrom(request.question, response);
}

/** The run for one platform response. A loop that ended without an accepted
 * answer is still a result, not a tool error: `answer` is null and `error`
 * says why, so the outer agent falls back to search/sql instead of treating
 * the call as broken - and the hits it found on the way still come back. A
 * body that is not an agent response at all (no `terminate`) is the one
 * thing that throws. */
export function retrievalAgentRunFrom(question: string, response: unknown): RetrievalAgentRun {
  const body = asRecord(response);
  if (typeof body.terminate !== "string") {
    throw new Error("retrieval_agent: the platform's response is not an agent result (no `terminate` field)");
  }
  const terminate = body.terminate;
  const answer = typeof body.answer === "string" ? body.answer : null;
  const steps = stepsFrom(Array.isArray(body.transcript) ? body.transcript : []);
  const result: RetrievalAgentResult = {
    question,
    answer: terminate === TERMINATE_ANSWERED ? answer : null,
    hits: hitsFrom(steps),
    queries: steps.map((s) => s.query),
    turns: numberField(body.turns),
  };
  if (result.answer === null) result.error = noAnswerMessage(terminate, body.error);
  const spend: RetrievalAgentSpend = {
    promptTokens: numberField(body.prompt_tokens),
    completionTokens: numberField(body.completion_tokens),
  };
  return { result, spend };
}

/** Why there is no answer, for the outer agent: the platform's reason for the
 * way the loop ended, the endpoint's own words when it failed, and the
 * fallback. An `answered` loop with no text is reported as such rather than
 * invented. */
function noAnswerMessage(terminate: string, detail: unknown): string {
  const reason =
    terminate === TERMINATE_ANSWERED
      ? "the retrieval agent reported an answer but sent none"
      : (NO_ANSWER_REASONS[terminate] ?? `the retrieval agent ended with "${terminate}" and no answer`);
  const words = typeof detail === "string" && detail.length > 0 ? `: ${detail}` : "";
  return `${reason}${words} - ${FALLBACK_HINT}`;
}

/** The hits in a transcript: every row of every tool result that names a
 * place in the code (path + start_line + end_line; a row without them yields
 * none), in transcript order, one per path:start_line, the first MAX_HITS. */
export function hitsFrom(steps: TranscriptStep[]): RetrievalAgentHit[] {
  const hits: RetrievalAgentHit[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const raw of step.rows) {
      const hit = hitFromRow(raw);
      if (!hit) continue;
      const key = `${hit.path}:${hit.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
      if (hits.length === MAX_HITS) return hits;
    }
  }
  return hits;
}

/** A row as a hit, or null when it does not name a place in the code. The
 * text is the row's content when it has one (its first line), else the
 * row's other scalar columns rendered `name=value` - an aggregate row's
 * count or sum is what the agent found there. */
function hitFromRow(raw: unknown): RetrievalAgentHit | null {
  const row = asRecord(raw);
  const path = row[COL_PATH];
  const startLine = row[COL_START_LINE];
  const endLine = row[COL_END_LINE];
  if (typeof path !== "string" || !isFiniteNumber(startLine) || !isFiniteNumber(endLine)) return null;
  const content = row[COL_CONTENT];
  const text =
    typeof content === "string"
      ? content.split("\n", 1)[0] ?? ""
      : Object.entries(row)
          .filter(([name, value]) => ![COL_PATH, COL_START_LINE, COL_END_LINE, COL_CONTENT].includes(name) && isScalar(value))
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(COLUMN_SEPARATOR);
  return { path, startLine, endLine, text: text.slice(0, HIT_TEXT_CHARS) };
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
 * body of any other shape has no rows a hit could be read from. */
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

/** A value that renders as itself in a hit's text: a string, number or boolean. */
const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** A numeric field, 0 when absent or not a finite number. */
function numberField(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}
