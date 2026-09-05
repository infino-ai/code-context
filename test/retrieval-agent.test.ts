// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The subagent tool's logic, without an MCP transport: how a sub_agent
// response - the facts, the statement, the coverage - becomes the tool
// result (hits and aggregate rows; never anything the model wrote), the
// no-facts reporting, and what runRetrievalAgent sends. No network.

import { describe, expect, it } from "vitest";
import {
  runRetrievalAgent,
  retrievalAgentRunFrom,
  factRowsOf,
  factsFrom,
  MAX_HITS,
  MAX_ROWS,
  HIT_CONTENT_CHARS,
  TERMINATE_ANSWERED,
  TERMINATE_ESCALATED,
  type RetrievalAgentResult,
} from "../src/core/retrieval-agent.js";

// --- fixtures: the platform's response shape ---------------------------------------------

/** A chunks-table row as a record, the shape the facts carry. */
const chunkRow = (i: number, content = `fn f${i}() {\n  body\n}`) => ({
  path: `src/f${i}.ts`,
  start_line: 10 * i + 1,
  end_line: 10 * i + 9,
  content,
});

/** The query the loop validated, and its first rows as the platform returns
 * them: one fact per row, the row a record. */
const STATEMENT = "SELECT path, COUNT(*) AS n FROM token_match('chunks','content','compaction') GROUP BY path ORDER BY n DESC";
const FACTS = [{ table: "chunks", row: { path: "src/f1.ts", n: 7 } }, { table: "chunks", row: { path: "src/f0.ts", n: 2 } }];
const COVERAGE = { rows_total: 2, rows_returned: 2, truncated: false };

/** A complete `answered` response, as the platform returns it. */
function answered(overrides: Record<string, unknown> = {}) {
  return {
    facts: FACTS,
    statement: STATEMENT,
    coverage: COVERAGE,
    terminate: "answered",
    turns: 1,
    retries: 0,
    card_tier: "lean",
    rung: 0,
    prompt_tokens: 1200,
    completion_tokens: 80,
    usage: [{ prompt_tokens: 400, completion_tokens: 30 }],
    model: "some-model",
    ...overrides,
  };
}

/** The same response with the loop finding no query. */
const unanswered = (terminate: string, extra: Record<string, unknown> = {}) =>
  answered({ facts: [], statement: null, coverage: { rows_total: 0, rows_returned: 0, truncated: false }, terminate, ...extra });

/** Facts that name places, with content - what a search-shaped statement returns. */
const PLACE_FACTS = [
  { table: "chunks", row: chunkRow(0) },
  { table: "chunks", row: chunkRow(1) },
];

const QUESTION = "which files mention compaction?";

// --- retrievalAgentRunFrom ------------------------------------------------------------

describe("retrievalAgentRunFrom", () => {
  it("returns the statement, its coverage, and the facts as aggregate rows - and nothing the model wrote", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered());
    expect(result).toEqual({
      question: QUESTION,
      sql: STATEMENT,
      coverage: { rowsTotal: 2, rowsReturned: 2, truncated: false },
      hits: [],
      rows: [
        { path: "src/f1.ts", n: 7 },
        { path: "src/f0.ts", n: 2 },
      ],
      hitsTotal: 0,
      rowsTotal: 2,
      turns: 1,
    });
    expect(result.error).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["coverage", "hits", "hitsTotal", "question", "rows", "rowsTotal", "sql", "turns"]);
  });

  it("turns facts that name places into hits with their content", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ facts: PLACE_FACTS, statement: "find('chunks', 'content', 'f0')" }));
    expect(result.sql).toBe("find('chunks', 'content', 'f0')");
    expect(result.hits).toEqual([
      { path: "src/f0.ts", startLine: 1, endLine: 9, content: "fn f0() {\n  body\n}" },
      { path: "src/f1.ts", startLine: 11, endLine: 19, content: "fn f1() {\n  body\n}" },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.hitsTotal).toBe(2);
  });

  it("keeps the loop's spend beside the result, not in it, and drops the platform's own fields", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ transcript: [{ role: "system", content: "the whole system prompt" }] }));
    expect(spend).toEqual({ promptTokens: 1200, completionTokens: 80 });
    const asRecord = result as RetrievalAgentResult & Record<string, unknown>;
    for (const dropped of ["facts", "statement", "model", "prompt_tokens", "completion_tokens", "terminate", "transcript", "usage", "retries", "card_tier", "rung"]) {
      expect(asRecord[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("the whole system prompt");
  });

  it("reports the platform's coverage when the query's result was cut", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ coverage: { rows_total: 100, rows_returned: 10, truncated: true } }));
    expect(result.coverage).toEqual({ rowsTotal: 100, rowsReturned: 10, truncated: true });
  });

  it("is ok (not an error) with no facts and the model's own account when the loop escalated", () => {
    const { result } = retrievalAgentRunFrom(
      QUESTION,
      unanswered(TERMINATE_ESCALATED, { turns: 4, retries: 3, error: "the table has no column naming a WAL; the question may be about another repository" }),
    );
    expect(result.sql).toBeUndefined();
    expect(result.hits).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.turns).toBe(4);
    expect(result.error).toBe(
      "the retrieval agent found no query that answers this: the table has no column naming a WAL; the question may be about another repository - ask again more narrowly, or use find or search",
    );
  });

  it("names the turn and wall caps, and carries the endpoint's words on an error termination", () => {
    expect(retrievalAgentRunFrom(QUESTION, unanswered("turn_cap")).result.error).toMatch(/ran out of turns without a query/);
    expect(retrievalAgentRunFrom(QUESTION, unanswered("wall_cap")).result.error).toMatch(/ran out of time/);
    const failed = retrievalAgentRunFrom(QUESTION, unanswered("error", { error: "401 from the model host" })).result;
    expect(failed.error).toBe("the retrieval agent's model endpoint failed: 401 from the model host - ask again more narrowly, or use find or search");
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

  it("defaults a missing or malformed numeric field to 0 instead of NaN", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ turns: "3", prompt_tokens: undefined, completion_tokens: Number.NaN }));
    expect(result.turns).toBe(0);
    expect(spend.promptTokens).toBe(0);
    expect(spend.completionTokens).toBe(0);
  });

  it("uses the terminate constants the platform serializes", () => {
    expect(TERMINATE_ANSWERED).toBe("answered");
    expect(TERMINATE_ESCALATED).toBe("escalated");
  });
});

// --- factRowsOf --------------------------------------------------------------------------------

describe("factRowsOf", () => {
  it("reads each fact's row and skips entries of another shape", () => {
    expect(factRowsOf(answered())).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    expect(factRowsOf({ facts: [{ row: { a: 1 } }, { row: [1, 2] }, "garbage", null, { table: "t" }] })).toEqual([{ a: 1 }]);
    expect(factRowsOf({ facts: null })).toEqual([]);
    expect(factRowsOf(null)).toEqual([]);
  });
});

// --- factsFrom --------------------------------------------------------------------------------

describe("factsFrom", () => {
  it("makes one hit per row carrying path, start_line and end_line, with the whole content and the descriptors", () => {
    const { hits } = factsFrom([{ ...chunkRow(4, "first line\nsecond line"), symbol: "f4", lang: "ts" }]);
    expect(hits).toEqual([{ path: "src/f4.ts", startLine: 41, endLine: 49, content: "first line\nsecond line", symbol: "f4", lang: "ts" }]);
  });

  it("cuts a hit's content at HIT_CONTENT_CHARS, the same cap a search hit has", () => {
    const long = "x".repeat(HIT_CONTENT_CHARS * 2);
    const { hits } = factsFrom([chunkRow(0, long)]);
    expect(HIT_CONTENT_CHARS).toBe(4000);
    expect(hits[0].content).toHaveLength(HIT_CONTENT_CHARS);
  });

  it("gives empty content to a row with only the place columns - the citation is the fact", () => {
    const { hits } = factsFrom([{ path: "a.ts", start_line: 1, end_line: 2 }]);
    expect(hits).toEqual([{ path: "a.ts", startLine: 1, endLine: 2, content: "" }]);
  });

  it("keeps rows that name no place as aggregate rows, scalar cells only", () => {
    const facts = factsFrom([
      { path: "src/a.rs", n: 3, embedding: [0.1, 0.2], meta: { k: 1 } },
      { path: "src/b.rs", start_line: "7", end_line: 9 },
      { "COUNT(*)": 5527 },
    ]);
    expect(facts.hits).toEqual([]);
    expect(facts.rows).toEqual([{ path: "src/a.rs", n: 3 }, { path: "src/b.rs", start_line: "7", end_line: 9 }, { "COUNT(*)": 5527 }]);
    expect(facts.rowsTotal).toBe(3);
  });

  it("ignores rows with nothing scalar", () => {
    const facts = factsFrom([{ embedding: [1, 2] }, null, "garbage", { _id: "12", text: "fn merge()", score: 1.5 }]);
    expect(facts.hits).toEqual([]);
    expect(facts.rows).toEqual([{ _id: "12", text: "fn merge()", score: 1.5 }]);
  });

  it("dedupes hits by path and start_line, keeping the first appearance", () => {
    const facts = factsFrom([chunkRow(1, "first"), chunkRow(2), chunkRow(1, "second"), { ...chunkRow(1), start_line: 99, content: "another chunk of f1" }]);
    expect(facts.hits.map((h) => `${h.path}:${h.startLine} ${h.content}`)).toEqual([
      "src/f1.ts:11 first",
      "src/f2.ts:21 fn f2() {\n  body\n}",
      "src/f1.ts:99 another chunk of f1",
    ]);
    expect(facts.hitsTotal).toBe(3);
  });

  it("dedupes identical aggregate rows", () => {
    const facts = factsFrom([{ path: "a", n: 1 }, { path: "a", n: 1 }, { path: "a", n: 2 }]);
    expect(facts.rows).toEqual([{ path: "a", n: 1 }, { path: "a", n: 2 }]);
    expect(facts.rowsTotal).toBe(2);
  });

  it("caps hits at MAX_HITS and rows at MAX_ROWS while counting everything seen", () => {
    const manyHits = Array.from({ length: MAX_HITS + 5 }, (_, i) => chunkRow(i));
    const manyRows = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ({ path: `p${i}`, n: i }));
    const facts = factsFrom([...manyHits, ...manyRows]);
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

// --- runRetrievalAgent ----------------------------------------------------------------------

describe("runRetrievalAgent", () => {
  it("asks sub_agent for MAX_HITS facts carrying the placing columns, with the budget - no transcript - and returns them", async () => {
    const sent: unknown[] = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return answered();
      },
    };
    const { result, spend } = await runRetrievalAgent(hosted, { question: "which files?" }, { maxTurns: 4, maxWallSecs: 90 });
    expect(sent).toEqual([{ question: "which files?", k: MAX_HITS, projection: ["path", "start_line", "end_line"], max_turns: 4, max_wall_secs: 90 }]);
    expect(result.question).toBe("which files?");
    expect(result.sql).toBe(STATEMENT);
    expect(result.rows).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    expect(spend).toEqual({ promptTokens: 1200, completionTokens: 80 });
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
