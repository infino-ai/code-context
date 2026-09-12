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
// that find is a local tool that makes NO platform request - not before its
// answer, not for it - while search and sql read the hosted index through
// the readiness memo: search by hybrid_search with the chunks table's own
// columns, sql by query_sql with its placeholders folded into the platform's
// own, and the rows numbered as the local path numbers chunks. Since
// 2026-09-12 - before that sql ran on the local index under this switch,
// which on a corpus whose local index was built keyword-only failed every
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

const { SQL_DESCRIPTION } = await import("../src/mcp/server.js");
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
  expect(byName.get("ask")).toContain("Ask the repository index");
  expect(s.client.getInstructions()).toContain("code-context is a local index of this repository");
}

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

  it("sql runs a plain statement on the platform too - under this switch the hosted table is the index - with no local index touched", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `SELECT COUNT(*) AS n FROM ${TABLE}` });
    expect(ok, String(value)).toBe(true);
    // The memo already holds from the statement above: no second listing.
    expect(ops).toEqual(["query_sql", "validate"]);
    expect((value as { rows: unknown[] }).rows).toEqual([{ n: 7 }]);
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

describe("the chunks table with CX_AGENT_TOOLS=0: the lane that hides ask and explore", () => {
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

  it("registers neither ask nor explore and names neither in the instructions, while sql keeps its validation note", async () => {
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("find");
    expect(names).toContain("search");
    expect(names).toContain("sql");
    expect(names).not.toContain("ask");
    expect(names).not.toContain("explore");
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("code-context is a local index of this repository");
    expect(instructions).not.toContain("- ask -");
    expect(instructions).not.toContain("- explore -");
    // The database is still configured: the sql text's platform-side note
    // and the startup card read are about sql, not about the loop.
    expect(tools.find((t) => t.name === "sql")?.description).toContain("'validation'");
    expect(s.startup).toEqual(["table_card"]);
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

  it("find is still the local tool, with no platform request", async () => {
    // Not sql: under this switch it reads the hosted index, and against a
    // platform answering 503 it would wait the client's cold-start budget
    // out, as search would - which is the tool's behaviour, not this test's
    // subject.
    const { ok, value, ops } = await call(s, "find", { query: "body" });
    expect(ok).toBe(false);
    expect(value).toMatch(/^no index for .* yet - run `cx index`/);
    expect(ops).toEqual([]);
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
