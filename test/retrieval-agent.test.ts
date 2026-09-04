// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The subagent tool's logic, without an MCP transport: how a sub_agent
// response (a fact table plus, when asked, the transcript) becomes the tool
// result - the statement, the hits and the aggregate rows read from the
// table and the transcript, never anything the model wrote - the no-answer
// reporting, and what runRetrievalAgent sends. No network.

import { describe, expect, it } from "vitest";
import {
  runRetrievalAgent,
  retrievalAgentRunFrom,
  tableOf,
  stepsFrom,
  factsFrom,
  MAX_HITS,
  MAX_ROWS,
  HIT_CONTENT_CHARS,
  ROW_CELL_CHARS,
  TERMINATE_ANSWERED,
  type RetrievalAgentResult,
} from "../src/core/retrieval-agent.js";

// --- fixtures: the platform's response and transcript shapes ------------------------

/** A tool-calling assistant message in the OpenAI shape the loop records. */
const toolCall = (id: string, name: string, args: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

/** The tool message the loop records for a call, its content a JSON string. */
const toolResult = (id: string, content: unknown) => ({
  role: "tool",
  tool_call_id: id,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

/** A chunks-table row as `SELECT path, start_line, end_line, content` returns it. */
const chunkRow = (i: number, content = `fn f${i}() {\n  body\n}`) => ({
  path: `src/f${i}.ts`,
  start_line: 10 * i + 1,
  end_line: 10 * i + 9,
  content,
});

const chunkRows = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => chunkRow(i)),
  ...(n > 25 ? { note: `${n} rows total; first 25 shown - aggregate in SQL instead` } : {}),
});

/** The statement the loop settled on, and its fact table as the platform
 * returns it: columns once, rows positional. */
const STATEMENT = "SELECT path, COUNT(*) AS n FROM token_match('chunks','content','compaction') GROUP BY path ORDER BY n DESC";
const TABLE = { statement: STATEMENT, columns: ["path", "n"], rows: [["src/f1.ts", 7], ["src/f0.ts", 2]] };
const COVERAGE = { rows_total: 2, rows_returned: 2, truncated: false };

/** A complete `answered` response, as the platform returns it. */
function answered(overrides: Record<string, unknown> = {}) {
  return {
    table: TABLE,
    coverage: COVERAGE,
    terminate: "answered",
    turns: 3,
    answer_retries: 0,
    bare_reply: false,
    prompt_tokens: 1200,
    completion_tokens: 80,
    usage: [{ prompt_tokens: 400, completion_tokens: 30 }],
    model: "some-model",
    transcript: [
      { role: "system", content: "You answer questions about a database ... <the whole system prompt>" },
      { role: "user", content: "which files mention compaction?" },
      toolCall("c1", "query_sql", { sql: "SELECT path, start_line, end_line, content FROM chunks LIMIT 3" }),
      toolResult("c1", chunkRows(3)),
      toolCall("c2", "final_answer", { answer: JSON.stringify({ sql: STATEMENT }) }),
      toolResult("c2", { ok: true }),
    ],
    ...overrides,
  };
}

/** The same response with the loop ending short of a statement. */
const unanswered = (terminate: string, extra: Record<string, unknown> = {}) =>
  answered({ table: null, coverage: { rows_total: 0, rows_returned: 0, truncated: false }, terminate, ...extra });

const QUESTION = "which files mention compaction?";

// --- retrievalAgentRunFrom ------------------------------------------------------------

describe("retrievalAgentRunFrom", () => {
  it("returns the statement, its rows as facts, the hits from the transcript with their content, and the queries - and no prose", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered());
    expect(result).toEqual({
      question: QUESTION,
      sql: STATEMENT,
      coverage: { rowsTotal: 2, rowsReturned: 2, truncated: false },
      hits: [
        { path: "src/f0.ts", startLine: 1, endLine: 9, content: "fn f0() {\n  body\n}" },
        { path: "src/f1.ts", startLine: 11, endLine: 19, content: "fn f1() {\n  body\n}" },
        { path: "src/f2.ts", startLine: 21, endLine: 29, content: "fn f2() {\n  body\n}" },
      ],
      rows: [
        { path: "src/f1.ts", n: 7 },
        { path: "src/f0.ts", n: 2 },
      ],
      hitsTotal: 3,
      rowsTotal: 2,
      queries: [{ tool: "query_sql", sql: "SELECT path, start_line, end_line, content FROM chunks LIMIT 3" }],
      turns: 3,
    });
    expect(result.error).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["coverage", "hits", "hitsTotal", "queries", "question", "rows", "rowsTotal", "sql", "turns"]);
  });

  it("keeps the loop's spend beside the result, not in it, and drops the platform's own fields and the transcript", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered());
    expect(spend).toEqual({ promptTokens: 1200, completionTokens: 80 });
    const asRecord = result as RetrievalAgentResult & Record<string, unknown>;
    for (const dropped of ["table", "model", "prompt_tokens", "completion_tokens", "terminate", "transcript", "usage", "answer_retries", "bare_reply", "card_tier", "rung"]) {
      expect(asRecord[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("the whole system prompt");
  });

  it("puts the statement's rows first when they name places, ahead of the transcript's", () => {
    const table = {
      statement: "SELECT path, start_line, end_line, content FROM chunks WHERE path = 'src/f9.ts'",
      columns: ["path", "start_line", "end_line", "content"],
      rows: [["src/f9.ts", 91, 99, "from the statement"], ["src/f0.ts", 1, 9, "seen first here, so this content wins"]],
    };
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ table }));
    expect(result.hits.map((h) => `${h.path} ${h.content}`)).toEqual([
      "src/f9.ts from the statement",
      "src/f0.ts seen first here, so this content wins",
      "src/f1.ts fn f1() {\n  body\n}",
      "src/f2.ts fn f2() {\n  body\n}",
    ]);
    expect(result.rows).toEqual([]);
  });

  it("reports the platform's coverage when the statement's result was cut", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ coverage: { rows_total: 1500, rows_returned: 1000, truncated: true } }));
    expect(result.coverage).toEqual({ rowsTotal: 1500, rowsReturned: 1000, truncated: true });
  });

  it("returns the facts found on the way, with a reason, when the loop hit its turn cap", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, unanswered("turn_cap", { turns: 4 }));
    expect(result.sql).toBeUndefined();
    expect(result.coverage).toBeUndefined();
    expect(result.error).toMatch(/ran out of turns/);
    expect(result.error).toMatch(/what it retrieved before stopping/);
    expect(result.turns).toBe(4);
    expect(result.hits).toHaveLength(3);
    expect(result.rows).toEqual([]);
    expect(result.queries).toHaveLength(1);
  });

  it("names the wall cap and carries the endpoint's own words on an error termination", () => {
    expect(retrievalAgentRunFrom(QUESTION, unanswered("wall_cap")).result.error).toMatch(/ran out of time/);
    const failed = retrievalAgentRunFrom(QUESTION, unanswered("error", { error: "401 from the model host" })).result;
    expect(failed.error).toBe(
      "the retrieval agent's model endpoint failed: 401 from the model host - the hits and rows below are what it retrieved before stopping",
    );
  });

  it("describes an unknown terminate value verbatim", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, unanswered("budget_exceeded"));
    expect(result.error).toMatch(/"budget_exceeded"/);
  });

  it("throws on a body that is not an agent response", () => {
    expect(() => retrievalAgentRunFrom(QUESTION, { rows: [] })).toThrow(/not an agent result/);
    expect(() => retrievalAgentRunFrom(QUESTION, null)).toThrow(/not an agent result/);
    expect(() => retrievalAgentRunFrom(QUESTION, "plain text")).toThrow(/not an agent result/);
  });

  it("tolerates a response without a transcript (the server left it out)", () => {
    const { transcript: _dropped, ...noTranscript } = answered();
    const { result } = retrievalAgentRunFrom(QUESTION, noTranscript);
    expect(result.sql).toBe(STATEMENT);
    expect(result.rows).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    expect(result.hits).toEqual([]);
    expect(result.queries).toEqual([]);
  });

  it("defaults a missing or malformed numeric field to 0 instead of NaN", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ turns: "3", prompt_tokens: undefined, completion_tokens: Number.NaN }));
    expect(result.turns).toBe(0);
    expect(spend.promptTokens).toBe(0);
    expect(spend.completionTokens).toBe(0);
  });

  it("uses the terminate constant the platform serializes", () => {
    expect(TERMINATE_ANSWERED).toBe("answered");
  });
});

// --- tableOf ----------------------------------------------------------------------------------

describe("tableOf", () => {
  it("reads the statement and turns positional rows into records by column, in order", () => {
    expect(tableOf(answered())).toEqual({
      statement: STATEMENT,
      rows: [
        { path: "src/f1.ts", n: 7 },
        { path: "src/f0.ts", n: 2 },
      ],
    });
  });

  it("keeps a null cell and skips a row that is not an array; a duplicate column name keeps the last cell", () => {
    const table = { statement: "S", columns: ["name", "name", "k"], rows: [["a", "b", null], "garbage", ["c", "d", 1]] };
    expect(tableOf({ table })).toEqual({ statement: "S", rows: [{ name: "b", k: null }, { name: "d", k: 1 }] });
  });

  it("is null without a table, or with a malformed one", () => {
    expect(tableOf(unanswered("turn_cap"))).toBeNull();
    expect(tableOf({ table: { statement: "S" } })).toBeNull();
    expect(tableOf({ table: { columns: [], rows: [] } })).toBeNull();
    expect(tableOf(null)).toBeNull();
  });
});

// --- factsFrom --------------------------------------------------------------------------------

describe("factsFrom", () => {
  const rows = (...lists: unknown[][]) => factsFrom(lists);

  it("makes one hit per row carrying path, start_line and end_line, with the whole content and the descriptors", () => {
    const { hits } = rows([{ ...chunkRow(4, "first line\nsecond line"), symbol: "f4", lang: "ts" }]);
    expect(hits).toEqual([{ path: "src/f4.ts", startLine: 41, endLine: 49, content: "first line\nsecond line", symbol: "f4", lang: "ts" }]);
  });

  it("cuts a hit's content at HIT_CONTENT_CHARS, the same cap a search hit has", () => {
    const long = "x".repeat(HIT_CONTENT_CHARS * 2);
    const { hits } = rows([chunkRow(0, long)]);
    expect(HIT_CONTENT_CHARS).toBe(4000);
    expect(hits[0].content).toHaveLength(HIT_CONTENT_CHARS);
  });

  it("gives empty content to a row with only the place columns - the citation is the fact", () => {
    const { hits } = rows([{ path: "a.ts", start_line: 1, end_line: 2 }]);
    expect(hits).toEqual([{ path: "a.ts", startLine: 1, endLine: 2, content: "" }]);
  });

  it("keeps rows that name no place as aggregate rows, scalar cells only", () => {
    const facts = rows([
      { path: "src/a.rs", n: 3, embedding: [0.1, 0.2], meta: { k: 1 } },
      { path: "src/b.rs", start_line: "7", end_line: 9 },
      { "COUNT(*)": 5527 },
    ]);
    expect(facts.hits).toEqual([]);
    expect(facts.rows).toEqual([{ path: "src/a.rs", n: 3 }, { path: "src/b.rs", start_line: "7", end_line: 9 }, { "COUNT(*)": 5527 }]);
    expect(facts.rowsTotal).toBe(3);
  });

  it("cuts a long string cell of an aggregate row at ROW_CELL_CHARS - a chunk's text without its place is not a fact to cite", () => {
    const long = "y".repeat(ROW_CELL_CHARS * 3);
    const { rows: out } = rows([{ content: long, n: 1 }, { path: "a.rs", short: "kept whole" }]);
    expect(ROW_CELL_CHARS).toBe(240);
    expect(out[0].content).toBe("y".repeat(ROW_CELL_CHARS) + "...");
    expect(out[0].n).toBe(1);
    expect(out[1]).toEqual({ path: "a.rs", short: "kept whole" });
  });

  it("ignores rows with nothing scalar, and the bm25 tool's _id/text/score rows become aggregate rows, not hits", () => {
    const facts = rows([{ embedding: [1, 2] }, null, "garbage", { _id: 12, text: "fn merge()", score: 1.5 }]);
    expect(facts.hits).toEqual([]);
    expect(facts.rows).toEqual([{ _id: 12, text: "fn merge()", score: 1.5 }]);
  });

  it("dedupes hits by path and start_line, keeping the first appearance, across lists in order", () => {
    const facts = rows(
      [chunkRow(1, "from the first list"), chunkRow(2)],
      [chunkRow(1, "from the second list"), { ...chunkRow(1), start_line: 99, content: "another chunk of f1" }],
    );
    expect(facts.hits.map((h) => `${h.path}:${h.startLine} ${h.content}`)).toEqual([
      "src/f1.ts:11 from the first list",
      "src/f2.ts:21 fn f2() {\n  body\n}",
      "src/f1.ts:99 another chunk of f1",
    ]);
    expect(facts.hitsTotal).toBe(3);
  });

  it("dedupes identical aggregate rows", () => {
    const facts = rows([{ path: "a", n: 1 }], [{ path: "a", n: 1 }, { path: "a", n: 2 }]);
    expect(facts.rows).toEqual([{ path: "a", n: 1 }, { path: "a", n: 2 }]);
    expect(facts.rowsTotal).toBe(2);
  });

  it("caps hits at MAX_HITS and rows at MAX_ROWS while counting everything seen", () => {
    const manyHits = Array.from({ length: MAX_HITS + 5 }, (_, i) => chunkRow(i));
    const manyRows = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ({ path: `p${i}`, n: i }));
    const facts = rows(manyHits, manyRows);
    expect(MAX_HITS).toBe(10); // search's default k
    expect(MAX_ROWS).toBe(50);
    expect(facts.hits).toHaveLength(MAX_HITS);
    expect(facts.hitsTotal).toBe(MAX_HITS + 5);
    expect(facts.rows).toHaveLength(MAX_ROWS);
    expect(facts.rowsTotal).toBe(MAX_ROWS + 3);
    expect(facts.hits[0].path).toBe("src/f0.ts");
    expect(facts.hits[MAX_HITS - 1].path).toBe(`src/f${MAX_HITS - 1}.ts`);
  });
});

// --- stepsFrom (the queries and their rows) --------------------------------------------------

describe("stepsFrom", () => {
  it("records the query of a search tool and the sql of query_sql, one field each, without rows in the queries", () => {
    const { result } = retrievalAgentRunFrom(
      QUESTION,
      answered({
        table: null,
        transcript: [
          toolCall("s1", "bm25_search", { query: "compaction merge", k: 5, column: "content" }),
          toolResult("s1", { rows: [{ _id: 1, text: "a", score: 1.5 }] }),
          toolCall("s2", "hybrid_search", { query: "how superfiles are merged", text_column: "content" }),
          toolResult("s2", { rows: [] }),
          toolCall("q1", "query_sql", { sql: "SELECT COUNT(*) FROM chunks" }),
          toolResult("q1", { rows: [{ "COUNT(*)": 5527 }] }),
        ],
      }),
    );
    expect(result.queries).toEqual([
      { tool: "bm25_search", query: "compaction merge" },
      { tool: "hybrid_search", query: "how superfiles are merged" },
      { tool: "query_sql", sql: "SELECT COUNT(*) FROM chunks" },
    ]);
    expect(JSON.stringify(result.queries)).not.toContain("5527");
    // ... but the rows those queries returned are the facts.
    expect(result.rows).toEqual([{ _id: 1, text: "a", score: 1.5 }, { "COUNT(*)": 5527 }]);
  });

  it("leaves final_answer out - the answer is not a query", () => {
    const steps = stepsFrom([
      toolCall("q1", "query_sql", { sql: "SELECT 1" }),
      toolResult("q1", { rows: [{ n: 1 }] }),
      toolCall("f1", "final_answer", { answer: "1" }),
      toolResult("f1", { ok: true }),
    ]);
    expect(steps.map((s) => s.query.tool)).toEqual(["query_sql"]);
  });

  it("lists a failed call's query and gives it no rows; a non-JSON body yields none either", () => {
    const steps = stepsFrom([
      toolCall("q1", "query_sql", { sql: "SELECT * FROM nope" }),
      toolResult("q1", { error: "table 'nope' not found" }),
      toolCall("q2", "query_sql", { sql: "SELECT 1" }),
      toolResult("q2", "engine said something odd"),
    ]);
    expect(steps).toEqual([
      { query: { tool: "query_sql", sql: "SELECT * FROM nope" }, rows: [] },
      { query: { tool: "query_sql", sql: "SELECT 1" }, rows: [] },
    ]);
  });

  it("pairs results by tool_call_id, not by position, and survives a missing result", () => {
    const steps = stepsFrom([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "query_sql", arguments: JSON.stringify({ sql: "SELECT a" }) } },
          { id: "b", type: "function", function: { name: "query_sql", arguments: JSON.stringify({ sql: "SELECT b" }) } },
        ],
      },
      toolResult("b", { rows: [{ b: 2 }] }),
      toolResult("a", { rows: [{ a: 1 }] }),
      toolCall("c", "query_sql", { sql: "SELECT c" }),
      // no result for c: the loop was cut off
    ]);
    expect(steps).toEqual([
      { query: { tool: "query_sql", sql: "SELECT a" }, rows: [{ a: 1 }] },
      { query: { tool: "query_sql", sql: "SELECT b" }, rows: [{ b: 2 }] },
      { query: { tool: "query_sql", sql: "SELECT c" }, rows: [] },
    ]);
  });

  it("reads arguments that arrive as an object rather than a JSON string", () => {
    const [step] = stepsFrom([
      { role: "assistant", tool_calls: [{ id: "x", function: { name: "query_sql", arguments: { sql: "SELECT 2" } } }] },
      toolResult("x", { rows: [{ n: 2 }] }),
    ]);
    expect(step.query.sql).toBe("SELECT 2");
    expect(step.rows).toEqual([{ n: 2 }]);
  });

  it("ignores system swaps, user nudges, and messages of unexpected shape", () => {
    const steps = stepsFrom([
      { role: "system", content: "a swapped system prompt" },
      { role: "user", content: "The turn budget ran out ..." },
      null,
      "garbage",
      { role: "assistant", content: "a bare reply" },
      { role: "assistant", tool_calls: [{ id: "n", function: { arguments: "{}" } }] }, // no name
      { role: "assistant", tool_calls: [{ id: "m", function: { name: "query_sql", arguments: "not json" } }] },
    ]);
    expect(steps).toEqual([{ query: { tool: "query_sql" }, rows: [] }]);
  });
});

// --- runRetrievalAgent ----------------------------------------------------------------------

describe("runRetrievalAgent", () => {
  it("asks sub_agent with the budget and the transcript, and returns the distilled run", async () => {
    const sent: unknown[] = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return answered();
      },
    };
    const { result, spend } = await runRetrievalAgent(hosted, { question: "which files?" }, { maxTurns: 4, maxWallSecs: 90 });
    expect(sent).toEqual([{ question: "which files?", max_turns: 4, max_wall_secs: 90, include_transcript: true }]);
    expect(result.question).toBe("which files?");
    expect(result.sql).toBe(STATEMENT);
    expect(result.rows).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    expect(result.hits).toHaveLength(3);
    expect(spend).toEqual({ promptTokens: 1200, completionTokens: 80 });
    expect((result as unknown as Record<string, unknown>).transcript).toBeUndefined();
  });

  it("propagates the client's error for a terminal platform failure", async () => {
    const hosted = {
      subAgent: async () => {
        throw new Error("sub_agent: server returned 501: the sub-agent is not configured on this deployment");
      },
    };
    await expect(runRetrievalAgent(hosted, { question: "q" }, { maxTurns: 4, maxWallSecs: 120 })).rejects.toThrow(/501/);
  });
});
