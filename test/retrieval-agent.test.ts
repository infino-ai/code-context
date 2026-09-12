// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The ask tool's logic, without an MCP transport: how a sub_agent
// response - the facts, the statement, the coverage - becomes the tool
// result (hits and aggregate rows; never anything the model wrote), the
// no-facts reporting, and what runRetrievalAgent sends. No network.

import { describe, expect, it } from "vitest";
import {
  runRetrievalAgent,
  runExploreAgent,
  exploreRunFrom,
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
import { SNIPPET_CHARS, tableShapeFrom } from "../src/core/table-shape.js";

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

/** A complete `answered` response, as the platform returns it: the
 * SubAgentResponse fields and nothing about the platform's own costs beyond
 * the one metered number. */
function answered(overrides: Record<string, unknown> = {}) {
  return {
    facts: FACTS,
    statement: STATEMENT,
    coverage: COVERAGE,
    terminate: "answered",
    turns: 1,
    retries: 0,
    model_tokens: 1280,
    ...overrides,
  };
}

/** The same response with the loop finding no query. */
const unanswered = (terminate: string, extra: Record<string, unknown> = {}) =>
  answered({ facts: [], statement: null, coverage: { rows_total: 0, rows_returned: 0, truncated: false }, terminate, ...extra });

describe("an answer whose audit could not run", () => {
  it("carries the platform's reason as `unaudited`, and nothing when the audit ran", () => {
    const flagged = retrievalAgentRunFrom("q", answered({ unaudited: "the audit provider refused the call" })).result;
    expect(flagged.unaudited).toBe("the audit provider refused the call");
    expect(flagged.error).toBeUndefined();
    const bare = retrievalAgentRunFrom("q", answered({ unaudited: true })).result;
    expect(bare.unaudited).toBe("the platform did not say why");
    const audited = retrievalAgentRunFrom("q", answered()).result;
    expect(audited).not.toHaveProperty("unaudited");
    // a false or empty value means the audit ran
    expect(retrievalAgentRunFrom("q", answered({ unaudited: false })).result).not.toHaveProperty("unaudited");
    expect(retrievalAgentRunFrom("q", answered({ unaudited: "" })).result).not.toHaveProperty("unaudited");
  });
});

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
    // Each line carries its own number in the file, counted from the row's
    // start line - so f1's chunk, which begins at line 11, numbers 11-13.
    expect(result.hits).toEqual([
      { path: "src/f0.ts", startLine: 1, endLine: 9, content: "1: fn f0() {\n2:   body\n3: }" },
      { path: "src/f1.ts", startLine: 11, endLine: 19, content: "11: fn f1() {\n12:   body\n13: }" },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.hitsTotal).toBe(2);
  });

  it("keeps the loop's spend beside the result, not in it, and drops the platform's own fields", () => {
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ transcript: [{ role: "system", content: "the whole system prompt" }] }));
    expect(spend).toEqual({ modelTokens: 1280 });
    const asRecord = result as RetrievalAgentResult & Record<string, unknown>;
    for (const dropped of ["facts", "statement", "model_tokens", "terminate", "transcript", "retries"]) {
      expect(asRecord[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("the whole system prompt");
  });

  it("reads the spend from model_tokens alone: fields of an older response shape count for nothing", () => {
    const older = answered({ model_tokens: undefined, prompt_tokens: 1200, completion_tokens: 80, usage: [{ prompt_tokens: 400, completion_tokens: 30 }], rung: 1, model: "m" });
    expect(retrievalAgentRunFrom(QUESTION, older).spend).toEqual({ modelTokens: 0 });
    expect(JSON.stringify(retrievalAgentRunFrom(QUESTION, older))).not.toContain("\"m\"");
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
    expect(retrievalAgentRunFrom(QUESTION, unanswered("turn_cap")).result.error).toMatch(/ran out of turns without an answer/);
    expect(retrievalAgentRunFrom(QUESTION, unanswered("wall_cap")).result.error).toMatch(/ran out of time without an answer/);
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
    const { result, spend } = retrievalAgentRunFrom(QUESTION, answered({ turns: "3", model_tokens: Number.NaN }));
    expect(result.turns).toBe(0);
    expect(spend.modelTokens).toBe(0);
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
    expect(hits).toEqual([
      { path: "src/f4.ts", startLine: 41, endLine: 49, content: "41: first line\n42: second line", symbol: "f4", lang: "ts" },
    ]);
  });

  it("cuts a hit's content at HIT_CONTENT_CHARS, the same cap a search hit has", () => {
    const long = "x".repeat(HIT_CONTENT_CHARS * 2);
    const { hits } = factsFrom([chunkRow(0, long)]);
    expect(HIT_CONTENT_CHARS).toBe(4000);
    // The cap bounds the code, and the line numbers are added after it, so
    // the prefixes never cost a hit any of the chunk it carries. Strip them
    // back off and exactly the cap's worth of code is there.
    const code = hits[0].content
      .split("\n")
      .map((line) => line.replace(/^\d+: /, ""))
      .join("\n");
    expect(code).toHaveLength(HIT_CONTENT_CHARS);
    expect(hits[0].content.length).toBeGreaterThan(HIT_CONTENT_CHARS);
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
      "src/f1.ts:11 11: first",
      "src/f2.ts:21 21: fn f2() {\n22:   body\n23: }",
      "src/f1.ts:99 99: another chunk of f1",
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

// --- facts over a table of another shape ---------------------------------------------------

describe("facts over a table of another shape", () => {
  /** A hydrated table: a key, a scalar, a long HTML text, a list, and the
   * platform's embedding. */
  const JOBS = tableShapeFrom("jobs", [
    { name: "id", type: "utf8" },
    { name: "department", type: "utf8" },
    { name: "description_html", type: "large_utf8" },
    { name: "locations", type: "list", item: "utf8" },
    { name: "emb", type: "embedding", source: ["description_html"] },
  ]);

  /** A whole job description as stored: entity-escaped HTML, thousands of
   * characters of it. */
  const LONG_HTML = `&lt;ul&gt;${"&lt;li&gt;Own the platform&lt;/li&gt;".repeat(220)}&lt;/ul&gt;`;
  const FACT = { id: "j1", department: "Eng", description_html: LONG_HTML, locations: ["Paris, France", "Remote"], emb: [0.1, 0.2], score: 0.5 };

  it("renders every fact as a row of the table: the text a snippet, the list kept, the vector out, and no hits", () => {
    expect(LONG_HTML.length).toBeGreaterThanOrEqual(8_000);
    const facts = factsFrom([FACT], MAX_HITS, JOBS);
    expect(facts.hits).toEqual([]);
    expect(facts.hitsTotal).toBe(0);
    expect(facts.rowsTotal).toBe(1);
    const [row] = facts.rows;
    expect(Object.keys(row)).toEqual(["score", "id", "department", "locations", "description_html"]);
    expect(row).toMatchObject({ score: 0.5, id: "j1", department: "Eng", locations: ["Paris, France", "Remote"] });
    const text = String(row.description_html);
    expect(text.length).toBe(SNIPPET_CHARS + "...".length);
    expect(text.startsWith("Own the platform Own the platform")).toBe(true);
    expect(text).not.toContain("&lt;");
  });

  it("keeps the statement's own aliases - an aggregate's count is the fact", () => {
    const facts = factsFrom([{ department: "Eng", n: 42 }, { department: "Ops", n: 7 }], MAX_HITS, JOBS);
    expect(facts.rows).toEqual([{ department: "Eng", n: 42 }, { department: "Ops", n: 7 }]);
  });

  it("makes no hit of a row that happens to carry path and start_line: a row of such a table names no place in code", () => {
    const shape = tableShapeFrom("t", [
      { name: "path", type: "utf8" },
      { name: "start_line", type: "i32" },
      { name: "end_line", type: "i32" },
    ]);
    const facts = factsFrom([{ path: "a.ts", start_line: 1, end_line: 2 }], MAX_HITS, shape);
    expect(facts.hits).toEqual([]);
    expect(facts.rows).toEqual([{ path: "a.ts", start_line: 1, end_line: 2 }]);
  });

  it("without a shape the chunks rule stands as it was: whole strings kept, list cells dropped", () => {
    const facts = factsFrom([FACT]);
    expect(facts.rows).toEqual([{ id: "j1", department: "Eng", description_html: LONG_HTML, score: 0.5 }]);
  });

  it("hands the shape through runRetrievalAgent and runExploreAgent to the result", async () => {
    const hosted = { subAgent: async () => answered({ facts: [{ table: "jobs", row: FACT }], answer: "Eng owns it", chain: ["SELECT ..."] }) };
    const asked = await runRetrievalAgent(hosted, { question: "q", projection: ["id"], shape: JOBS }, { maxWallSecs: 90 });
    const explored = await runExploreAgent(hosted, { question: "q", projection: ["id"], shape: JOBS }, { maxWallSecs: 300 });
    for (const { result } of [asked, explored]) {
      expect(result.hits).toEqual([]);
      expect(result.rows).toHaveLength(1);
      expect(String(result.rows[0].description_html).length).toBe(SNIPPET_CHARS + "...".length);
      expect(result.rows[0].locations).toEqual(["Paris, France", "Remote"]);
    }
    expect(explored.result.answer).toBe("Eng owns it");
  });
});

// --- explore mode -----------------------------------------------------------------------------

describe("explore mode", () => {
  const CHAIN = ["SELECT ... FROM bm25_search('chunks','content','tombstone', 100)", "find(\"struct Tombstone\")"];
  const explored = (overrides: Record<string, unknown> = {}) =>
    answered({ facts: PLACE_FACTS, statement: CHAIN[1], answer: "Tombstones are written in ... and read in ...", chain: CHAIN, turns: 6, ...overrides });

  it("asks sub_agent in explore mode with the budget and returns the answer, the chain and the last query's facts", async () => {
    const sent: unknown[] = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return explored();
      },
    };
    const { result, spend } = await runExploreAgent(hosted, { question: "how do tombstones work?" }, { maxWallSecs: 300 });
    expect(sent).toEqual([{ question: "how do tombstones work?", mode: "explore", k: MAX_HITS, projection: ["path", "start_line", "end_line", "symbol"], max_wall_secs: 300 }]);
    expect(result.answer).toBe("Tombstones are written in ... and read in ...");
    expect(result.chain).toEqual(CHAIN);
    expect(result.sql).toBe(CHAIN[1]);
    expect(result.hits).toHaveLength(2);
    expect(result.turns).toBe(6);
    expect(result.error).toBeUndefined();
    expect(spend).toEqual({ modelTokens: 1280 });
  });

  it("hands the caller's context to sub_agent beside the question, in both modes, and never without one", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req as Record<string, unknown>);
        return explored();
      },
    };
    const context = "# CLAUDE.md\n\nThe manifest layer lives under src/supertable/manifest/.";
    await runExploreAgent(hosted, { question: "where is the manifest committed?", context }, { maxWallSecs: 300 });
    await runRetrievalAgent(hosted, { question: "where is the manifest committed?", context }, { maxWallSecs: 90 });
    await runRetrievalAgent(hosted, { question: "and without any" }, { maxWallSecs: 90 });
    expect(sent.map((r) => r.context)).toEqual([context, context, undefined]);
    // The question is the question: the context is a field beside it, not
    // folded into it, so the platform anchors validation on the question alone.
    expect(sent.map((r) => r.question)).toEqual(["where is the manifest committed?", "where is the manifest committed?", "and without any"]);
    expect("context" in sent[2]).toBe(false);
  });

  it("lowers the platform's explore budget only when the budget names a turn cap", async () => {
    const sent: unknown[] = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return explored();
      },
    };
    await runExploreAgent(hosted, { question: "q" }, { maxTurns: 12, maxWallSecs: 300, k: 25 });
    expect(sent[0]).toMatchObject({ mode: "explore", max_turns: 12, k: 25 });
  });

  it("reports a turn-capped exploration with the chain and facts it read, and no answer", () => {
    const { result } = exploreRunFrom("q", explored({ answer: undefined, terminate: "turn_cap" }));
    expect(result.answer).toBeUndefined();
    expect(result.chain).toEqual(CHAIN);
    expect(result.hits).toHaveLength(2);
    expect(result.error).toMatch(/ran out of turns without an answer - the facts and chain are what it read/);
  });

  it("keeps retrieve mode facts-only: a stray answer or chain in a retrieve response never reaches the result", () => {
    const { result } = retrievalAgentRunFrom(QUESTION, answered({ answer: "prose that should not pass", chain: ["x"] }));
    expect(result).not.toHaveProperty("answer");
    expect(result).not.toHaveProperty("chain");
    expect(JSON.stringify(result)).not.toContain("prose that should not pass");
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
    expect(sent).toEqual([{ question: "which files?", k: MAX_HITS, projection: ["path", "start_line", "end_line", "symbol"], max_turns: 4, max_wall_secs: 90 }]);
    expect(result.question).toBe("which files?");
    expect(result.sql).toBe(STATEMENT);
    expect(result.rows).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    expect(spend).toEqual({ modelTokens: 1280 });
  });

  it("asks for the budget's k when one is given and keeps that many hits", async () => {
    const sent: unknown[] = [];
    const many = Array.from({ length: 30 }, (_, i) => ({ table: "chunks", row: chunkRow(i) }));
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return answered({ facts: many, statement: "SELECT ...", coverage: { rows_total: 30, rows_returned: 30, truncated: false } });
      },
    };
    const { result } = await runRetrievalAgent(hosted, { question: "q" }, { maxTurns: 4, maxWallSecs: 90, k: 25 });
    expect((sent[0] as { k: number }).k).toBe(25);
    expect(result.hits).toHaveLength(25);
    expect(result.hitsTotal).toBe(30);
  });

  it("marks the coverage ranked when the platform says what ranked the facts, and only then", () => {
    const ranked = retrievalAgentRunFrom(QUESTION, answered({ coverage: { ...COVERAGE, ranker: "some-ranker" } })).result;
    expect(ranked.coverage).toEqual({ rowsTotal: 2, rowsReturned: 2, truncated: false, ranked: true });
    const unranked = retrievalAgentRunFrom(QUESTION, answered()).result;
    expect(unranked.coverage).toEqual({ rowsTotal: 2, rowsReturned: 2, truncated: false });
    expect(JSON.stringify(ranked)).not.toContain("some-ranker");
  });

  it("sends the caller's projection in place of the chunks table's, and no projection at all for an empty one", async () => {
    // A table of another shape has no path or start_line: the platform
    // refuses a projection naming no column of any table, so the caller
    // names the column that keys its rows - or nothing, when the engine's
    // row id is all the table has, and the platform then supplies that.
    const sent: Array<Record<string, unknown>> = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req as Record<string, unknown>);
        return answered();
      },
    };
    await runRetrievalAgent(hosted, { question: "q", projection: ["id"] }, { maxWallSecs: 90 });
    await runExploreAgent(hosted, { question: "q", projection: ["id"] }, { maxWallSecs: 300 });
    await runRetrievalAgent(hosted, { question: "q", projection: [] }, { maxWallSecs: 90 });
    expect(sent[0].projection).toEqual(["id"]);
    expect(sent[1].projection).toEqual(["id"]);
    expect("projection" in sent[2]).toBe(false);
  });

  it("sends no max_turns when the budget leaves it to the platform", async () => {
    const sent: unknown[] = [];
    const hosted = {
      subAgent: async (req: unknown) => {
        sent.push(req);
        return answered();
      },
    };
    await runRetrievalAgent(hosted, { question: "q" }, { maxWallSecs: 90 });
    expect(sent[0]).not.toHaveProperty("max_turns");
    expect(sent[0]).not.toHaveProperty("mode");
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

// --- `under`: one question, one subtree -------------------------------------------------------

describe("a question scoped to a subtree", () => {
  /** A platform client that records every request it is handed. */
  const recorder = () => {
    const sent: Array<Record<string, unknown>> = [];
    return {
      sent,
      subAgent: async (req: unknown) => {
        sent.push(req as Record<string, unknown>);
        return answered();
      },
    };
  };

  /** The scope as the loop is told it. The sub_agent request has no path
   * field, so this sentence IS the scope - an instruction the loop is asked to
   * hold to, never a filter the platform applies. */
  const SCOPE =
    "Scope: answer only from files whose repo-relative path starts with `src/superfile` - ignore everything outside that prefix.";

  it("travels to the platform as a context constraint naming the prefix, and changes nothing else in the request", async () => {
    const hosted = recorder();
    await runRetrievalAgent(hosted, { question: "how are superfiles built?", under: "src/superfile" }, { maxWallSecs: 90 });
    expect(hosted.sent).toEqual([
      {
        question: "how are superfiles built?",
        context: SCOPE,
        k: MAX_HITS,
        projection: ["path", "start_line", "end_line", "symbol"],
        max_wall_secs: 90,
      },
    ]);
  });

  it("names the table the question is about as the platform's `table` field, on both modes, and sends none when the request names none", async () => {
    // Unlike `under`, this is a filter the platform applies: the loop is shown
    // that table's card alone. On a database holding two code indexes the
    // unscoped loop answered every question about one from the other.
    const hosted = recorder();
    await runRetrievalAgent(hosted, { question: "q", table: "chunks_opensearch" }, { maxWallSecs: 90 });
    await runExploreAgent(hosted, { question: "q", table: "chunks_opensearch" }, { maxWallSecs: 300 });
    await runRetrievalAgent(hosted, { question: "q" }, { maxWallSecs: 90 });
    expect(hosted.sent[0]).toMatchObject({ table: "chunks_opensearch" });
    expect(hosted.sent[1]).toMatchObject({ table: "chunks_opensearch", mode: "explore" });
    expect(hosted.sent[2]).not.toHaveProperty("table");
  });

  it("sends no context at all when the call names no scope", async () => {
    const hosted = recorder();
    const { result } = await runRetrievalAgent(hosted, { question: "q" }, { maxWallSecs: 90 });
    expect(hosted.sent[0]).not.toHaveProperty("context");
    expect(result).not.toHaveProperty("under");
  });

  it("scopes an exploration the same way, and leaves an unscoped one without a context field", async () => {
    const whole = recorder();
    await runExploreAgent(whole, { question: "q" }, { maxWallSecs: 300 });
    expect(whole.sent[0]).not.toHaveProperty("context");

    const scoped = recorder();
    await runExploreAgent(scoped, { question: "q", under: "src/superfile" }, { maxWallSecs: 300 });
    expect(scoped.sent[0]).toMatchObject({ context: SCOPE, mode: "explore" });
  });

  it("adds the scope to the repository's own instructions rather than replacing them", async () => {
    // Both are background the loop reads beside the question, so a scoped
    // call must not cost the caller the instructions it would otherwise get.
    const context = "# CLAUDE.md\n\nThe manifest layer lives under src/supertable/manifest/.";
    const hosted = recorder();
    await runRetrievalAgent(hosted, { question: "q", context, under: "src/superfile" }, { maxWallSecs: 90 });
    expect(hosted.sent[0].context).toBe(`${context}\n\n${SCOPE}`);
  });

  it("echoes the scope on the result, so a subtree's facts are not read as the repository's", async () => {
    const { result } = await runRetrievalAgent(recorder(), { question: "q", under: "src/superfile" }, { maxWallSecs: 90 });
    expect(result.under).toBe("src/superfile");
    // The facts are whatever the platform returned: the scope is an
    // instruction to the loop, so nothing on this side filters them.
    expect(result.rows).toEqual([
      { path: "src/f1.ts", n: 7 },
      { path: "src/f0.ts", n: 2 },
    ]);
    const explored = await runExploreAgent(recorder(), { question: "q", under: "src" }, { maxWallSecs: 300 });
    expect(explored.result.under).toBe("src");
  });

  it("reads a prefix the way find reads its own: a trailing slash is the same scope", async () => {
    const hosted = recorder();
    const { result } = await runRetrievalAgent(hosted, { question: "q", under: "src/superfile/" }, { maxWallSecs: 90 });
    // Both spellings normalise to one scope on both doors, so a caller cannot
    // tell from either answer which one was typed.
    expect(hosted.sent[0]).toMatchObject({ context: SCOPE });
    expect(result.under).toBe("src/superfile");
  });

  it("refuses a prefix exactly where find refuses one - which is nowhere", async () => {
    // find validates no prefix at all: a leading slash or a `..` segment there
    // is a filter that matches nothing, not an error. `under` is one concept,
    // so a prefix that reaches find reaches the loop too, verbatim.
    const odd = recorder();
    const run = await runRetrievalAgent(odd, { question: "q", under: "/abs/../x" }, { maxWallSecs: 90 });
    expect(odd.sent[0]).toMatchObject({ context: expect.stringContaining("`/abs/../x`") });
    expect(run.result.under).toBe("/abs/../x");
  });

  it("scopes nothing when the prefix names no subtree, rather than sending an empty constraint", async () => {
    for (const nothing of ["", "/", "///"]) {
      const hosted = recorder();
      const { result } = await runRetrievalAgent(hosted, { question: "q", under: nothing }, { maxWallSecs: 90 });
      expect(hosted.sent[0]).not.toHaveProperty("context");
      expect(result).not.toHaveProperty("under");
    }
  });
});
