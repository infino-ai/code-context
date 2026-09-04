// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The retrieval_agent tool's logic, without an MCP transport: how a platform
// response becomes the tool result (answer, no-answer fallback, hits and
// queries distilled from the transcript, the spend kept beside it) and what
// runRetrievalAgent sends the client. No network.

import { describe, expect, it } from "vitest";
import {
  runRetrievalAgent,
  retrievalAgentRunFrom,
  stepsFrom,
  hitsFrom,
  MAX_HITS,
  HIT_TEXT_CHARS,
  TERMINATE_ANSWERED,
  type RetrievalAgentResult,
} from "../src/core/retrieval-agent.js";

// --- fixtures: the platform's AskResponse and transcript shapes ------------------

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

/** A complete `answered` response, as the worker serializes AskResponse. */
function answered(overrides: Record<string, unknown> = {}) {
  return {
    answer: "3 files",
    terminate: "answered",
    turns: 3,
    answer_retries: 0,
    bare_reply: false,
    card_tier: "lean",
    rung: 0,
    prompt_tokens: 1200,
    completion_tokens: 80,
    usage: [{ prompt_tokens: 400, completion_tokens: 30, rung: 0 }],
    model: "openai/gpt-oss-120b",
    transcript: [
      { role: "system", content: "You answer questions about a database ... <the whole table card>" },
      { role: "user", content: "which files mention compaction?" },
      toolCall("c1", "query_sql", { sql: "SELECT path, start_line, end_line, content FROM chunks LIMIT 3" }),
      toolResult("c1", chunkRows(3)),
      toolCall("c2", "final_answer", { answer: "3 files" }),
      toolResult("c2", { ok: true }),
    ],
    ...overrides,
  };
}

const QUESTION = "which files mention compaction?";

// --- retrievalAgentRunFrom ------------------------------------------------------------

describe("retrievalAgentRunFrom", () => {
  it("returns the question, the answer, the hits and the queries, shaped like the other tools", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered());
    expect(result).toEqual({
      question: QUESTION,
      answer: "3 files",
      hits: [
        { path: "src/f0.ts", startLine: 1, endLine: 9, text: "fn f0() {" },
        { path: "src/f1.ts", startLine: 11, endLine: 19, text: "fn f1() {" },
        { path: "src/f2.ts", startLine: 21, endLine: 29, text: "fn f2() {" },
      ],
      queries: [{ tool: "query_sql", sql: "SELECT path, start_line, end_line, content FROM chunks LIMIT 3" }],
      turns: 3,
      model: "openai/gpt-oss-120b",
    });
    expect(result.error).toBeUndefined();
  });

  it("keeps the loop's spend beside the result, not in it", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered());
    expect(spend).toEqual({ promptTokens: 1200, completionTokens: 80, rung: 0, cardTier: "lean" });
    const asRecord = result as RetrievalAgentResult & Record<string, unknown>;
    for (const dropped of ["rung", "card_tier", "prompt_tokens", "completion_tokens", "evidence", "terminate", "transcript", "usage"]) {
      expect(asRecord[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("the whole table card");
    expect(Object.keys(result).sort()).toEqual(["answer", "hits", "model", "queries", "question", "turns"]);
  });

  it("is ok (not an error) with answer null and a reason when the loop hit its turn cap", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ answer: null, terminate: "turn_cap", turns: 8 }));
    expect(result.answer).toBeNull();
    expect(result.error).toMatch(/ran out of turns/);
    expect(result.error).toMatch(/fall back to search or sql/);
    expect(result.turns).toBe(8);
    // The hits and queries still come back: what it found is useful without an answer.
    expect(result.hits).toHaveLength(3);
    expect(result.queries).toHaveLength(1);
  });

  it("names the wall cap and carries the endpoint's own words on an error termination", () => {
    expect(retrievalAgentRunFrom(QUESTION, answered({ answer: null, terminate: "wall_cap" })).result.error).toMatch(/ran out of time/);
    const failed = retrievalAgentRunFrom(QUESTION, answered({ answer: null, terminate: "error", error: "401 from the model host" })).result;
    expect(failed.answer).toBeNull();
    expect(failed.error).toBe("the retrieval agent's model endpoint failed: 401 from the model host - fall back to search or sql");
  });

  it("drops an answer that arrives with a non-answered terminate rather than trusting it", () => {
    // The platform never sends this pair, but a stale answer with a cap
    // termination must not be shown as if it were accepted.
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ answer: "stale", terminate: "turn_cap" }));
    expect(result.answer).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("reports an answered loop that sent no text instead of inventing one", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ answer: null }));
    expect(result.answer).toBeNull();
    expect(result.error).toMatch(/reported an answer but sent none/);
  });

  it("describes an unknown terminate value verbatim", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ answer: null, terminate: "budget_exceeded" }));
    expect(result.error).toMatch(/"budget_exceeded"/);
  });

  it("throws on a body that is not an agent response", () => {
    expect(() => retrievalAgentRunFrom(QUESTION, { rows: [] })).toThrow(/not an agent result/);
    expect(() => retrievalAgentRunFrom(QUESTION, null)).toThrow(/not an agent result/);
    expect(() => retrievalAgentRunFrom(QUESTION, "plain text")).toThrow(/not an agent result/);
  });

  it("tolerates a response without a transcript (gateway stripped it)", () => {
    const { transcript: _dropped, ...noTranscript } = answered();
    const { result } = retrievalAgentRunFrom(QUESTION, noTranscript);
    expect(result.answer).toBe("3 files");
    expect(result.hits).toEqual([]);
    expect(result.queries).toEqual([]);
  });

  it("defaults a missing or malformed numeric field to 0 instead of NaN", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ turns: "3", prompt_tokens: undefined, rung: Number.NaN }));
    expect(result.turns).toBe(0);
    expect(spend.promptTokens).toBe(0);
    expect(spend.rung).toBe(0);
  });

  it("uses the terminate constant the platform serializes", () => {
    expect(TERMINATE_ANSWERED).toBe("answered");
  });
});

// --- hitsFrom -------------------------------------------------------------------------------

describe("hitsFrom", () => {
  const steps = (transcript: unknown[]) => stepsFrom(transcript);

  it("makes one hit per row carrying path, start_line and end_line, text = the content's first line", () => {
    const hits = hitsFrom(steps([toolCall("c1", "query_sql", { sql: "SELECT ..." }), toolResult("c1", { rows: [chunkRow(4, "first line\nsecond line")] })]));
    expect(hits).toEqual([{ path: "src/f4.ts", startLine: 41, endLine: 49, text: "first line" }]);
  });

  it("cuts a hit's text at HIT_TEXT_CHARS", () => {
    const long = "x".repeat(HIT_TEXT_CHARS * 3);
    const [hit] = hitsFrom(steps([toolCall("c1", "query_sql", { sql: "S" }), toolResult("c1", { rows: [chunkRow(0, long)] })]));
    expect(hit.text).toHaveLength(HIT_TEXT_CHARS);
    expect(hit.text).toBe("x".repeat(HIT_TEXT_CHARS));
  });

  it("renders the other scalar columns compactly when a row has no content (an aggregate)", () => {
    const [hit] = hitsFrom(
      steps([
        toolCall("c1", "query_sql", { sql: "SELECT path, start_line, end_line, symbol, lang, COUNT(*) AS n ..." }),
        toolResult("c1", { rows: [{ path: "src/a.rs", start_line: 5, end_line: 40, symbol: "merge", lang: "rs", n: 7, embedding: [0.1, 0.2], meta: { k: 1 } }] }),
      ]),
    );
    // Vectors and nested objects are not scalar and stay out of the text.
    expect(hit).toEqual({ path: "src/a.rs", startLine: 5, endLine: 40, text: "symbol=merge, lang=rs, n=7" });
  });

  it("gives an empty text to a row with only the place columns", () => {
    const [hit] = hitsFrom(steps([toolCall("c1", "query_sql", { sql: "S" }), toolResult("c1", { rows: [{ path: "a.ts", start_line: 1, end_line: 2 }] })]));
    expect(hit).toEqual({ path: "a.ts", startLine: 1, endLine: 2, text: "" });
  });

  it("ignores rows without a path or a line range - the bm25 tool's _id/text/score rows, aggregates by path only", () => {
    const hits = hitsFrom(
      steps([
        toolCall("s1", "bm25_search", { query: "compaction merge", k: 5, column: "content" }),
        toolResult("s1", { rows: [{ _id: 12, text: "fn merge()", score: 1.5 }] }),
        toolCall("q1", "query_sql", { sql: "SELECT path, COUNT(*) AS n FROM chunks GROUP BY path" }),
        toolResult("q1", { rows: [{ path: "src/a.rs", n: 3 }, { path: "src/b.rs", start_line: "7", end_line: 9 }] }),
        toolCall("q2", "query_sql", { sql: "SELECT COUNT(*) FROM chunks" }),
        toolResult("q2", { rows: [{ "COUNT(*)": 5527 }] }),
      ]),
    );
    expect(hits).toEqual([]);
  });

  it("dedupes by path and start_line, keeping the first appearance", () => {
    const hits = hitsFrom(
      steps([
        toolCall("q1", "query_sql", { sql: "A" }),
        toolResult("q1", { rows: [chunkRow(1, "from the first query"), chunkRow(2)] }),
        toolCall("q2", "query_sql", { sql: "B" }),
        toolResult("q2", { rows: [chunkRow(1, "from the second query"), { ...chunkRow(1), start_line: 99, content: "another chunk of f1" }] }),
      ]),
    );
    expect(hits).toEqual([
      { path: "src/f1.ts", startLine: 11, endLine: 19, text: "from the first query" },
      { path: "src/f2.ts", startLine: 21, endLine: 29, text: "fn f2() {" },
      { path: "src/f1.ts", startLine: 99, endLine: 19, text: "another chunk of f1" },
    ]);
  });

  it("caps the list at MAX_HITS across results, in transcript order", () => {
    const hits = hitsFrom(
      steps([
        toolCall("q1", "query_sql", { sql: "A" }),
        toolResult("q1", chunkRows(25)),
        toolCall("q2", "query_sql", { sql: "B" }),
        toolResult("q2", { rows: [chunkRow(100)] }),
      ]),
    );
    expect(MAX_HITS).toBe(20);
    expect(hits).toHaveLength(MAX_HITS);
    expect(hits[0].path).toBe("src/f0.ts");
    expect(hits[MAX_HITS - 1].path).toBe(`src/f${MAX_HITS - 1}.ts`);
    expect(hits.some((h) => h.path === "src/f100.ts")).toBe(false);
  });

  it("reads nothing from a failed call or a non-JSON tool body", () => {
    const hits = hitsFrom(
      steps([
        toolCall("q1", "query_sql", { sql: "SELECT * FROM nope" }),
        toolResult("q1", { error: "table 'nope' not found" }),
        toolCall("q2", "query_sql", { sql: "SELECT 1" }),
        toolResult("q2", "engine said something odd"),
      ]),
    );
    expect(hits).toEqual([]);
  });
});

// --- stepsFrom (the queries) --------------------------------------------------------------

describe("stepsFrom", () => {
  it("records the query of a search tool and the sql of query_sql, one field each, without rows", () => {
    const { result } = retrievalAgentRunFrom(
      QUESTION,
      answered({
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

  it("lists a failed call's query and gives it no rows", () => {
    const [step] = stepsFrom([toolCall("q1", "query_sql", { sql: "SELECT * FROM nope" }), toolResult("q1", { error: "table 'nope' not found" })]);
    expect(step).toEqual({ query: { tool: "query_sql", sql: "SELECT * FROM nope" }, rows: [] });
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
      { role: "system", content: "enriched card", rung: 1, model: "stronger" },
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
  it("asks for the transcript with the contract and budget, and returns the distilled run", async () => {
    const sent: unknown[] = [];
    const hosted = {
      ask: async (req: unknown) => {
        sent.push(req);
        return answered();
      },
    };
    const { result, spend } = await runRetrievalAgent(hosted, { question: "which files?", answer: "scalar" }, { maxTurns: 6, maxWallSecs: 90 });
    expect(sent).toEqual([{ question: "which files?", answer: "scalar", max_turns: 6, max_wall_secs: 90, include_transcript: true }]);
    expect(result.question).toBe("which files?");
    expect(result.answer).toBe("3 files");
    expect(result.hits).toHaveLength(3);
    expect(spend.cardTier).toBe("lean");
    expect((result as unknown as Record<string, unknown>).transcript).toBeUndefined();
  });

  it("propagates the client's error for a terminal platform failure", async () => {
    const hosted = {
      ask: async () => {
        throw new Error("ask: server returned 501: ask is not configured on this deployment");
      },
    };
    await expect(runRetrievalAgent(hosted, { question: "q", answer: "text" }, { maxTurns: 8, maxWallSecs: 120 })).rejects.toThrow(/501/);
  });
});
