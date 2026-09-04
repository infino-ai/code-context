// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The hosted REST client against a scripted fake fetch: request shapes as the
// platform's request structs spell them, auth and content negotiation headers,
// the cold-start retry loop, error decoding, telemetry, and the Arrow IPC an
// append carries. No network is ever touched.

import * as arrow from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  HostedDb,
  HostedError,
  isHostedUrl,
  parseHostedUrl,
  retryAfterMs,
  rowsToIpc,
  serverMessage,
  type HostedCallInfo,
  type JsonColumn,
} from "../src/core/hosted.js";

// --- the fake fetch ---------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

interface Scripted {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A fetch that records every request and answers from a script, in order. */
function fakeFetch(script: Scripted[]) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body as string | Uint8Array | undefined,
      signal: init?.signal ?? undefined,
    });
    const next = script.shift();
    if (!next) throw new Error(`fake fetch: no scripted response for call ${calls.length}`);
    return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? {} });
  };
  return { fetch: impl, calls };
}

const KEY = "inf_test_key_do_not_log";
const target = { baseUrl: "https://api.example.test", database: "cx" };

function client(script: Scripted[], extra: { coldStartSecs?: number; timeoutMs?: number; onCall?: (i: HostedCallInfo) => void } = {}) {
  const fake = fakeFetch(script);
  const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: fake.fetch, ...extra });
  return { db, calls: fake.calls };
}

const json = (body: unknown, headers: Record<string, string> = {}): Scripted => ({
  status: 200,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

const bodyJson = (call: Recorded): Record<string, unknown> => JSON.parse(call.body as string) as Record<string, unknown>;

// --- URLs ---------------------------------------------------------------------------

describe("parseHostedUrl", () => {
  it("splits https://host/db into base URL and database", () => {
    expect(parseHostedUrl("https://api.platform.infino.ws/my-app")).toEqual({
      baseUrl: "https://api.platform.infino.ws",
      database: "my-app",
    });
  });

  it("tolerates a trailing slash on the database segment", () => {
    expect(parseHostedUrl("https://h/db/")).toEqual({ baseUrl: "https://h", database: "db" });
  });

  it("allows http:// only for a loopback host", () => {
    expect(parseHostedUrl("http://127.0.0.1:9110/db")).toEqual({ baseUrl: "http://127.0.0.1:9110", database: "db" });
    expect(parseHostedUrl("http://localhost:8080/db")).toEqual({ baseUrl: "http://localhost:8080", database: "db" });
    expect(() => parseHostedUrl("http://example.com/db")).toThrow(/https:\/\/ for a remote host/);
  });

  it("requires the database segment", () => {
    expect(() => parseHostedUrl("https://h")).toThrow(/missing the database segment/);
    expect(() => parseHostedUrl("https://h/")).toThrow(/missing the database segment/);
  });

  it("refuses a nested path - routes are /v1/<op>/<database>", () => {
    expect(() => parseHostedUrl("https://h/a/b")).toThrow(/single path segment/);
  });

  it("refuses any other scheme", () => {
    expect(() => parseHostedUrl("s3://bucket/db")).toThrow(/must start with https:\/\//);
    expect(() => parseHostedUrl("./data")).toThrow(/must start with https:\/\//);
  });
});

describe("isHostedUrl", () => {
  it("is true for http(s) URLs only", () => {
    expect(isHostedUrl("https://h/db")).toBe(true);
    expect(isHostedUrl("http://127.0.0.1:9110/db")).toBe(true);
    expect(isHostedUrl("s3://bucket/prefix")).toBe(false);
    expect(isHostedUrl("./data")).toBe(false);
    expect(isHostedUrl("memory://")).toBe(false);
  });
});

// --- request shapes -------------------------------------------------------------------

describe("request shapes", () => {
  it("bm25_search posts {table_name, field_name, query, k, mode, projection} with auth and JSON accept", async () => {
    const { db, calls } = client([json([{ _id: 7, path: "a.ts", score: 1.5 }], { "x-infino-read-tokens": "0.050" })]);
    const rows = await db.bm25Search("chunks", "content", "fox", 10, { projection: ["path", "score"] });
    expect(rows).toEqual([{ _id: 7, path: "a.ts", score: 1.5 }]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://api.example.test/v1/bm25_search/cx");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(bodyJson(call)).toEqual({ table_name: "chunks", field_name: "content", query: "fox", k: 10, mode: "or", projection: ["path", "score"] });
    // The _id arrives as a JSON integer and stays a number.
    expect(typeof rows[0]._id).toBe("number");
  });

  it("bm25_search omits projection when none is given and honours mode", async () => {
    const { db, calls } = client([json([])]);
    await db.bm25Search("chunks", "content", "fox bar", 5, { mode: "and" });
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks", field_name: "content", query: "fox bar", k: 5, mode: "and" });
  });

  it("token_match posts {table_name, field_name, query, mode, projection} to /v1/token_match", async () => {
    const { db, calls } = client([json([{ _id: 1, path: "a.ts" }])]);
    const rows = await db.tokenMatch("chunks", "content", "parse config", { mode: "and", projection: ["path"] });
    expect(rows).toEqual([{ _id: 1, path: "a.ts" }]);
    expect(calls[0].url).toBe("https://api.example.test/v1/token_match/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks", field_name: "content", query: "parse config", mode: "and", projection: ["path"] });
  });

  it("hybrid_search sends a client vector as vector_query", async () => {
    const { db, calls } = client([json([])]);
    await db.hybridSearch("chunks", "content", "fox", "embedding", [0.1, 0.2], 8, { projection: ["path"] });
    expect(calls[0].url).toBe("https://api.example.test/v1/hybrid_search/cx");
    expect(bodyJson(calls[0])).toEqual({
      table_name: "chunks",
      text_field: "content",
      text_query: "fox",
      mode: "or",
      vector_field: "embedding",
      vector_query: [0.1, 0.2],
      k: 8,
      projection: ["path"],
    });
  });

  it("hybrid_search sends text for an embedding column as vector_text, never both", async () => {
    const { db, calls } = client([json([])]);
    await db.hybridSearch("chunks", "content", "fox", "embedding", { text: "fox" }, 8);
    const body = bodyJson(calls[0]);
    expect(body.vector_text).toBe("fox");
    expect(body).not.toHaveProperty("vector_query");
    expect(body).not.toHaveProperty("projection");
  });

  it("query_sql posts {query} to /v1/query_sql and decodes the row array", async () => {
    const { db, calls } = client([json([{ n: 3 }])]);
    expect(await db.querySql("SELECT COUNT(*) AS n FROM chunks")).toEqual([{ n: 3 }]);
    expect(calls[0].url).toBe("https://api.example.test/v1/query_sql/cx");
    expect(bodyJson(calls[0])).toEqual({ query: "SELECT COUNT(*) AS n FROM chunks" });
  });

  it("a read with an empty body is an empty result", async () => {
    const { db } = client([{ status: 200, body: "", headers: { "content-type": "application/json" } }]);
    expect(await db.querySql("SELECT 1")).toEqual([]);
  });

  it("a read that came back as an Arrow stream is refused with a clear error", async () => {
    const { db } = client([{ status: 200, body: "ARROW1", headers: { "content-type": "application/vnd.apache.arrow.stream" } }]);
    await expect(db.querySql("SELECT 1")).rejects.toThrow(/expected JSON rows/);
  });

  it("create_table posts the platform's schema descriptors and indexes", async () => {
    const { db, calls } = client([json({})]);
    const columns: JsonColumn[] = [
      { name: "path", type: "large_utf8", nullable: false },
      { name: "start_line", type: "int32" },
      { name: "embedding", type: { type: "vector", dim: 4 } },
      { name: "auto", type: { type: "embedding", source: ["content"] } },
    ];
    await db.createTable("chunks", columns, {
      fts: [{ column: "content", analyzer: "ascii_lower" }, { column: "path" }],
      vector: [{ column: "embedding", metric: "cosine" }],
    });
    expect(calls[0].url).toBe("https://api.example.test/v1/create_table/cx");
    expect(bodyJson(calls[0])).toEqual({
      table_name: "chunks",
      schema: [
        { name: "path", type: "large_utf8", nullable: false },
        { name: "start_line", type: "int32" },
        { name: "embedding", type: "vector", dim: 4 },
        { name: "auto", type: "embedding", source: ["content"] },
      ],
      indexes: {
        fts: [{ column: "content", analyzer: "ascii_lower" }, { column: "path" }],
        vector: [{ column: "embedding", metric: "cosine" }],
      },
    });
  });

  it("create_table leaves the vector index list out when there is none", async () => {
    const { db, calls } = client([json({})]);
    await db.createTable("t", [{ name: "content", type: "large_utf8" }], { fts: [{ column: "content" }] });
    expect(bodyJson(calls[0]).indexes).toEqual({ fts: [{ column: "content" }] });
  });

  it("drop_table posts {table_name, purge}", async () => {
    const { db, calls } = client([json({}), json({})]);
    await db.dropTable("chunks");
    await db.dropTable("chunks", false);
    expect(calls[0].url).toBe("https://api.example.test/v1/drop_table/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks", purge: true });
    expect(bodyJson(calls[1])).toEqual({ table_name: "chunks", purge: false });
  });

  it("list_tables posts with no body and returns the name array", async () => {
    const { db, calls } = client([json(["chunks", "other"])]);
    expect(await db.listTables()).toEqual(["chunks", "other"]);
    expect(calls[0].url).toBe("https://api.example.test/v1/list_tables/cx");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers).not.toHaveProperty("content-type");
  });

  it("schema posts {table_name} and returns the descriptors as they came", async () => {
    const descriptors = [{ name: "path", type: "large_utf8", nullable: false }];
    const { db, calls } = client([json(descriptors)]);
    expect(await db.schema("chunks")).toEqual(descriptors);
    expect(calls[0].url).toBe("https://api.example.test/v1/schema/cx");
    expect(bodyJson(calls[0])).toEqual({ table_name: "chunks" });
  });

  it("appendIpc posts the bytes untouched as an Arrow stream with ?table=", async () => {
    const { db, calls } = client([json({}, { "x-infino-write-tokens": "1.250" })]);
    const ipc = new Uint8Array([65, 82, 82, 79, 87, 49]);
    await db.appendIpc("chunks", ipc);
    const call = calls[0];
    expect(call.url).toBe("https://api.example.test/v1/append/cx?table=chunks");
    expect(call.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(call.body).toBe(ipc);
    expect(db.lastCall()).toMatchObject({ op: "append", status: 200, retries: 0, writeTokens: 1.25 });
  });

  it("appendRows posts the JSON {data} envelope", async () => {
    const { db, calls } = client([json({})]);
    await db.appendRows("chunks", [{ path: "a.ts", start_line: 1 }]);
    expect(calls[0].url).toBe("https://api.example.test/v1/append/cx?table=chunks");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(bodyJson(calls[0])).toEqual({ data: [{ path: "a.ts", start_line: 1 }] });
  });

  it("delete rides the query string with no body and returns the mutation counts", async () => {
    const stats = { matched: 2, n_tombstoned: 2, n_not_found: 0 };
    const { db, calls } = client([json(stats)]);
    expect(await db.deleteWhere("chunks", "path IN ('a b.ts','c.ts')")).toEqual(stats);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/delete/cx");
    expect(url.searchParams.get("table")).toBe("chunks");
    expect(url.searchParams.get("predicate")).toBe("path IN ('a b.ts','c.ts')");
    expect(calls[0].body).toBeUndefined();
  });

  it("ask posts only the fields given and decodes the answer", async () => {
    const answer = { answer: "3", terminate: "answered", turns: 2, answer_retries: 0, bare_reply: false, prompt_tokens: 10, completion_tokens: 2, usage: [], model: "m" };
    const { db, calls } = client([json(answer), json(answer)]);
    expect(await db.ask({ question: "how many?" })).toEqual(answer);
    expect(calls[0].url).toBe("https://api.example.test/v1/ask/cx");
    expect(bodyJson(calls[0])).toEqual({ question: "how many?" });
    await db.ask({ question: "q", answer: "sql", max_turns: 3, max_wall_secs: 30, include_transcript: true });
    expect(bodyJson(calls[1])).toEqual({ question: "q", answer: "sql", max_turns: 3, max_wall_secs: 30, include_transcript: true });
    expect(calls[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("ask does not retry a 501 (no ask configured on the deployment)", async () => {
    const { db, calls } = client([{ status: 501, body: "ask is not configured on this deployment" }]);
    await expect(db.ask({ question: "q" })).rejects.toMatchObject({ status: 501 });
    expect(calls).toHaveLength(1);
  });

  it("strips a trailing slash off the base URL", async () => {
    const fake = fakeFetch([json([])]);
    const db = new HostedDb({ baseUrl: "https://h/", database: "d", apiKey: KEY }, { fetch: fake.fetch });
    await db.listTables();
    expect(fake.calls[0].url).toBe("https://h/v1/list_tables/d");
  });
});

// --- retries -----------------------------------------------------------------------

describe("cold-start retries", () => {
  it("retries a 503 after its Retry-After and answers from the 200", async () => {
    const seen: HostedCallInfo[] = [];
    const { db, calls } = client(
      [{ status: 503, body: "no worker is ready to serve this request yet", headers: { "retry-after": "0" } }, json([{ n: 1 }])],
      { onCall: (i) => seen.push(i) },
    );
    expect(await db.querySql("SELECT 1")).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
    // One logical call, one telemetry record, counting the retry it took.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "query_sql", status: 200, retries: 1 });
    expect(seen[0].rttMs).toBeGreaterThanOrEqual(0);
    expect(db.lastCall()).toBe(seen[0]);
  });

  it("retries a 529 like a 503", async () => {
    const { db, calls } = client([{ status: 529, body: "no capacity to activate this database yet", headers: { "retry-after": "0" } }, json(["t"])]);
    expect(await db.listTables()).toEqual(["t"]);
    expect(calls).toHaveLength(2);
  });

  it("does not wait for a Retry-After that outlives the cold-start budget", async () => {
    const t0 = Date.now();
    const { db, calls } = client([{ status: 529, body: "no capacity to activate this database yet", headers: { "retry-after": "600" } }], { coldStartSecs: 1 });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 529, retryAfterSecs: 600, op: "list_tables" });
    expect((err as Error).message).toMatch(/no capacity to activate/);
    expect(calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("gives up once the cold-start budget is spent and reports the retries", async () => {
    const forever: Scripted[] = [];
    for (let i = 0; i < 1000; i++) forever.push({ status: 503, body: "still spawning", headers: { "retry-after": "0" } });
    const seen: HostedCallInfo[] = [];
    const { db } = client(forever, { coldStartSecs: 0.05, onCall: (i) => seen.push(i) });
    const err = await db.querySql("SELECT 1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
    expect((err as Error).message).toMatch(/still spawning/);
    expect((err as Error).message).toMatch(/gave up after \d+ retr/);
    expect(seen).toHaveLength(1);
    expect(seen[0].retries).toBeGreaterThan(0);
  });

  it("retries an append 409 that carries Retry-After (a lost write race)", async () => {
    const { db, calls } = client([
      { status: 409, body: "another write to the same table was in flight", headers: { "retry-after": "0" } },
      json({}),
    ]);
    await db.appendRows("chunks", [{ path: "a" }]);
    expect(calls).toHaveLength(2);
    expect(db.lastCall()).toMatchObject({ op: "append", status: 200, retries: 1 });
  });

  it("does not retry a 409 without Retry-After (a name collision is terminal)", async () => {
    const { db, calls } = client([{ status: 409, body: "table chunks already exists" }]);
    await expect(db.createTable("chunks", [{ name: "c", type: "large_utf8" }], { fts: [] })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });

  it("uses the platform's 5 s activation hint when Retry-After is missing or unreadable", () => {
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs("garbage")).toBe(5000);
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs(" 0 ")).toBe(0);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const ms = retryAfterMs(soon);
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    expect(retryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
});

// --- errors -------------------------------------------------------------------------

describe("errors", () => {
  it("reads a plain-text data-plane body and a JSON control-plane body", () => {
    expect(serverMessage(400, "unknown field `bogus`")).toBe("unknown field `bogus`");
    expect(serverMessage(401, JSON.stringify({ error: "unauthenticated" }))).toBe("unauthenticated");
    expect(serverMessage(400, JSON.stringify({ message: "bad" }))).toBe("bad");
    expect(serverMessage(500, JSON.stringify({ other: 1 }))).toBe('{"other":1}');
    expect(serverMessage(502, "")).toBe("HTTP 502");
  });

  it("throws a HostedError carrying the status and the server's message", async () => {
    const { db } = client([{ status: 400, body: "query_sql is read-only; row mutations use POST /v1/append/{database}?table=..." }]);
    const err = await db.querySql("INSERT INTO t VALUES (1)").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 400, op: "query_sql" });
    expect((err as Error).message).toBe("query_sql: server returned 400: query_sql is read-only; row mutations use POST /v1/append/{database}?table=...");
    expect(db.lastCall()).toMatchObject({ op: "query_sql", status: 400, retries: 0 });
  });

  it("a 401 surfaces as status 401 and never echoes the key", async () => {
    const { db } = client([{ status: 401, body: JSON.stringify({ error: "unauthenticated" }), headers: { "content-type": "application/json" } }]);
    const err = (await db.listTables().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ status: 401 });
    expect(err.message).toBe("list_tables: server returned 401: unauthenticated");
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it("refuses to build a client without an API key", () => {
    expect(() => new HostedDb({ ...target, apiKey: "" })).toThrow(/API key/);
  });

  it("times out a call that never answers and records status 0", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const seen: HostedCallInfo[] = [];
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: hanging, timeoutMs: 20, onCall: (i) => seen.push(i) });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ status: 0 });
    expect((err as Error).message).toMatch(/no response within 20 ms/);
    expect(seen).toEqual([expect.objectContaining({ op: "list_tables", status: 0, retries: 0 })]);
  });

  it("wraps a transport failure with status 0 and the cause", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const db = new HostedDb({ ...target, apiKey: KEY }, { fetch: failing });
    const err = await db.listTables().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0 });
    expect((err as Error).message).toMatch(/request failed: fetch failed/);
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("a non-JSON success body on a JSON op is an error naming the op", async () => {
    const { db } = client([{ status: 200, body: "<html>", headers: { "content-type": "text/html" } }]);
    await expect(db.listTables()).rejects.toThrow(/list_tables.*not JSON/);
  });
});

// --- telemetry ---------------------------------------------------------------------

describe("telemetry", () => {
  it("parses both token headers when present and leaves them off when absent", async () => {
    const { db } = client([json([], { "x-infino-read-tokens": "0.050" }), json({}, { "x-infino-write-tokens": "2.000" }), json([])]);
    await db.querySql("SELECT 1");
    expect(db.lastCall()).toMatchObject({ readTokens: 0.05 });
    expect(db.lastCall()).not.toHaveProperty("writeTokens");
    await db.appendRows("t", []);
    expect(db.lastCall()).toMatchObject({ writeTokens: 2 });
    expect(db.lastCall()).not.toHaveProperty("readTokens");
    await db.querySql("SELECT 1");
    expect(db.lastCall()).not.toHaveProperty("readTokens");
    expect(db.lastCall()).not.toHaveProperty("writeTokens");
  });

  it("starts with no last call", () => {
    const { db } = client([]);
    expect(db.lastCall()).toBeNull();
  });
});

// --- Arrow IPC -----------------------------------------------------------------------

/** The wire facts of an integer type as the IPC reader hands it back. */
const intShape = (t: arrow.DataType): { signed: boolean; bits: number } | null =>
  arrow.DataType.isInt(t) ? { signed: t.isSigned, bits: t.bitWidth } : null;

describe("rowsToIpc", () => {
  const columns: JsonColumn[] = [
    { name: "path", type: "large_utf8", nullable: false },
    { name: "start_line", type: "int32", nullable: false },
    { name: "symbol", type: "large_utf8" },
    { name: "embedding", type: { type: "vector", dim: 3 }, nullable: false },
  ];

  it("encodes text as LargeUtf8, line numbers as Int32, vectors as FixedSizeList<Float32, dim>, keeping nullability", () => {
    const ipc = rowsToIpc(columns, [
      { path: "a.ts", start_line: 1, symbol: "f", embedding: [0.5, 0.25, -1] },
      { path: "b.ts", start_line: 20, embedding: Float32Array.from([1, 2, 3]) },
    ]);
    expect(ipc).toBeInstanceOf(Uint8Array);
    const table = arrow.tableFromIPC(ipc);
    const fields = table.schema.fields;
    expect(fields.map((f) => f.name)).toEqual(["path", "start_line", "symbol", "embedding"]);
    expect(fields[0].type).toBeInstanceOf(arrow.LargeUtf8);
    // The IPC reader materialises integers as the generic Int with a width,
    // so the check is on the wire facts: signed, 32 bits.
    expect(intShape(fields[1].type)).toEqual({ signed: true, bits: 32 });
    expect(fields[2].type).toBeInstanceOf(arrow.LargeUtf8);
    expect(fields[3].type).toBeInstanceOf(arrow.FixedSizeList);
    expect((fields[3].type as arrow.FixedSizeList).listSize).toBe(3);
    const item = (fields[3].type as arrow.FixedSizeList).children[0].type;
    expect(arrow.DataType.isFloat(item) && (item as arrow.Float).precision).toBe(arrow.Precision.SINGLE);
    // The engine compares an appended batch's nullability to the table's, so
    // the flags must be exactly what the descriptors declared (default true).
    expect(fields.map((f) => f.nullable)).toEqual([false, false, true, false]);
    expect(table.numRows).toBe(2);
    expect(table.getChild("path")!.toArray()).toEqual(["a.ts", "b.ts"]);
    expect(Array.from(table.getChild("start_line")!.toArray() as Int32Array)).toEqual([1, 20]);
    // An omitted key is a null, not an empty string.
    expect(table.getChild("symbol")!.get(0)).toBe("f");
    expect(table.getChild("symbol")!.get(1)).toBeNull();
    const emb = table.getChild("embedding")!;
    expect(Array.from(emb.get(0)!.toArray() as Float32Array)).toEqual([0.5, 0.25, -1]);
    expect(Array.from(emb.get(1)!.toArray() as Float32Array)).toEqual([1, 2, 3]);
  });

  it("leaves embedding columns out - the platform fills them", () => {
    const ipc = rowsToIpc(
      [{ name: "content", type: "large_utf8" }, { name: "auto", type: { type: "embedding", source: ["content"] } }],
      [{ content: "x" }],
    );
    expect(arrow.tableFromIPC(ipc).schema.fields.map((f) => f.name)).toEqual(["content"]);
  });

  it("carries 64-bit integers and the other scalar spellings", () => {
    const ipc = rowsToIpc(
      [
        { name: "a", type: "i64" },
        { name: "b", type: "u64" },
        { name: "c", type: "f64" },
        { name: "d", type: "bool" },
        { name: "e", type: "utf8" },
      ],
      [{ a: 5, b: 7n, c: 1.5, d: true, e: "s" }],
    );
    const table = arrow.tableFromIPC(ipc);
    expect(intShape(table.schema.fields[0].type)).toEqual({ signed: true, bits: 64 });
    expect(intShape(table.schema.fields[1].type)).toEqual({ signed: false, bits: 64 });
    expect(arrow.DataType.isFloat(table.schema.fields[2].type)).toBe(true);
    expect((table.schema.fields[2].type as arrow.Float).precision).toBe(arrow.Precision.DOUBLE);
    expect(table.schema.fields[3].type).toBeInstanceOf(arrow.Bool);
    expect(table.schema.fields[4].type).toBeInstanceOf(arrow.Utf8);
    expect(table.getChild("a")!.get(0)).toBe(5n);
    expect(table.getChild("b")!.get(0)).toBe(7n);
  });

  it("encodes zero rows as a schema-bearing empty stream", () => {
    const table = arrow.tableFromIPC(rowsToIpc(columns, []));
    expect(table.numRows).toBe(0);
    expect(table.schema.fields).toHaveLength(4);
  });

  it("rejects a missing or short vector rather than writing a wrong one", () => {
    expect(() => rowsToIpc(columns, [{ path: "a", start_line: 1, embedding: [1, 2] }])).toThrow(/has 2 values, expected 3/);
    expect(() => rowsToIpc(columns, [{ path: "a", start_line: 1 }])).toThrow(/no vector/);
  });

  it("rejects an unknown column type", () => {
    expect(() => rowsToIpc([{ name: "x", type: "decimal" }], [])).toThrow(/unsupported column type "decimal"/);
  });

  it("round-trips a vector append through the client untouched", async () => {
    const { db, calls } = client([json({})]);
    const ipc = rowsToIpc(columns, [{ path: "a.ts", start_line: 1, embedding: [1, 2, 3] }]);
    await db.appendIpc("chunks", ipc);
    expect(arrow.tableFromIPC(calls[0].body as Uint8Array).numRows).toBe(1);
  });
});
