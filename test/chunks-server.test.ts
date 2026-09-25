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

const { SQL_DESCRIPTION, PREFER_SEVERAL_ASKS, FIND_BY_BARE_NAME, indexFirst, findHint, isLogIndex, logIndexInstructions } = await import("../src/mcp/server.js");
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

describe("an index of logs is told apart and gets its instructions in log words", () => {
  it("is a log index when more of its chunks are log windows than anything else", () => {
    expect(isLogIndex({ languages: { log: 4903 }, chunks: 4903 })).toBe(true);
    expect(isLogIndex({ languages: { log: 3000, other: 200 }, chunks: 3200 })).toBe(true);
    expect(isLogIndex({ languages: { ts: 5000, log: 12 }, chunks: 5012 })).toBe(false);
    expect(isLogIndex({ languages: { rs: 5539 }, chunks: 5539 })).toBe(false);
    expect(isLogIndex(undefined)).toBe(false);
  });

  it("names the logs, puts find and sql first, ask for the questions that span them, and says not to grep the files", () => {
    const text = logIndexInstructions(true, 35, 4903);
    expect(text).toContain("an index of the 35 log files in this directory");
    expect(text).toContain("4903 windows");
    expect(text).not.toContain("repository");
    expect(text).toContain("- find - every line in every log containing an exact string");
    expect(text).toContain("- sql - counts and rankings across the logs");
    expect(text).toContain("- ask - a question or task in plain language over all the logs");
    expect(text).toContain("Start with find or sql");
    expect(text).toContain("use ask for a question that spans the logs");
    expect(text).toContain("Do not open, read or grep the log files with Bash, Grep or Read");
    // The looking around is named as not needed, the lines are sql's too,
    // and a cut find is a flood to narrow, never a file for the shell.
    expect(text).toContain("Begin with these tools, not with ls or a look at the directory");
    expect(text).toContain("what fills a log, how often a pattern occurs, the kinds of error");
    expect(text).toContain("A find with a `more` list is a flood: every place is listed");
    expect(text).not.toContain("Read a file only");
    expectSharedSentences(text);
    // Without the agent tools there is no ask line and no ask in the order.
    const alone = logIndexInstructions(false, 35, 4903);
    expect(alone).not.toContain("- ask -");
    expect(alone).not.toContain("use ask");
    expect(alone).toContain("Start with find or sql");
  });
});

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

/** The platform with two sibling tables the primary may join: their schemas
 * and cards answered by name (the primary has no card), the cards saying
 * nothing about keys, join_keys answering with them, and query_sql
 * answering any statement. */
const ISSUES_FIELDS = [{ name: "instance_id", type: "utf8" }, { name: "project", type: "utf8" }, { name: "problem_statement", type: "large_utf8" }];
const LOGS_FIELDS = [{ name: "path", type: "utf8" }, { name: "start_line", type: "i64" }, { name: "content", type: "large_utf8" }, { name: "instance_id", type: "utf8" }, { name: "resolved", type: "utf8" }];
/** The joins as join_keys writes them: the logs' issue id into the issues,
 * and the code's first path segment against the issues' project. */
const LOGS_TO_ISSUES = { from_table: "chunks_swelogs", from_column: "instance_id", to_table: "swe_issues", to_column: "instance_id", inclusion: 1, coverage: 0.6, verified: false };
const CODE_TO_ISSUES = { from_table: TABLE, from_column: "path", from_expression: "split_part({column}, '/', 1)", to_table: "swe_issues", to_column: "project", inclusion: 1, coverage: 1, verified: false };
const siblingCard = (table: string, fields: Array<{ name: string; type: string }>) => ({
  card: { table, rows: 10, schema: fields.map((f) => ({ name: f.name, type: f.type, index: f.type === "large_utf8" ? "fts" : "scalar" })), sample_rows: [] },
  tier: "lean",
  built_ms: 1,
  storage_bytes: 1,
});
const withSiblings = () =>
  scriptPlatform({
    list_tables: () => [200, [TABLE, "swe_issues", "chunks_swelogs"]],
    schema: (body) => (body?.table_name === "swe_issues" ? [200, ISSUES_FIELDS] : body?.table_name === "chunks_swelogs" ? [200, LOGS_FIELDS] : [404, { error: "no such table" }]),
    // A card is the table's own shape and carries no key to any other table.
    table_card: (query) =>
      query?.table === "swe_issues"
        ? [200, siblingCard("swe_issues", ISSUES_FIELDS)]
        : query?.table === "chunks_swelogs"
        ? [200, siblingCard("chunks_swelogs", LOGS_FIELDS)]
        : [404, { error: "no card" }],
    // The route an agent calls before it writes a JOIN: the keys, each
    // once, with the predicate written out.
    join_keys: (body) =>
      Array.isArray(body?.tables) && (body.tables as string[]).length >= 2
        ? [200, { joins: [{ ...LOGS_TO_ISSUES, predicate: "chunks_swelogs.instance_id = swe_issues.instance_id" }, { ...CODE_TO_ISSUES, predicate: "split_part(chunks.path, '/', 1) = swe_issues.project" }], pairs: 3, counted: 0, model_tokens: 0 }]
        : [400, { error: "two tables at least" }],
    hybrid_search: () => [200, [CHUNK]],
    query_sql: () => [200, [{ project: "astropy__astropy", issues: 21, resolved: 10 }]],
    validate: () => [200, { valid: true, check: "unchecked" }],
  });

describe("the chunks table with CX_SIBLING_TABLES: the tables a statement may join", () => {
  let s: Started;
  beforeAll(async () => {
    process.env.CX_SIBLING_TABLES = "swe_issues,chunks_swelogs";
    // What a deployment may say about the siblings: what a value means. Never
    // a key - the keys are join_keys's to return.
    process.env.CX_SIBLING_NOTES = "chunks_swelogs.resolved is 'true' or 'false' per run.";
    s = await start(withSiblings(), "cx-chunks-siblings-");
  });
  afterAll(async () => {
    delete process.env.CX_SIBLING_TABLES;
    delete process.env.CX_SIBLING_NOTES;
    await stop(s);
  });

  it("describes the siblings' columns and the join keys in the sql text and names them in the instructions", async () => {
    // Startup read each sibling's schema (and asked for its card), nothing more.
    expect(s.startup.filter((op) => op === "schema").length).toBe(2);
    const { tools } = await s.client.listTools();
    const sql = tools.find((t) => t.name === "sql")?.description ?? "";
    expect(sql).toContain("joinable with chunks in one statement");
    expect(sql).toContain("swe_issues(instance_id utf8, project utf8, problem_statement large_utf8)");
    expect(sql).toContain("chunks_swelogs(path utf8, start_line i64, content large_utf8, instance_id utf8, resolved utf8)");
    expect(sql).toContain("chunks_swelogs.resolved is 'true' or 'false' per run.");
    // No key reaches the tool text. Each card is asked for by table and
    // tier alone (a card route parameter that handed joins back with the
    // card is gone); no join_keys call is made at startup; the worked JOIN
    // carries a placeholder and says to call join_keys first (2026-09-24,
    // after the corpus's keys had been written into this text by hand and
    // then by a startup call: the owner, "you doctored the demo?").
    const cardAsks = s.sent.filter((sent) => sent.op === "table_card").map((sent) => [sent.body?.table, Object.keys(sent.body ?? {}).sort()]);
    expect(cardAsks).toContainEqual(["swe_issues", ["table", "tier"]]);
    expect(cardAsks).toContainEqual(["chunks_swelogs", ["table", "tier"]]);
    expect(s.sent.filter((sent) => sent.op === "join_keys")).toEqual([]);
    expect(sql).not.toContain("Keys found on the tables' values");
    expect(sql).not.toContain("instance_id = swe_issues.instance_id");
    expect(sql).toContain("JOIN chunks ON <the predicate join_keys returned> WHERE ...");
    expect(sql).toContain("call join_keys with the tables first and paste its predicate into ON");
    // The rule, in the owner's words, heads the sibling text and the
    // routing line (2026-09-24: "it's not forceful enough").
    const rule = "YOU MUST CALL join_keys BEFORE ANY sql CALL IF THE QUERY INVOLVES MORE THAN ONE TABLE.";
    expect(sql.indexOf(rule)).toBeGreaterThan(-1);
    expect(sql.indexOf(rule)).toBeLessThan(sql.indexOf("Also in this database"));
    expect(s.client.getInstructions() ?? "").toContain(`- ${rule}`);
    // The model has join_keys as a tool of its own on any hosted server,
    // API-tools mode or not, named in the routing line; a call returns the
    // platform's keys with their predicates.
    const joinKeysTool = tools.find((t) => t.name === "join_keys");
    expect(joinKeysTool?.description).toContain("never by matching column names");
    expect(s.client.getInstructions() ?? "").toContain("call join_keys with the tables for the keys, then write the JOIN");
    const r = await call(s, "join_keys", { tables: ["chunks_swelogs", "swe_issues"] });
    expect(r.ok).toBe(true);
    expect(((r.value as Record<string, unknown>).joins as unknown[]).length).toBe(2);
    expect(r.ops).toEqual(["join_keys"]);
    const instructions = s.client.getInstructions() ?? "";
    // Ask first across the tables: the loop writes the joins itself, several
    // at once; the model's own sql is for one statement it already knows.
    expect(instructions).toContain(`- ${rule} A question that touches two of these tables - chunks, swe_issues, chunks_swelogs - is an ask first`);
    expect(instructions).toContain("- sql - one statement you already know");
    // The siblings come second in the sql text, before the recipes and the
    // card, and the ask text says its search spans them.
    expect(sql.indexOf("joinable with chunks in one statement")).toBeLessThan(sql.indexOf("The search functions are table-valued"));
    const ask = tools.find((t) => t.name === "ask")?.description ?? "";
    expect(ask).toContain("It searches chunks and, in the same database, swe_issues, chunks_swelogs, and joins them");
    expect(instructions).toContain("beside it in the same database the tables swe_issues, chunks_swelogs");
  });

  it("runs a statement across the tables on the platform once the platform's key is in it, asking join_keys itself first", async () => {
    const r = await call(s, "sql", {
      query: "SELECT i.project, count(*) AS issues FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id GROUP BY i.project",
      question: "how many issues per project have a log?",
    });
    expect(r.ok, String(r.value)).toBe(true);
    // The gate asked the platform for the keys of exactly the tables named,
    // then the statement ran; a second statement over the same tables asks
    // no second time.
    expect(r.ops[0]).toBe("join_keys");
    expect(r.ops).toContain("query_sql");
    // (The earlier test in this block called the join_keys tool by hand; the
    // gate's own call names the tables in the statement's order.)
    expect(s.sent.filter((sent) => sent.op === "join_keys").map((sent) => sent.body?.tables)).toContainEqual(["swe_issues", "chunks_swelogs"]);
    expect((r.value as Record<string, unknown>).rows).toEqual([{ project: "astropy__astropy", issues: 21, resolved: 10 }]);
    const again = await call(s, "sql", { query: "SELECT count(*) FROM chunks_swelogs l JOIN swe_issues i ON i.instance_id = l.instance_id" });
    expect(again.ok, String(again.value)).toBe(true);
    expect(again.ops).not.toContain("join_keys");
  });

  it("refuses a statement across the tables written on no key the platform found, and hands back the keys", async () => {
    // The shape the model wrote when measured (2026-09-24): the two columns
    // matched by name in a correlated subquery, no join_keys call.
    const r = await call(s, "sql", {
      query: "SELECT i.instance_id FROM swe_issues i WHERE i.instance_id IN (SELECT instance_id FROM chunks_swelogs WHERE resolved = 'false')",
    });
    expect(r.ok).toBe(false);
    const text = String(r.value);
    expect(text).toContain("sql refused: the statement spans swe_issues, chunks_swelogs without a key the platform found on their values");
    expect(text).toContain("chunks_swelogs.instance_id = swe_issues.instance_id");
    expect(text).not.toContain("split_part(chunks.path");
    expect(r.ops).not.toContain("query_sql");
    // A statement over one table is never gated and asks for no keys.
    const one = await call(s, "sql", { query: "SELECT count(*) FROM chunks_swelogs WHERE resolved = 'false'" });
    expect(one.ok, String(one.value)).toBe(true);
    expect(one.ops).not.toContain("join_keys");
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
