// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The chunks table under CX_REMOTE_SEARCH, end to end through the MCP server
// on an in-memory transport against a scripted platform: the path the live
// demo runs. The default table is never probed for its shape - it is the
// table this client builds, so its mode is chunks without asking - and
// startup reads the one card the sql description folds in, with no
// cold-start retries, so the MCP handshake is never held behind a platform
// that is cold or answering 503 at spawn (the third server below). After
// that find and plain sql are local tools that make NO platform request -
// not before their answer, not for it - while search reads the hosted index
// through the readiness memo by hybrid_search with the chunks table's own
// columns, and a sql statement that embeds a query goes to query_sql with
// its placeholder folded into the platform's own, its rows numbered as the
// local path numbers chunks - switch or no switch (the fourth server). Since
// 2026-09-12 - before that such a statement ran on the local index, which on
// a corpus whose local index was built keyword-only failed every
// hybrid_search the model wrote (OpenSearch, the side-by-side demo). The
// tool text is the chunks text. Auto-index is off here so a local door with
// no index answers "no index yet" rather than building one against the
// scripted platform; the point is where each door goes, not what it finds.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
delete process.env.CX_TABLE; // the default: the chunks table this client builds
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
process.env.CX_AUTO_INDEX = "0";
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { SQL_DESCRIPTION, PREFER_SEVERAL_ASKS, FIND_BY_BARE_NAME, indexFirst, findHint } = await import("../src/mcp/server.js");
const { API_KEY_ENV, MANIFEST_NAME, TABLE, DEFAULT_TABLE, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");

/** One chunk as the hosted search returns it. */
const CHUNK = { path: "src/a.ts", start_line: 1, end_line: 3, lang: "ts", symbol: "f", content: "fn f() {\n  body\n}", score: 0.5 };

/** The platform's own placeholder form, which `sql` folds a `{{q}}` and its
 * embed text into: the platform embeds the text with the table's model. */
const HOSTED_PLACEHOLDER = '{{q:"body"}}';

/** The longest a startup may take before it has plainly waited on the
 * platform: under the client's shortest retry wait (five seconds, when the
 * platform sends no Retry-After) and far under its cold-start budget (two
 * minutes), so a startup that took even one retry could not finish in it. */
const STARTUP_MS_MAX = 4_000;

/** The platform up, the chunks table there, no card computed for it yet, and
 * the hosted search and sql answering. No `schema` route: the default table
 * is not probed, and a probe would be the one unscripted request. The sql
 * route answers a ranking statement with a chunk (start_line beside content,
 * which the chunks path numbers) and anything else with a count. */
const up = () =>
  scriptPlatform({
    list_tables: () => [200, [TABLE]],
    table_card: () => [404, { error: `no lean card for table ${TABLE}` }],
    hybrid_search: () => [200, [CHUNK]],
    query_sql: (body) => (String(body?.query).includes("hybrid_search") ? [200, [{ ...CHUNK }]] : [200, [{ n: 7 }]]),
    validate: () => [200, { valid: true, check: "unchecked" }],
  });

/** The platform cold, or its worker dying, at the moment the server spawns:
 * every route answers 503 with no Retry-After - the answer the client would
 * otherwise retry for its whole cold-start budget. */
const cold = () => {
  const starting = (): [number, unknown] => [503, { error: "the database is starting" }];
  return scriptPlatform({ list_tables: starting, schema: starting, table_card: starting, hybrid_search: starting });
};

/** The chunks tool text, word for word: what every server here registers. */
async function expectChunksText(s: Started): Promise<void> {
  const { tools } = await s.client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
  expect(byName.get("sql")?.startsWith(SQL_DESCRIPTION)).toBe(true);
  expect(byName.get("sql")).toContain("'validation'");
  expect(byName.get("search")).toContain("Ranked code search fusing exact keyword matching with semantic similarity");
  expect(byName.get("find")).toContain("like grep -n");
  // A definition is found by its bare name with defines, never by a composed
  // signature (three such finds returned nothing on 2026-09-20 and the model
  // fell back to a regex grep).
  expect(byName.get("find")).toContain(FIND_BY_BARE_NAME);
  expect(byName.get("ask")).toContain("Ask the repository index");
  // The opening says what one call does and covers, before what comes back.
  expect(byName.get("ask")).toContain(
    "a read-only retrieval subagent chooses and runs the searches itself - keyword, hybrid, vector and SQL, as the question needs - over the whole repository",
  );
  // No explore: the tool that had the platform write the answer is gone (see
  // the note on `retrieve` in src/mcp/server.ts), and a line in the
  // instructions for a tool that is not there costs the caller a turn.
  expect(byName.has("explore")).toBe(false);
  const instructions = s.client.getInstructions() ?? "";
  expect(instructions).toContain("code-context is a local index of this repository");
  expect(instructions).not.toContain("- explore -");
  expect(instructions).toContain("- ask - a question or task in plain language");
  // The written answer's tool, and its routing line: without the install's
  // hook the model is told to relay the text exactly.
  expect(byName.get("answer")).toContain("Reply with that text exactly as returned, in full, and nothing else");
  expect(instructions).toContain(
    "- answer - REQUIRED after retrieving: never write the answer yourself. Once you have what the question needs, call answer with the question alone - the writer already has every row this server returned to you: it writes the answer from the rows; reply with its text exactly as returned",
  );
  expect(instructions).not.toContain("shows it to the user itself");
  expectSharedSentences(instructions);
  // The fan-out is a preference, told once in the instructions and once in
  // the tool's own text; "spawn several in parallel" only said it was allowed.
  expect(instructions).toContain(PREFER_SEVERAL_ASKS);
  expect(byName.get("ask")).toContain(PREFER_SEVERAL_ASKS);
  expect(instructions).not.toContain("Spawn several in parallel");
  // The index ranks ahead of the model's own file tools, and the sentence
  // names the four tools this server registers.
  expect(instructions).toContain(indexFirst(true));
  expect(instructions).toContain("find, search, sql and ask cover every file in one call");
}

/** The two sentences the hosted loop's answer writer is told, word for word,
 * in whatever instructions a model reads: what a citation is, and what a sweep
 * is. Pinned as text so a rewording here is a decision, not a drift. */
function expectSharedSentences(instructions: string): void {
  expect(instructions).toContain(
    "Cite the places your tool results gave you exactly as they gave them - the path and line numbers copied, never recalled or adjusted.",
  );
  expect(instructions).toContain(
    "Be efficient: prefer few, well-chosen tool calls, and hand a sweep across many files to a tool built for it rather than searching by hand.",
  );
}

describe("the hint on an empty find", () => {
  it("names the bare name with defines when a signature or phrase found nothing", () => {
    const hint = findHint("private void refresh(String source, SearcherScope scope, boolean block)", 0, false);
    expect(hint).toContain("No line holds this exact text.");
    expect(hint).toContain('query "refresh(", defines: true');
    expect(hint).toContain("use search");
    // A phrase with no call in it still points at defines and search.
    expect(findHint("Refresh the engine's searcher", 0, false)).toContain("find the bare name with defines");
  });
  it("doubts the name itself when defines found nothing for a bare identifier", () => {
    expect(findHint("maybeRefresh", 0, true)).toContain('Nothing declares "maybeRefresh"');
  });
  it("says nothing when a bare identifier is simply absent, or when anything matched", () => {
    expect(findHint("refresh(", 0, false)).toBeNull();
    expect(findHint("private void refresh(String source)", 3, false)).toBeNull();
    expect(findHint("maybeRefresh", 2, true)).toBeNull();
  });
});

/** No write reached the platform and no local index was built. */
function expectNothingBuilt(s: Started): void {
  const ops = s.sent.map((x) => x.op);
  for (const forbidden of ["drop_table", "create_table", "append", "delete", "update"]) {
    expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
  }
  expect(existsSync(join(s.root, ".infino", MANIFEST_NAME))).toBe(false);
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("the chunks table with the platform up", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(up(), "cx-chunks-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("read the one card at startup and nothing else: the default table is not probed for its shape", () => {
    expect(TABLE).toBe(DEFAULT_TABLE);
    expect(s.startup).toEqual(["table_card"]);
  });

  it("registered the chunks tool text, word for word", async () => {
    await expectChunksText(s);
  });

  it("find answers from the local side with no platform request at all", async () => {
    const { ok, value, ops } = await call(s, "find", { query: "body" });
    expect(ok).toBe(false);
    expect(value).toMatch(/^no index for .* yet - run `cx index`/);
    expect(ops).toEqual([]);
  });

  it("sql runs on the platform: a statement that embeds goes out with its placeholder folded into the platform's own, and its chunk rows come back numbered", async () => {
    const statement = `SELECT path, start_line, content FROM hybrid_search('${TABLE}','content','body','embedding', {{q}}, 30)`;
    const { ok, value, ops } = await call(s, "sql", { query: statement, embed: { q: "body" }, question: "where is body?" });
    expect(ok, String(value)).toBe(true);
    // The readiness memo, the statement, the verdict - and no local index:
    // there is none here, and the call did not need one.
    expect(ops).toEqual(["list_tables", "query_sql", "validate"]);
    const sent = s.sent.find((x) => x.op === "query_sql")?.body;
    expect(sent?.query).toBe(statement.replace("{{q}}", HOSTED_PLACEHOLDER));
    const result = value as { rows: Array<Record<string, unknown>>; index: string; validation?: Record<string, unknown>; usage?: string };
    expect(result.index).toBe("platform");
    expect(result.rows[0]).toMatchObject({ path: "src/a.ts", start_line: 1 });
    expect(result.rows[0].content).toBe("1: fn f() {\n2:   body\n3: }");
    expect(result.validation).toEqual({ valid: true, check: "unchecked" });
    expect(result.usage).toMatch(/1 row/);
  });

  it("sql runs a plain statement locally, switch or no switch: only what embeds leaves the machine", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `SELECT COUNT(*) AS n FROM ${TABLE}` });
    expect(ok).toBe(false);
    expect(value).toMatch(/^no index for .* yet - run `cx index`/);
    expect(ops).toEqual([]);
    expectNothingBuilt(s);
  });

  it("search lists the tables at most once across the tools, then hybrid_search over content and embedding with the chunks projection, as it always did", async () => {
    const first = await call(s, "search", { query: "body", k: 3 });
    expect(first.ok, String(first.value)).toBe(true);
    // The readiness memo is the context's, so sql's listing above serves
    // search as well.
    expect(first.ops).toEqual(["hybrid_search"]);
    const request = s.sent.find((x) => x.op === "hybrid_search")?.body;
    expect(request).toMatchObject({ table_name: TABLE, text_field: "content", vector_field: "embedding", text_query: "body", vector_text: "body", k: 3, mode: "Or" });
    expect(request?.projection).toEqual(["path", "start_line", "end_line", "lang", "symbol", "content", "score"]);
    const result = first.value as { index: string; ranking: string; hits: Array<Record<string, unknown>>; usage?: string };
    expect(result.index).toBe("platform");
    expect(result.ranking).toBe("hybrid");
    expect(result.hits[0]).toMatchObject({ path: "src/a.ts", startLine: 1, endLine: 3, lang: "ts", symbol: "f", score: 0.5 });
    expect(result.hits[0].content).toBe("1: fn f() {\n2:   body\n3: }");
    expect(result.usage).toMatch(/1 chunk \/ 1 file/);
    // The readiness memo holds: a second search is the search alone.
    const second = await call(s, "search", { query: "body", k: 3 });
    expect(second.ok).toBe(true);
    expect(second.ops).toEqual(["hybrid_search"]);
  });

  it("sent no write and left no manifest", () => {
    expectNothingBuilt(s);
  });
});

describe("the chunks table with CX_AGENT_TOOLS=0: the lane that hides ask", () => {
  let s: Started;
  beforeAll(async () => {
    // The env is read when the server starts, so it is set here and not at
    // the top of the file, where it would reach the other two servers.
    process.env.CX_AGENT_TOOLS = "0";
    s = await start(up(), "cx-chunks-noagent-");
  });
  afterAll(async () => {
    delete process.env.CX_AGENT_TOOLS;
    await stop(s);
  });

  it("does not register ask and does not name it in the instructions, while sql keeps its validation note", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("find");
    expect(names).toContain("search");
    expect(names).toContain("sql");
    expect(names).not.toContain("ask");
    expect(names).not.toContain("answer");
    expect(names).not.toContain("explore");
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("code-context is a local index of this repository");
    expect(instructions).not.toContain("- ask -");
    expect(instructions).not.toContain("- answer -");
    expect(instructions).not.toContain("- explore -");
    expectSharedSentences(instructions);
    // The index-first sentence names the three tools this lane has, not ask.
    expect(instructions).toContain(indexFirst(false));
    expect(instructions).toContain("find, search and sql cover every file in one call");
    expect(instructions).not.toContain("sql and ask cover");
    // The database is still configured: the sql text's platform-side note
    // and the startup card read are about sql, not about the loop.
    expect(tools.find((t) => t.name === "sql")?.description).toContain("'validation'");
    expect(s.startup).toEqual(["table_card"]);
  });
});

describe("the chunks table with CX_ANSWER_TOOL=0: the caller's model writes the answer", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_ANSWER_TOOL = "0";
    s = await start(up(), "cx-chunks-noanswer-");
  });
  afterAll(async () => {
    delete process.env.CX_ANSWER_TOOL;
    await stop(s);
  });

  it("keeps ask and drops answer, from the tool list and from the instructions alike", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ask");
    expect(names).not.toContain("answer");
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("- ask -");
    expect(instructions).not.toContain("- answer -");
    expect(instructions).not.toContain("never write the answer yourself");
    // The four retrieval tools are still the four; the index-first sentence
    // names ask among them.
    expect(instructions).toContain(indexFirst(true));
  });
});

/** The platform with its routes as tools: a card computed for the table, the
 * check and the citation pass answering. */
const CARD = { schema: [{ name: "path", index: "key" }, { name: "content", index: "fts" }], rows: 12, samples: [] };
const withApiRoutes = () =>
  scriptPlatform({
    list_tables: () => [200, [TABLE]],
    table_card: () => [200, { card: CARD, built_at: "2026-09-23T00:00:00Z" }],
    hybrid_search: () => [200, [CHUNK]],
    query_sql: () => [200, [{ n: 7 }]],
    validate: (body) => [200, { valid: (body?.rows as unknown[]).length > 0, check: "anchors", anchors: ["f"], rows: (body?.rows as unknown[]).length }],
    cite: (body) => [200, { answer: body?.answer, citations: 1, held: 1, rows_read: 3, model_tokens: 0 }],
  });

describe("the chunks table with CX_API_TOOLS=1 and no agent tools: the platform's routes as tools", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_API_TOOLS = "1";
    process.env.CX_AGENT_TOOLS = "0";
    s = await start(withApiRoutes(), "cx-chunks-api-");
  });
  afterAll(async () => {
    delete process.env.CX_API_TOOLS;
    delete process.env.CX_AGENT_TOOLS;
    await stop(s);
  });

  it("registers table_card, validate and cite beside find, search and sql, and names them; sql carries neither card nor verdict", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["find", "search", "sql", "table_card", "validate", "cite"]));
    expect(names).not.toContain("ask");
    expect(names).not.toContain("answer");
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).not.toContain("'validation'");
    expect(sql).not.toContain("The table's own measured shape");
    expect(sql).toContain("read the table's measured shape with table_card");
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("- table_card -");
    expect(instructions).toContain("- validate -");
    expect(instructions).toContain("- cite -");
    expect(instructions).not.toContain("- ask -");
    // The card was still read at startup for the sql text; under the tools
    // it is the model's to ask for, so nothing folds it in.
    expect(s.startup).toEqual(["table_card"]);
  });

  it("table_card returns the card, validate sends the question with the statement and rows, cite sends the draft", async () => {
    const card = await call(s, "table_card", {});
    expect(card.ok).toBe(true);
    expect(card.ops).toEqual(["table_card"]);
    expect(card.value).toEqual(CARD);

    const verdict = await call(s, "validate", { question: "where is f?", statement: "SELECT 1", rows: [{ path: "src/a.ts" }] });
    expect(verdict.ok).toBe(true);
    expect(verdict.ops).toEqual(["validate"]);
    expect(verdict.value).toMatchObject({ valid: true, check: "anchors", rows: 1 });
    const sent = s.sent.at(-1)?.body;
    expect(sent).toMatchObject({ table_name: TABLE, field_name: "content", statement: "SELECT 1", question: "where is f?", rows: [{ path: "src/a.ts" }] });

    const cited = await call(s, "cite", { answer: "f is at src/a.ts:1.", question: "where is f?" });
    expect(cited.ok).toBe(true);
    expect(cited.ops).toEqual(["cite"]);
    expect(cited.value).toMatchObject({ answer: "f is at src/a.ts:1.", held: 1 });
    expect(s.sent.at(-1)?.body).toMatchObject({ table_name: TABLE, field_name: "content", answer: "f is at src/a.ts:1.", question: "where is f?" });
  });

  it("a sql statement under the tools returns rows with no verdict attached", async () => {
    // A statement that embeds runs on the platform (the local index is not
    // built here); with the tools on, no validate follows it.
    const statement = `SELECT path FROM hybrid_search('${TABLE}','content','body','embedding', {{q}}, 30)`;
    const r = await call(s, "sql", { query: statement, embed: { q: "body" }, question: "where is body?" });
    expect(r.ok, String(r.value)).toBe(true);
    expect(r.ops).toContain("query_sql");
    expect(r.ops).not.toContain("validate");
    expect((r.value as Record<string, unknown>).validation).toBeUndefined();
  });
});

describe("the chunks table with CX_ANSWER_DISPLAY=hook: the install wrote the hook", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_ANSWER_DISPLAY = "hook";
    s = await start(up(), "cx-chunks-hook-");
  });
  afterAll(async () => {
    delete process.env.CX_ANSWER_DISPLAY;
    await stop(s);
  });

  it("tells the model the answer is shown to the user by the tool, and to say one sentence", async () => {
    const { tools } = await s.client.listTools();
    const answer = tools.find((t) => t.name === "answer")?.description ?? "";
    expect(answer).toContain("shown to the user directly by this tool");
    expect(answer).toContain("one short sentence");
    expect(answer).not.toContain("exactly as returned");
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("it writes the answer from the rows and shows it to the user itself; then reply with one short sentence and nothing else.");
    expect(instructions).not.toContain("exactly as returned");
  });
});

describe("the chunks table with the platform answering 503 at spawn", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(cold(), "cx-chunks-cold-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("came up at once: one card attempt, no retry, and the handshake never waited on the platform", () => {
    // The card is best-effort and fetched with no cold-start retries, and
    // the default table is not probed; a startup that retried either would
    // hold the MCP handshake for the cold-start budget - two minutes, past a
    // client's startup timeout - and the session would lose the local tools.
    expect(s.startup).toEqual(["table_card"]);
    expect(s.startupMs).toBeLessThan(STARTUP_MS_MAX);
  });

  it("registered the chunks tool text without a card", async () => {
    await expectChunksText(s);
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === "sql")?.description).not.toContain("The table's own measured shape");
  });

  it("find and plain sql are still the local tools, with no platform request", async () => {
    // Not a sql that embeds: that reads the hosted index, and against a
    // platform answering 503 it would wait the client's cold-start budget
    // out, as search would - which is the tool's behaviour, not this test's
    // subject.
    for (const [name, args] of [
      ["find", { query: "body" }],
      ["sql", { query: `SELECT COUNT(*) FROM ${TABLE}` }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { ok, value, ops } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(value, name).toMatch(/^no index for .* yet - run `cx index`/);
      expect(ops, name).toEqual([]);
    }
    expectNothingBuilt(s);
  });
});

describe("the chunks table without CX_REMOTE_SEARCH: only a statement that embeds leaves the machine", () => {
  let s: Started;
  beforeAll(async () => {
    // The switch is read when the server starts, so it is cleared here and
    // restored after, where it would otherwise reach no other server.
    delete process.env.CX_REMOTE_SEARCH;
    s = await start(up(), "cx-chunks-local-");
  });
  afterAll(async () => {
    process.env.CX_REMOTE_SEARCH = "1";
    await stop(s);
  });

  it("a statement with a {{q}} placeholder runs on the platform, which embeds it - the local side is lexical", async () => {
    const statement = `SELECT path FROM hybrid_search('${TABLE}','content','body','embedding', {{q}}, 30)`;
    const { ok, value, ops } = await call(s, "sql", { query: statement, embed: { q: "body" } });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["list_tables", "query_sql", "validate"]);
    expect(s.sent.find((x) => x.op === "query_sql")?.body?.query).toBe(statement.replace("{{q}}", HOSTED_PLACEHOLDER));
    expect((value as { index: string }).index).toBe("platform");
  });

  it("a plain statement stays local, with no platform request", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `SELECT COUNT(*) FROM ${TABLE}` });
    expect(ok).toBe(false);
    expect(value).toMatch(/^no index for .* yet - run `cx index`/);
    expect(ops).toEqual([]);
    expectNothingBuilt(s);
  });
});
