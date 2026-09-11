// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The chunks table under CX_REMOTE_SEARCH, end to end through the MCP server
// on an in-memory transport against a scripted platform: the path the live
// demo runs. What is under test is that it is the path it always was. The
// default table is never probed for its shape - it is the table this client
// builds, so its mode is chunks without asking - and startup reads the one
// card the sql description folds in, with no cold-start retries, so the MCP
// handshake is never held behind a platform that is cold or answering 503 at
// spawn (the second server below). After that find and sql are local tools
// that make NO platform request - not before their answer, not for it - and
// search reads the hosted index through the readiness memo and hybrid_search
// exactly as before, with the chunks table's own columns. The tool text is
// the chunks text. Auto-index is off here so a local door with no index
// answers "no index yet" rather than building one against the scripted
// platform; the point is where each door goes, not what it finds.

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

/** The longest a startup may take before it has plainly waited on the
 * platform: under the client's shortest retry wait (five seconds, when the
 * platform sends no Retry-After) and far under its cold-start budget (two
 * minutes), so a startup that took even one retry could not finish in it. */
const STARTUP_MS_MAX = 4_000;

/** The platform up, the chunks table there, no card computed for it yet, and
 * the hosted search answering. No `schema` route: the default table is not
 * probed, and a probe would be the one unscripted request. */
const up = () =>
  scriptPlatform({
    list_tables: () => [200, [TABLE]],
    table_card: () => [404, { error: `no lean card for table ${TABLE}` }],
    hybrid_search: () => [200, [CHUNK]],
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

  it("sql answers from the local side with no platform request at all", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `SELECT COUNT(*) FROM ${TABLE}` });
    expect(ok).toBe(false);
    expect(value).toMatch(/^no index for .* yet - run `cx index`/);
    expect(ops).toEqual([]);
  });

  it("search lists the tables once, then hybrid_search over content and embedding with the chunks projection, as it always did", async () => {
    const first = await call(s, "search", { query: "body", k: 3 });
    expect(first.ok, String(first.value)).toBe(true);
    expect(first.ops).toEqual(["list_tables", "hybrid_search"]);
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

  it("find and sql are still the local tools, with no platform request", async () => {
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
