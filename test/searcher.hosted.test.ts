// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The three doors against a hosted handle: which platform op each one calls
// and with what body, that the result objects have exactly the local shape
// (nothing from the wire leaks - no _id, no telemetry), the keyword fallback
// when there is no vector to fuse, the platform's own `{{q:"..."}}`
// placeholder for a platform-embedded table, and the ledger telemetry helper.
// A scripted fake fetch stands in for the platform; no network, no engine.

import { describe, expect, it } from "vitest";
import { HostedDb } from "../src/core/hosted.js";
import type { IndexHandle } from "../src/core/context.js";
import { emptyManifest, type Manifest } from "../src/core/manifest.js";
import { applyPlatformEmbeds, find, hostedTelemetry, platformEmbedded, runSql, search } from "../src/core/searcher.js";
import type { Embedder } from "../src/core/embedder.js";

// --- the fake fetch ---------------------------------------------------------------

interface Recorded {
  op: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface Scripted {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Answers 200 JSON from a script, in order, recording every request. */
function fakeFetch(script: Scripted[]) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({
      op: url.split("/v1/")[1].split(/[/?]/)[0],
      url,
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const next = script.shift();
    if (!next) throw new Error(`fake fetch: no scripted response for call ${calls.length} (${url})`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  };
  return { fetch: impl, calls };
}

const KEY = "inf_test_key_do_not_log";
const URL_LABEL = "https://api.example.test/cx";

/** A hosted chunks table the platform embeds. */
const PLATFORM_MANIFEST: Manifest = {
  ...emptyManifest(),
  origin: "hosted",
  vectors: "ready",
  analyzer: "standard",
  embedder: { provider: "platform", model: "server-side" },
  files: 2,
  chunks: 3,
};

/** A hosted chunks table with client vectors from the fake model. */
const CLIENT_VECTOR_MANIFEST: Manifest = {
  ...PLATFORM_MANIFEST,
  embedder: { provider: "fake", model: "fake-2d", dim: 2 },
};

/** A keyword-only hosted table. */
const KEYWORD_MANIFEST: Manifest = { ...PLATFORM_MANIFEST, vectors: "none", embedder: undefined };

function hostedHandle(manifest: Manifest, script: Scripted[]) {
  const fake = fakeFetch(script);
  const hosted = new HostedDb({ baseUrl: "https://api.example.test", database: "cx", apiKey: KEY }, { fetch: fake.fetch });
  const handle: IndexHandle = { root: "/repo", dir: "/repo/.infino", target: URL_LABEL, hosted, manifest };
  return { handle, calls: fake.calls, hosted };
}

/** Embeds everything to the same 2-vector and counts the calls. */
function fakeEmbedder(model = "fake-2d") {
  let calls = 0;
  const embedder: Embedder = {
    embed: async (texts) => {
      calls++;
      return texts.map(() => [0.25, 0.5]);
    },
    dim: async () => 2,
    provider: "fake",
    model,
  };
  return { embedder, embedCalls: () => calls };
}

const LONG_CONTENT_LENGTH = 5000;
const HIT_CONTENT_CAP = 4000;

const SEARCH_ROWS = [
  { _id: 1, path: "src/a.ts", start_line: 1, end_line: 3, lang: "ts", symbol: "alpha", content: "export function alpha() {}", score: 0.9 },
  { _id: 2, path: "b.md", start_line: 10, end_line: 12, lang: "md", symbol: "", content: "x".repeat(LONG_CONTENT_LENGTH), score: 0.5 },
];

/** The exact local result shape for SEARCH_ROWS: no _id, no empty symbol,
 * content capped with the truncated marker. */
const SEARCH_HITS = [
  { path: "src/a.ts", startLine: 1, endLine: 3, lang: "ts", score: 0.9, symbol: "alpha", content: "export function alpha() {}" },
  { path: "b.md", startLine: 10, endLine: 12, lang: "md", score: 0.5, content: "x".repeat(HIT_CONTENT_CAP), truncated: true },
];

const PROJECTION = ["path", "start_line", "end_line", "lang", "symbol", "content", "score"];
const FIND_PROJECTION = ["path", "start_line", "symbol", "content"];

// --- search --------------------------------------------------------------------------

describe("search (hosted)", () => {
  it("sends the query text as the vector leg of a platform-embedded table", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, [{ body: SEARCH_ROWS }]);
    const result = await search(handle, null, "session verification", 5);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("hybrid_search");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers.accept).toBe("application/json");
    expect(calls[0].body).toEqual({
      table_name: "chunks",
      text_field: "content",
      text_query: "session verification",
      mode: "or",
      vector_field: "embedding",
      vector_text: "session verification",
      k: 5,
      projection: PROJECTION,
    });
    expect(result).toEqual({ query: "session verification", ranking: "hybrid", hits: SEARCH_HITS });
  });

  it("ignores a client embedder for a platform-embedded table - the table's model wins", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, [{ body: [] }]);
    const { embedder, embedCalls } = fakeEmbedder("some-other-model");
    const result = await search(handle, embedder, "q");
    expect(result.ranking).toBe("hybrid");
    expect(embedCalls()).toBe(0);
    expect(calls[0].body).toMatchObject({ vector_text: "q" });
    expect(calls[0].body).not.toHaveProperty("vector_query");
  });

  it("embeds locally and sends vector_query for a client-vector table", async () => {
    const { handle, calls } = hostedHandle(CLIENT_VECTOR_MANIFEST, [{ body: SEARCH_ROWS }]);
    const { embedder, embedCalls } = fakeEmbedder();
    const result = await search(handle, embedder, "alpha", 3);
    expect(embedCalls()).toBe(1);
    expect(calls[0].op).toBe("hybrid_search");
    expect(calls[0].body).toMatchObject({ vector_query: [0.25, 0.5], k: 3 });
    expect(calls[0].body).not.toHaveProperty("vector_text");
    expect(result.ranking).toBe("hybrid");
    expect(result.hits).toEqual(SEARCH_HITS);
  });

  it("refuses a query embedder that does not match the index's, before any request", async () => {
    const { handle, calls } = hostedHandle(CLIENT_VECTOR_MANIFEST, []);
    const { embedder } = fakeEmbedder("other-2d");
    await expect(search(handle, embedder, "alpha")).rejects.toThrow(/query embedder \(other-2d\) does not match the index embedder \(fake-2d\)/);
    expect(calls).toHaveLength(0);
  });

  it("falls back to keyword ranking with no client embedder and no platform column, without a note", async () => {
    const { handle, calls } = hostedHandle(CLIENT_VECTOR_MANIFEST, [{ body: SEARCH_ROWS }]);
    const result = await search(handle, null, "alpha", 7);
    expect(calls[0].op).toBe("bm25_search");
    expect(calls[0].body).toEqual({ table_name: "chunks", field_name: "content", query: "alpha", k: 7, mode: "or", projection: PROJECTION });
    // Same shape as the local keyword pass: vectors ARE ready, so no note.
    expect(result).toEqual({ query: "alpha", ranking: "keyword", hits: SEARCH_HITS });
  });

  it("is keyword-ranked with the not-ready note while the table has no vectors", async () => {
    const { handle, calls } = hostedHandle(KEYWORD_MANIFEST, [{ body: [] }]);
    const { embedder, embedCalls } = fakeEmbedder();
    const result = await search(handle, embedder, "alpha");
    expect(calls[0].op).toBe("bm25_search");
    expect(embedCalls()).toBe(0);
    expect(result.ranking).toBe("keyword");
    expect(result.note).toMatch(/vectors not ready/);
    expect(result.hits).toEqual([]);
  });

  it("carries the partial-index marker like the local path", async () => {
    const partial: Manifest = { ...PLATFORM_MANIFEST, truncatedFiles: 3, maxFiles: 10 };
    const { handle } = hostedHandle(partial, [{ body: [] }]);
    const result = await search(handle, null, "q");
    expect(result.partial).toMatchObject({ filesSkipped: 3, fileCap: 10 });
  });

  it("platformEmbedded reads the manifest's provider", () => {
    expect(platformEmbedded(PLATFORM_MANIFEST)).toBe(true);
    expect(platformEmbedded(CLIENT_VECTOR_MANIFEST)).toBe(false);
    expect(platformEmbedded(KEYWORD_MANIFEST)).toBe(false);
  });
});

// --- find ----------------------------------------------------------------------------

const FIND_ROWS = [
  { _id: 1, path: "src/a.ts", start_line: 1, symbol: "parseConfig", content: "export function parseConfig(p) {\n  return parse_config(p);\n}" },
  // An overlapping window that repeats the line - reported once.
  { _id: 2, path: "src/a.ts", start_line: 2, symbol: "", content: "  return parse_config(p);\n}\nconst other = 1;" },
  { _id: 3, path: "lib/b.ts", start_line: 40, symbol: "", content: "parse config\nparse_config()" },
];

describe("find (hosted)", () => {
  it("sends the query text to token_match under mode and, and verifies the literal client-side", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, [{ body: FIND_ROWS }]);
    const result = await find(handle, "parse_config");
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("token_match");
    expect(calls[0].body).toEqual({
      table_name: "chunks",
      field_name: "content",
      query: "parse_config",
      mode: "and",
      projection: FIND_PROJECTION,
    });
    // The literal check runs on the returned chunks: "parse config" on lib/b.ts:40
    // has the tokens but not the literal; src/a.ts:2 arrives in two chunks.
    expect(result).toEqual({
      query: "parse_config",
      ignoreCase: false,
      matches: [
        { path: "lib/b.ts", line: 41, text: "parse_config()" },
        { path: "src/a.ts", line: 2, text: "  return parse_config(p);", symbol: "parseConfig" },
      ],
      total: 2,
      files: 2,
      byFile: [
        { path: "lib/b.ts", count: 1 },
        { path: "src/a.ts", count: 1 },
      ],
    });
  });

  it("blanks the engine's query grammar but otherwise sends the text as typed", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, [{ body: [] }, { body: [] }]);
    await find(handle, "git -C repo");
    expect(calls[0].body).toMatchObject({ query: "git  C repo" });
    await find(handle, "Süd ok");
    // Under the table's standard analyzer a non-ASCII word is indexable; the
    // raw text goes to the platform, which tokenizes it with the index.
    expect(calls[1].body).toMatchObject({ query: "Süd ok" });
  });

  it("rejects what the table's analyzer cannot look up before any request", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, []);
    await expect(find(handle, "->")).rejects.toThrow(/standard analyzer keeps none/);
    const ascii = hostedHandle({ ...PLATFORM_MANIFEST, analyzer: "ascii_lower" }, []);
    await expect(find(ascii.handle, "Süd")).rejects.toThrow(/ascii_lower analyzer keeps none/);
    await expect(find(handle, "")).rejects.toThrow(/non-empty/);
    await expect(find(handle, "a\nb")).rejects.toThrow(/newline/);
    await expect(find(handle, "x", { limit: 0 })).rejects.toThrow(/positive integer/);
    expect(calls).toHaveLength(0);
    expect(ascii.calls).toHaveLength(0);
  });

  it("caps matches at the limit and keeps the whole total, like the local path", async () => {
    const { handle } = hostedHandle(PLATFORM_MANIFEST, [{ body: FIND_ROWS }]);
    const result = await find(handle, "parse_config", { limit: 1, ignoreCase: true });
    expect(result.matches).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.ignoreCase).toBe(true);
  });
});

// --- sql -----------------------------------------------------------------------------

const HYBRID_SQL = "SELECT path FROM hybrid_search('chunks','content','session','embedding', {{q}}, 10)";

describe("runSql (hosted)", () => {
  it("rewrites {{name}} into the platform's {{q:\"text\"}} for a platform-embedded table", async () => {
    const rows = [{ path: "src/a.ts" }];
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, [{ body: rows }]);
    const out = await runSql(handle, null, `${HYBRID_SQL};`, { q: "session; verification" });
    expect(out).toEqual(rows);
    expect(calls[0].op).toBe("query_sql");
    // The trailing semicolon is stripped by the guard; the `;` inside the
    // embed text is the platform's to embed, not a second statement.
    expect(calls[0].body).toEqual({
      query: "SELECT path FROM hybrid_search('chunks','content','session','embedding', {{q:\"session; verification\"}}, 10)",
    });
  });

  it("rewrites every placeholder, whatever its name, to the fixed name q", () => {
    const sql = "SELECT * FROM vector_search('chunks','embedding', {{first}}, 5) UNION ALL SELECT * FROM vector_search('chunks','embedding', {{second}}, 5)";
    expect(applyPlatformEmbeds(sql, { first: "one", second: "two" })).toBe(
      "SELECT * FROM vector_search('chunks','embedding', {{q:\"one\"}}, 5) UNION ALL SELECT * FROM vector_search('chunks','embedding', {{q:\"two\"}}, 5)",
    );
    expect(applyPlatformEmbeds("SELECT 1", undefined)).toBe("SELECT 1");
  });

  it("refuses embed text the platform placeholder cannot carry, and a missing map, before any request", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, []);
    await expect(runSql(handle, null, HYBRID_SQL, { q: 'say "hi"' })).rejects.toThrow(/contains "\\"", which the platform's/);
    await expect(runSql(handle, null, HYBRID_SQL, { q: "a }} b" })).rejects.toThrow(/contains "}}"/);
    await expect(runSql(handle, null, HYBRID_SQL, undefined)).rejects.toThrow(/no 'embed' map/);
    await expect(runSql(handle, null, HYBRID_SQL, {})).rejects.toThrow(/no 'embed' text supplied for placeholder \{\{q\}\}/);
    expect(calls).toHaveLength(0);
  });

  it("keeps the client embedder's float literal for a client-vector table", async () => {
    const { handle, calls } = hostedHandle(CLIENT_VECTOR_MANIFEST, [{ body: [] }]);
    const { embedder, embedCalls } = fakeEmbedder();
    await runSql(handle, embedder, HYBRID_SQL, { q: "session verification" });
    expect(embedCalls()).toBe(1);
    const query = String(calls[0].body!.query);
    expect(query).toContain("'0.25,0.5'");
    expect(query).not.toContain("{{");
  });

  it("names the missing client embedder for a client-vector table", async () => {
    const { handle, calls } = hostedHandle(CLIENT_VECTOR_MANIFEST, []);
    await expect(runSql(handle, null, HYBRID_SQL, { q: "x" })).rejects.toThrow(/no client-side embedder is configured/);
    expect(calls).toHaveLength(0);
  });

  it("applies the read-only guard before anything goes over the wire", async () => {
    const { handle, calls } = hostedHandle(PLATFORM_MANIFEST, []);
    await expect(runSql(handle, null, "DELETE FROM chunks")).rejects.toThrow(/read-only/);
    await expect(runSql(handle, null, "SELECT 1; SELECT 2")).rejects.toThrow(/single statement/);
    expect(calls).toHaveLength(0);
  });

  it("passes a placeholder-free statement through and returns the rows as they came", async () => {
    const rows = [{ lang: "ts", n: 3 }, { lang: "md", n: 1 }];
    const { handle, calls } = hostedHandle(KEYWORD_MANIFEST, [{ body: rows }]);
    expect(await runSql(handle, null, "SELECT lang, COUNT(*) AS n FROM chunks GROUP BY lang;")).toEqual(rows);
    expect(calls[0].body).toEqual({ query: "SELECT lang, COUNT(*) AS n FROM chunks GROUP BY lang" });
  });
});

// --- telemetry -------------------------------------------------------------------------

describe("hostedTelemetry", () => {
  it("reports the answering call's round trip and metered tokens, for the ledger only", async () => {
    const { handle } = hostedHandle(PLATFORM_MANIFEST, [{ body: [], headers: { "x-infino-read-tokens": "0.050" } }]);
    expect(hostedTelemetry(handle)).toBeUndefined(); // nothing called yet
    const result = await search(handle, null, "q");
    const telemetry = hostedTelemetry(handle);
    expect(telemetry).toMatchObject({ readTokens: 0.05 });
    expect(telemetry!.rttMs).toBeGreaterThanOrEqual(0);
    expect(telemetry).not.toHaveProperty("writeTokens");
    // The result the model sees carries none of it.
    expect(Object.keys(result).sort()).toEqual(["hits", "query", "ranking"]);
  });

  it("is undefined for a local handle", () => {
    expect(hostedTelemetry({})).toBeUndefined();
  });
});
