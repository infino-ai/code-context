// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Hosted mode through config, context and embedder: the environment surface
// (CX_DB_URL, INFINO_API_KEY, CX_EMBED_PROVIDER, the forced-off auto switches),
// opening a hosted index against a scripted fake fetch (readiness from
// list_tables, the manifest synthesized from the server or read from a hosted
// sidecar), and the null embedder the platform provider yields. No network,
// no engine: a hosted open never touches a local catalog.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  DB_URL_ENV,
  EMBED_PROVIDER_ENV,
  DB_TIMEOUT_MS_ENV,
  DB_COLD_START_SECS_ENV,
  RETRIEVAL_AGENT_ENV,
  RETRIEVAL_AGENT_MAX_TURNS_ENV,
  RETRIEVAL_AGENT_MAX_WALL_SECS_ENV,
  DEFAULT_DB_TIMEOUT_MS,
  DEFAULT_DB_COLD_START_SECS,
  DEFAULT_RETRIEVAL_AGENT_MAX_TURNS,
  DEFAULT_RETRIEVAL_AGENT_MAX_WALL_SECS,
  TABLE,
  retrievalAgentMaxTurns,
  retrievalAgentMaxWallSecs,
  retrievalAgentEnabled,
  autoIndexEnabled,
  autoSyncEnabled,
  embedProvider,
  hostedClientOptions,
  hostedLabel,
  hostedTarget,
  isHosted,
} from "../src/core/config.js";
import {
  NoIndexError,
  PLATFORM_DEFAULT_ANALYZER,
  PLATFORM_EMBEDDER_MODEL,
  PLATFORM_EMBEDDER_PROVIDER,
  localDb,
  newHostedMemo,
  openForIndexing,
  openForIndexingAsync,
  openHostedHandle,
  openIndex,
  openIndexAsync,
  hostedDbFor,
} from "../src/core/context.js";
import { INDEX_FORMAT_VERSION, readManifest, writeManifest, type Manifest } from "../src/core/manifest.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo } from "../src/core/embedder.js";

// --- environment fixture ------------------------------------------------------------

const ENV_NAMES = [
  DB_URL_ENV,
  API_KEY_ENV,
  EMBED_PROVIDER_ENV,
  DB_TIMEOUT_MS_ENV,
  DB_COLD_START_SECS_ENV,
  RETRIEVAL_AGENT_ENV,
  RETRIEVAL_AGENT_MAX_TURNS_ENV,
  RETRIEVAL_AGENT_MAX_WALL_SECS_ENV,
  "CX_AUTO_INDEX",
  "CX_AUTO_SYNC",
  "CX_INDEX_DIR",
  "CX_ROOT",
];

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const URL = "https://api.example.test/cx";
const KEY = "inf_test_key_do_not_log";

function hostedEnv(): void {
  process.env[DB_URL_ENV] = URL;
  process.env[API_KEY_ENV] = KEY;
}

// --- the fake fetch -------------------------------------------------------------------

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records every request and answers 200 JSON from a script, in
 * order; an unscripted call is a test failure, so every round trip a path
 * makes is accounted for. */
function fakeFetch(script: unknown[]) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(input), headers, body: typeof init?.body === "string" ? init.body : undefined });
    if (script.length === 0) throw new Error(`fake fetch: no scripted response for call ${calls.length} (${String(input)})`);
    return new Response(JSON.stringify(script.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl, calls };
}

/** The op segment of a recorded request's URL: `/v1/<op>/<db>`. */
const opOf = (call: Recorded): string => call.url.split("/v1/")[1].split("/")[0];

/** The server's schema for a chunks table whose vectors the platform fills. */
const PLATFORM_EMBEDDED_SCHEMA = [
  { name: "path", type: "large_utf8", nullable: true },
  { name: "content", type: "large_utf8", nullable: true },
  { name: "embedding", type: "embedding", source: ["content"], nullable: false },
];

/** A chunks table with client-supplied vectors. */
const CLIENT_VECTOR_SCHEMA = [
  { name: "path", type: "large_utf8", nullable: true },
  { name: "embedding", type: "vector", dim: 4, nullable: true },
];

/** A keyword-only chunks table. */
const KEYWORD_SCHEMA = [
  { name: "path", type: "large_utf8", nullable: true },
  { name: "content", type: "large_utf8", nullable: true },
];

const COUNTS = [
  { lang: "ts", n: 5, f: 2 },
  { lang: "rs", n: 3, f: 1 },
];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-hosted-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- config -----------------------------------------------------------------------------

describe("hosted config", () => {
  it("is local when CX_DB_URL is unset", () => {
    expect(isHosted()).toBe(false);
    expect(hostedTarget()).toBeNull();
  });

  it("builds the target from CX_DB_URL and INFINO_API_KEY", () => {
    hostedEnv();
    expect(isHosted()).toBe(true);
    expect(hostedTarget()).toEqual({ baseUrl: "https://api.example.test", database: "cx", apiKey: KEY });
  });

  it("names the target without the key", () => {
    expect(hostedLabel({ baseUrl: "https://api.example.test/", database: "cx" })).toBe(URL);
  });

  it("refuses a hosted URL with no key rather than failing on the first request", () => {
    process.env[DB_URL_ENV] = URL;
    expect(() => hostedTarget()).toThrow(new RegExp(`${API_KEY_ENV} is not`));
  });

  it("refuses a plaintext URL for a remote host and allows loopback", () => {
    process.env[API_KEY_ENV] = KEY;
    process.env[DB_URL_ENV] = "http://example.com/cx";
    expect(() => hostedTarget()).toThrow(/https:\/\/ for a remote host/);
    process.env[DB_URL_ENV] = "http://127.0.0.1:9110/cx";
    expect(hostedTarget()).toMatchObject({ baseUrl: "http://127.0.0.1:9110", database: "cx" });
  });

  it("reads the embed provider, defaulting to local and rejecting a misspelling", () => {
    expect(embedProvider()).toBe("local");
    process.env[EMBED_PROVIDER_ENV] = "platform";
    expect(embedProvider()).toBe("platform");
    process.env[EMBED_PROVIDER_ENV] = "openai";
    expect(() => embedProvider()).toThrow(/must be "local" or "platform"/);
  });

  it("tunes the client from CX_DB_TIMEOUT_MS / CX_DB_COLD_START_SECS with the documented defaults", () => {
    expect(hostedClientOptions()).toEqual({ timeoutMs: DEFAULT_DB_TIMEOUT_MS, coldStartSecs: DEFAULT_DB_COLD_START_SECS });
    expect(DEFAULT_DB_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_DB_COLD_START_SECS).toBe(120);
    process.env[DB_TIMEOUT_MS_ENV] = "1500";
    process.env[DB_COLD_START_SECS_ENV] = "7";
    expect(hostedClientOptions()).toEqual({ timeoutMs: 1500, coldStartSecs: 7 });
    process.env[DB_TIMEOUT_MS_ENV] = "soon";
    expect(() => hostedClientOptions()).toThrow(/CX_DB_TIMEOUT_MS must be a positive integer/);
  });

  it("keeps the retrieval_agent tool off by default and reads its caps", () => {
    expect(RETRIEVAL_AGENT_ENV).toBe("CX_RETRIEVAL_AGENT");
    expect(RETRIEVAL_AGENT_MAX_TURNS_ENV).toBe("CX_RETRIEVAL_AGENT_MAX_TURNS");
    expect(RETRIEVAL_AGENT_MAX_WALL_SECS_ENV).toBe("CX_RETRIEVAL_AGENT_MAX_WALL_SECS");
    expect(retrievalAgentEnabled()).toBe(false);
    expect(retrievalAgentMaxTurns()).toBe(DEFAULT_RETRIEVAL_AGENT_MAX_TURNS);
    expect(retrievalAgentMaxWallSecs()).toBe(DEFAULT_RETRIEVAL_AGENT_MAX_WALL_SECS);
    expect(DEFAULT_RETRIEVAL_AGENT_MAX_TURNS).toBe(8);
    expect(DEFAULT_RETRIEVAL_AGENT_MAX_WALL_SECS).toBe(120);
    process.env[RETRIEVAL_AGENT_ENV] = "1";
    process.env[RETRIEVAL_AGENT_MAX_TURNS_ENV] = "3";
    process.env[RETRIEVAL_AGENT_MAX_WALL_SECS_ENV] = "30";
    expect(retrievalAgentEnabled()).toBe(true);
    expect(retrievalAgentMaxTurns()).toBe(3);
    expect(retrievalAgentMaxWallSecs()).toBe(30);
  });

  it("forces auto-index and auto-sync off for a hosted target whatever the env says", () => {
    expect(autoIndexEnabled()).toBe(true);
    expect(autoSyncEnabled()).toBe(true);
    process.env.CX_AUTO_INDEX = "0";
    expect(autoIndexEnabled()).toBe(false);
    delete process.env.CX_AUTO_INDEX;
    hostedEnv();
    process.env.CX_AUTO_INDEX = "1";
    process.env.CX_AUTO_SYNC = "true";
    expect(autoIndexEnabled()).toBe(false);
    expect(autoSyncEnabled()).toBe(false);
  });
});

// --- embedder -----------------------------------------------------------------------------

describe("embedder under the platform provider", () => {
  it("creates no embedder and says so", () => {
    process.env[EMBED_PROVIDER_ENV] = "platform";
    expect(createEmbedder()).toBeNull();
    expect(createIndexingEmbedder()).toBeNull();
    expect(embedderInfo()).toBe("platform (server-side)");
  });

  it("describes the local model by default", () => {
    expect(embedderInfo()).toMatch(/^local .* \(no key, no network\)$/);
  });
});

// --- opening a hosted index ---------------------------------------------------------------

describe("openIndexAsync (hosted)", () => {
  it("is ready when list_tables names the chunks table and synthesizes the manifest from the server", async () => {
    hostedEnv();
    const fake = fakeFetch([[TABLE, "other"], PLATFORM_EMBEDDED_SCHEMA, COUNTS]);
    const handle = await openIndexAsync(root, { fetch: fake.fetch });

    expect(handle.hosted).toBeDefined();
    expect(handle.db).toBeUndefined();
    expect(handle.root).toBe(root);
    expect(handle.dir).toBe(join(root, ".infino"));
    expect(handle.target).toBe(URL);

    // Three round trips, all to this database with the bearer key and JSON accept.
    expect(fake.calls.map(opOf)).toEqual(["list_tables", "schema", "query_sql"]);
    for (const call of fake.calls) {
      expect(call.url).toContain("/cx");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers.accept).toBe("application/json");
    }
    expect(JSON.parse(fake.calls[1].body!)).toEqual({ table_name: TABLE });

    const m = handle.manifest;
    expect(m.version).toBe(INDEX_FORMAT_VERSION);
    expect(m.table).toBe(TABLE);
    expect(m.origin).toBe("hosted");
    expect(m.vectors).toBe("ready");
    expect(m.embedder).toEqual({ provider: PLATFORM_EMBEDDER_PROVIDER, model: PLATFORM_EMBEDDER_MODEL });
    expect(m.analyzer).toBe(PLATFORM_DEFAULT_ANALYZER);
    expect(m.analyzer).toBe("standard");
    expect(m.chunks).toBe(8);
    expect(m.files).toBe(3);
    expect(m.languages).toEqual({ ts: 5, rs: 3 });

    // Cached to the sidecar, marked hosted, and no local catalog was created.
    const sidecar = readManifest(handle.dir);
    expect(sidecar).toEqual(m);
    expect(existsSync(join(handle.dir, "_catalog"))).toBe(false);
  });

  it("throws NoIndexError naming the target and the load command when the table is absent", async () => {
    hostedEnv();
    const fake = fakeFetch([["something_else"]]);
    const err = await openIndexAsync(root, { fetch: fake.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoIndexError);
    expect((err as Error).message).toBe(`no ${TABLE} table at ${URL} - load it with \`cx index --db ${URL}\`.`);
    expect((err as Error).message).not.toContain(KEY);
    // Nothing beyond the listing was asked, and no sidecar was written.
    expect(fake.calls.map(opOf)).toEqual(["list_tables"]);
    expect(existsSync(join(root, ".infino"))).toBe(false);
  });

  it("records ready vectors but no embedder for a client-vector column", async () => {
    hostedEnv();
    const fake = fakeFetch([[TABLE], CLIENT_VECTOR_SCHEMA, COUNTS]);
    const { manifest } = await openIndexAsync(root, { fetch: fake.fetch });
    expect(manifest.vectors).toBe("ready");
    expect(manifest.embedder).toBeUndefined();
  });

  it("records no vectors for a keyword-only table", async () => {
    hostedEnv();
    const fake = fakeFetch([[TABLE], KEYWORD_SCHEMA, []]);
    const { manifest } = await openIndexAsync(root, { fetch: fake.fetch });
    expect(manifest.vectors).toBe("none");
    expect(manifest.chunks).toBe(0);
    expect(manifest.files).toBe(0);
    expect(manifest.languages).toEqual({});
  });

  it("trusts a hosted sidecar manifest and skips the schema round trip", async () => {
    hostedEnv();
    const dir = join(root, ".infino");
    const recorded: Manifest = {
      version: INDEX_FORMAT_VERSION,
      table: TABLE,
      origin: "hosted",
      vectors: "none",
      analyzer: "ascii_lower",
      files: 1,
      chunks: 2,
      languages: { ts: 2 },
      indexedAt: new Date().toISOString(),
      indexMs: 12,
    };
    writeManifest(dir, recorded);
    const fake = fakeFetch([[TABLE]]);
    const handle = await openIndexAsync(root, { fetch: fake.fetch });
    expect(handle.manifest).toEqual(recorded);
    expect(handle.manifest.analyzer).toBe("ascii_lower"); // the sidecar's, not the platform default
    expect(fake.calls.map(opOf)).toEqual(["list_tables"]);
  });

  it("does not trust a LOCAL sidecar manifest for a hosted target, and leaves it in place", async () => {
    hostedEnv();
    const dir = join(root, ".infino");
    const local: Manifest = {
      version: INDEX_FORMAT_VERSION,
      table: TABLE,
      vectors: "ready",
      analyzer: "ascii_lower",
      embedder: { provider: "local", model: "Xenova/all-MiniLM-L6-v2", dim: 384 },
      files: 9,
      chunks: 90,
      languages: { ts: 90 },
      indexedAt: new Date().toISOString(),
      indexMs: 12,
    };
    writeManifest(dir, local);
    const fake = fakeFetch([[TABLE], KEYWORD_SCHEMA, COUNTS]);
    const handle = await openIndexAsync(root, { fetch: fake.fetch });
    expect(handle.manifest.origin).toBe("hosted");
    expect(handle.manifest.vectors).toBe("none");
    expect(handle.manifest.analyzer).toBe("standard");
    // The local index's own record survives; the synthesized one lives in memory.
    expect(JSON.parse(readFileSync(join(dir, "codecontext.json"), "utf8"))).toEqual(local);
  });

  it("falls through to the local opener when no hosted target is configured", async () => {
    await expect(openIndexAsync(root)).rejects.toThrow(new RegExp(`no index found under ${root}`));
  });
});

describe("openHostedHandle memo", () => {
  it("lists tables until the table is seen, then never again, and synthesizes once", async () => {
    hostedEnv();
    const fake = fakeFetch([["nope"], [TABLE], PLATFORM_EMBEDDED_SCHEMA, COUNTS]);
    const db = hostedDbFor(hostedTarget()!, { fetch: fake.fetch });
    const memo = newHostedMemo();
    const dir = join(root, ".infino");

    expect(await openHostedHandle(db, root, dir, memo)).toBeNull();
    expect(memo.ready).toBe(false);

    const first = await openHostedHandle(db, root, dir, memo);
    expect(first?.manifest.vectors).toBe("ready");
    expect(memo.ready).toBe(true);
    expect(fake.calls.map(opOf)).toEqual(["list_tables", "list_tables", "schema", "query_sql"]);

    // A hosted sidecar was written by the synthesis, so the next call reads it
    // and makes no request at all.
    const second = await openHostedHandle(db, root, dir, memo);
    expect(second?.manifest).toEqual(first?.manifest);
    expect(fake.calls).toHaveLength(4);

    // Without a sidecar the memoized synthesis serves, still with no request.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const third = await openHostedHandle(db, root, dir, memo);
    expect(third?.manifest).toEqual(first?.manifest);
    expect(fake.calls).toHaveLength(4);
  });
});

describe("the sync openers in hosted mode", () => {
  it("refuse to open a local catalog while CX_DB_URL is set", () => {
    hostedEnv();
    expect(() => openIndex(root)).toThrow(new RegExp(`${DB_URL_ENV} is set \\(${URL.replace(/[.]/g, "\\.")}\\)`));
    expect(() => openForIndexing(root)).toThrow(new RegExp(`${DB_URL_ENV} is set`));
    expect(existsSync(join(root, ".infino"))).toBe(false);
  });

  it("openForIndexingAsync yields the hosted client and the sidecar, no connection, no request", async () => {
    hostedEnv();
    const fake = fakeFetch([]);
    const target = await openForIndexingAsync(root, { fetch: fake.fetch });
    expect(target.hosted).toBeDefined();
    expect(target.db).toBeUndefined();
    expect(target.target).toBe(URL);
    expect(target.dir).toBe(join(root, ".infino"));
    expect(fake.calls).toHaveLength(0);
  });
});

describe("localDb", () => {
  it("names a hosted target when a local-only path reaches it", () => {
    expect(() => localDb({ target: URL })).toThrow(new RegExp(`${URL.replace(/[.]/g, "\\.")} is a hosted target`));
  });
});
