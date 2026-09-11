// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The three doors over a hosted table of another shape, end to end through
// the MCP server on an in-memory transport against a scripted platform. Three
// servers are started, each against its own scripted platform, for the three
// things under test.
//
// The first: with CX_REMOTE_SEARCH on and CX_TABLE naming a table that is not
// the chunks table, find, search, sql and ask answer from that table with the
// requests the platform's workers accept (the shapes the live
// cxbench.chunks_jobs probes returned on 2026-09-11), the tool text describes
// it, and the shape is read from the platform ONCE, at startup - no call asks
// the platform what it is about to run against, so each call's requests are
// its own and nothing else.
//
// The second: the same table, but the platform cannot describe it at startup.
// The server then registers the rows tools - never the chunks text, which
// would name columns the table does not have - and every call says why it
// cannot run.
//
// The third: no CX_REMOTE_SEARCH at all, so the doors are local, and the
// repository has no index. Auto-index is on, yet nothing builds one: a build
// DROPS and recreates the platform table it is pointed at, and this process
// did not load that table (CX_TABLE is not the default), so the server refuses
// by ownership rather than by luck of the column names. In all three, no
// manifest appears and no drop_table / create_table / append ever reaches the
// platform.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, scriptPlatform, start, stop, type Started } from "./mcp-harness.js";

/** The table the server is started for, in place of `chunks`. */
const JOBS_TABLE = "chunks_jobs";

// The environment the server reads at module load (TABLE is a constant of
// config.ts) and at startup, set before either module is imported - which is
// why every import of the client's own code below is dynamic.
process.env.CX_TABLE = JOBS_TABLE;
process.env.CX_REMOTE_SEARCH = "1";
process.env.CX_NO_EMBED = "1";
delete process.env.CX_AUTO_INDEX; // on: the guard needs the path that would build
delete process.env.CX_NO_RECEIPT;
delete process.env.CX_INDEX_DIR;

const { API_KEY_ENV, MANIFEST_NAME, configureHosted, hostedSettingsFromFlags } = await import("../src/core/config.js");
const { SNIPPET_CHARS } = await import("../src/core/table-shape.js");

/** The live table's schema, as `POST /v1/schema` returned it. */
const JOBS_SCHEMA = [
  { name: "id", nullable: true, type: "utf8" },
  { name: "source_slug", nullable: true, type: "utf8" },
  { name: "title", nullable: true, type: "large_utf8" },
  { name: "apply_url", nullable: true, type: "utf8" },
  { name: "description_html", nullable: true, type: "large_utf8" },
  { name: "employment_type", nullable: true, type: "utf8" },
  { name: "department", nullable: true, type: "utf8" },
  { item: "utf8", name: "locations", nullable: true, type: "list" },
  { name: "remote", nullable: true, type: "bool" },
  { name: "posted_at", nullable: true, type: "utf8" },
  { name: "updated_at", nullable: true, type: "utf8" },
  { name: "salary_min", nullable: true, type: "f64" },
  { name: "salary_max", nullable: true, type: "f64" },
  { name: "salary_currency", nullable: true, type: "utf8" },
  { name: "salary_period", nullable: true, type: "utf8" },
  { name: "emb", nullable: false, source: ["title"], type: "embedding" },
];

/** One row as the platform returns it: nulls omitted, the text entity-escaped HTML. */
const ROW = {
  id: "greenhouse:datadog:4599111",
  source_slug: "datadog",
  title: "Senior Software Engineer - Distributed Systems",
  apply_url: "https://careers.datadoghq.com/detail/4599111/",
  description_html: "&lt;p&gt;&lt;span&gt;Distributed Systems engineers design, implement and run&amp;nbsp;the platforms.&lt;/span&gt;&lt;/p&gt;",
  department: "Dev Eng",
  locations: ["Paris, France"],
  remote: false,
};

/** A whole job description as the table stores one: entity-escaped HTML
 * running to thousands of characters - what a fact carries when the loop's
 * statement selects the column, and what ten facts of would cost more than
 * the answer. */
const LONG_HTML_ITEM = "&lt;li&gt;Own the platform&lt;/li&gt;";
const LONG_HTML_ITEMS = 220;
const LONG_HTML = `&lt;ul&gt;${LONG_HTML_ITEM.repeat(LONG_HTML_ITEMS)}&lt;/ul&gt;`;

/** The platform's loop answering one question over the table: a fact keyed
 * by the row's id, as the projection asks, carrying the searched text whole
 * and a list cell beside it, as the platform's facts do. */
const ASKED = {
  facts: [{ table: JOBS_TABLE, row: { id: ROW.id, title: ROW.title, description_html: LONG_HTML, locations: ROW.locations, score: 0.0164 } }],
  statement: `SELECT id, title FROM bm25_search('${JOBS_TABLE}','description_html','distributed', 10)`,
  coverage: { rows_total: 1, rows_returned: 1, truncated: false },
  terminate: "answered",
  turns: 1,
  retries: 0,
  model_tokens: 640,
};

/** The writes this file exists to catch: none of them may ever be sent. */
const FORBIDDEN_OPS = ["drop_table", "create_table", "append", "delete", "update"];

/** The platform with the table there and describable: it has no card yet,
 * and every read answers. */
const describable = () =>
  scriptPlatform({
    list_tables: () => [200, ["chunks", JOBS_TABLE]],
    schema: () => [200, JOBS_SCHEMA],
    table_card: () => [404, { error: `no lean card for table ${JOBS_TABLE}` }],
    hybrid_search: () => [200, [{ ...ROW, score: 0.0164 }]],
    query_sql: (body) => {
      const query = String(body?.query);
      if (query.includes("token_match")) return [200, [{ __cx_total: 2, ...ROW }]];
      // A row with a start-named column beside text spanning lines: what the
      // chunks path would number, and a table of rows must not.
      if (query.includes("start_year")) return [200, [{ start_year: 2019, description_html: "Build\nfast things" }]];
      return [200, [{ n: 42 }]];
    },
    validate: () => [200, { valid: true, check: "unchecked" }],
    sub_agent: () => [200, ASKED],
  });

/** The platform with the table NOT there: not listed, and its schema a 404
 * (terminal - not the cold-start 503 the client would retry for its budget). */
const undescribable = () =>
  scriptPlatform({
    list_tables: () => [200, ["chunks"]],
    schema: () => [404, { error: `no such table ${JOBS_TABLE}` }],
    table_card: () => [404, { error: `no lean card for table ${JOBS_TABLE}` }],
  });

/** The guard every server here is held to: no write reached the platform
 * and no local index was built. */
function expectNothingBuilt(started: Started): void {
  const ops = started.sent.map((s) => s.op);
  for (const forbidden of FORBIDDEN_OPS) expect(ops, `the server sent ${forbidden}`).not.toContain(forbidden);
  // Auto-index was on and the repo had no index: had any door taken the
  // local path, a manifest would be here (and the table would be gone).
  expect(existsSync(join(started.root, ".infino", MANIFEST_NAME))).toBe(false);
}

beforeAll(() => {
  configureHosted(hostedSettingsFromFlags({ db: "http://127.0.0.1:9/cxbench" }, { [API_KEY_ENV]: "inf_test_key_do_not_log" }));
});

afterAll(() => {
  configureHosted(null);
});

describe("a table of another shape, described at startup", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(describable(), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("read the shape once at startup - schema and one card - and never listed the tables", () => {
    expect(s.startup).toEqual(["schema", "table_card"]);
  });

  it("names the table's columns and search functions in the tool text, and speaks of rows and the key", async () => {
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("sql")).toContain(`hybrid_search('${JOBS_TABLE}','description_html','terms','emb', {{q:"..."}}, k)`);
    expect(byName.get("sql")).toContain("locations list<utf8>");
    // No card named the indexes, so the text says the list is inferred.
    expect(byName.get("sql")).toContain("Full-text indexed: title, description_html (inferred from the schema");
    // The verdict note still rides on it: the platform is there to give one.
    expect(byName.get("sql")).toContain("'validation'");
    expect(byName.get("search")).toContain("cite a row by its id");
    expect(byName.get("find")).toContain(`Every row of ${JOBS_TABLE}`);
    expect(byName.get("ask")).toContain(`the ${JOBS_TABLE} table's index`);
    // The facts of ask and explore are rows, cut to snippets, never hits.
    for (const name of ["ask", "explore"]) {
      expect(byName.get(name), name).toContain("as rows, never as hits");
      expect(byName.get(name), name).toContain(`snippet`);
      expect(byName.get(name), name).toContain(`${SNIPPET_CHARS} characters`);
      expect(byName.get(name), name).not.toContain("from its hits");
    }
    expect(s.client.getInstructions()).toContain(`an index of the ${JOBS_TABLE} table`);
  });

  it("search sends the table's own text and embedding columns, renders rows as hits, and makes no other request", async () => {
    const { ok, value, ops } = await call(s, "search", { query: "distributed systems", k: 3 });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["hybrid_search"]);
    const result = value as { index: string; ranking: string; key: string; hits: Array<Record<string, unknown>>; usage?: string };
    expect(result.index).toBe("platform");
    expect(result.ranking).toBe("hybrid");
    expect(result.key).toBe("id");
    expect(result.hits[0].score).toBe(0.0164);
    expect(result.hits[0].id).toBe(ROW.id);
    expect(result.hits[0].description_html).toBe("Distributed Systems engineers design, implement and run the platforms.");
    expect(result.usage).toMatch(/1 row/);
    const request = s.sent.find((x) => x.op === "hybrid_search")?.body;
    expect(request).toMatchObject({
      table_name: JOBS_TABLE,
      text_field: "description_html",
      text_query: "distributed systems",
      vector_field: "emb",
      vector_text: "distributed systems",
      k: 3,
      mode: "Or",
    });
    expect(request?.projection).toContain("locations");
    expect(request?.projection).toContain("score");
    expect(request?.projection).not.toContain("emb");
  });

  it("find runs token_match over the text column through one query_sql, reads the total off the rows, and strips only its alias", async () => {
    const { ok, value, ops } = await call(s, "find", { query: "distributed systems", limit: 5, defines: true, under: "src" });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["query_sql"]);
    const result = value as { index: string; column: string; total: number; matches: Array<Record<string, unknown>> };
    expect(result.index).toBe("platform");
    expect(result.column).toBe("description_html");
    expect(result.total).toBe(2);
    expect(result.matches[0].id).toBe(ROW.id);
    expect(result.matches[0]).not.toHaveProperty("__cx_total");
    const statement = String(s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("token_match"))?.body?.query);
    expect(statement).toContain(`FROM token_match('${JOBS_TABLE}', 'description_html', 'distributed systems', 'and') LIMIT 5`);
    expect(statement).toContain("COUNT(*) OVER () AS __cx_total");
  });

  it("sql runs on the platform with the embed map folded into its placeholder, asks the verdict against the text column, and numbers no lines", async () => {
    const { ok, value, ops } = await call(s, "sql", {
      query: `SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q}}, 50)`,
      embed: { q: "rust engineering roles" },
      question: "how many rust roles?",
    });
    expect(ok, String(value)).toBe(true);
    // The statement, then the verdict: the call's own two reads and nothing else.
    expect(ops).toEqual(["query_sql", "validate"]);
    const result = value as { index: string; rows: unknown[]; validation?: Record<string, unknown> };
    expect(result.index).toBe("platform");
    expect(result.rows).toEqual([{ n: 42 }]);
    expect(result.validation).toEqual({ valid: true, check: "unchecked" });
    const statement = s.sent.find((x) => x.op === "query_sql" && String(x.body?.query).includes("hybrid_search"))?.body;
    expect(statement?.query).toBe(`SELECT COUNT(*) AS n FROM hybrid_search('${JOBS_TABLE}','description_html','rust','emb', {{q:"rust engineering roles"}}, 50)`);
    const verdict = s.sent.find((x) => x.op === "validate")?.body;
    expect(verdict).toMatchObject({ table_name: JOBS_TABLE, field_name: "description_html", question: "how many rust roles?" });
  });

  it("sql returns a row's multi-line text as the platform gave it: a table has no lines to number", async () => {
    // The chunks path numbers every multi-line cell from the smallest
    // start-named column; here that would read "2019: Build\n2020: fast things".
    const { ok, value } = await call(s, "sql", { query: `SELECT start_year, description_html FROM ${JOBS_TABLE} LIMIT 1` });
    expect(ok, String(value)).toBe(true);
    expect((value as { rows: unknown[] }).rows).toEqual([{ start_year: 2019, description_html: "Build\nfast things" }]);
  });

  it("sql still refuses a write before anything reaches the platform", async () => {
    const { ok, value, ops } = await call(s, "sql", { query: `DROP TABLE ${JOBS_TABLE}` });
    expect(ok).toBe(false);
    expect(value).toMatch(/read-only/);
    expect(ops).toEqual([]);
  });

  it("ask hands the platform's loop the row key as the projection, probes nothing first, and returns its facts as rows with the text cut to snippets", async () => {
    const { ok, value, ops } = await call(s, "ask", { question: "which distributed systems roles are there?" });
    expect(ok, String(value)).toBe(true);
    expect(ops).toEqual(["sub_agent"]);
    const request = s.sent.find((x) => x.op === "sub_agent")?.body;
    expect(request?.projection).toEqual(["id"]);
    expect(request?.question).toBe("which distributed systems roles are there?");
    const result = value as { sql?: string; hits: unknown[]; rows: Array<Record<string, unknown>>; turns: number };
    expect(result.sql).toBe(ASKED.statement);
    // The fact came with the whole description - thousands of characters of
    // escaped HTML - and a list cell; the row keeps the list and carries the
    // text as a search hit would, a snippet, never as a hit of the chunks
    // shape (nothing here names a place in code).
    expect(LONG_HTML.length).toBeGreaterThanOrEqual(8_000);
    expect(result.hits).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(Object.keys(row)).toEqual(["score", "id", "locations", "title", "description_html"]);
    expect(row).toMatchObject({ score: 0.0164, id: ROW.id, title: ROW.title, locations: ["Paris, France"] });
    const text = String(row.description_html);
    expect(text.length).toBe(SNIPPET_CHARS + "...".length);
    expect(text.startsWith("Own the platform Own the platform")).toBe(true);
    expect(text).not.toContain("&lt;");
  });

  it("never reached the platform with a drop, create or append, and wrote no manifest", () => {
    expectNothingBuilt(s);
  });
});

describe("a table of another shape the platform could not describe at startup", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(undescribable(), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
  });

  it("registers the rows tools, not the chunks text, and says the table could not be described", async () => {
    expect(s.startup).toEqual(["schema"]);
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    for (const name of ["find", "search", "sql", "ask", "explore"]) {
      expect(byName.get(name), name).toContain(`rows of the ${JOBS_TABLE} table`);
      expect(byName.get(name), name).toContain("could not be described");
      expect(byName.get(name), name).not.toContain("start_line");
      expect(byName.get(name), name).not.toContain("path:line");
    }
    expect(byName.get("sql")).not.toContain(`hybrid_search('${JOBS_TABLE}','content'`);
    expect(s.client.getInstructions()).toContain(`no such table ${JOBS_TABLE}`);
    expect(s.client.getInstructions()).not.toContain("local index of this repository");
  });

  it("every door returns the cause, makes no platform request, and never falls through to a local build", async () => {
    for (const [name, args] of [
      ["find", { query: "rust" }],
      ["search", { query: "rust" }],
      ["sql", { query: `SELECT COUNT(*) FROM ${JOBS_TABLE}` }],
      ["ask", { question: "how many rust roles?" }],
      ["explore", { question: "how do the rust roles compare?" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { ok, value, ops } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(value, name).toMatch(new RegExp(`^${name} failed: table ${JOBS_TABLE} could not be described from the platform at `));
      expect(value, name).toContain(`no such table ${JOBS_TABLE}`);
      expect(value, name).toContain("nothing runs against a local index in its place");
      expect(ops, name).toEqual([]);
    }
    expectNothingBuilt(s);
  });
});

describe("the same table without CX_REMOTE_SEARCH: local doors, no index, auto-index on", () => {
  let s: Started;
  beforeAll(async () => {
    delete process.env.CX_REMOTE_SEARCH;
    s = await start(undescribable(), "cx-rows-");
  });
  afterAll(async () => {
    await stop(s);
    process.env.CX_REMOTE_SEARCH = "1";
  });

  it("refuses to build by ownership - CX_TABLE names a table this process does not own - whatever CX_AUTO_INDEX says", async () => {
    // Only the card was asked for at startup, as it always was without
    // CX_REMOTE_SEARCH; the chunks text stands because the doors ARE local.
    expect(s.startup).toEqual(["table_card"]);
    for (const [name, args] of [
      ["find", { query: "rust" }],
      ["search", { query: "rust" }],
      ["sql", { query: `SELECT COUNT(*) FROM ${JOBS_TABLE}` }],
      ["ask", { question: "how many rust roles?" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { ok, value, ops } = await call(s, name, args);
      expect(ok, name).toBe(false);
      expect(value, name).toContain(`CX_TABLE=${JOBS_TABLE} names a table this process does not own`);
      expect(value, name).toContain("build it with `cx index` explicitly");
      expect(ops, name).toEqual([]);
    }
    expectNothingBuilt(s);
  });
});
