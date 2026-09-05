// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Hosted mode through config, context and embedder: the command-line surface
// (--db, the key from --api-key-file or INFINO_API_KEY, --embed-provider, the
// client and agent budgets, --analyzer, the forced-off auto switches), opening
// a hosted index against a scripted fake fetch (readiness from list_tables, the
// manifest synthesized from the server or read from a hosted sidecar), and the
// null embedder the platform provider yields. No network, no engine: a hosted
// open never touches a local catalog.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  DEFAULT_DB_TIMEOUT_MS,
  DEFAULT_DB_COLD_START_SECS,
  DEFAULT_HOSTED_EMBED_PROVIDER,
  DEFAULT_SEARCH_K,
  DEFAULT_SUBAGENT_K,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_MAX_WALL_SECS,
  TABLE,
  configureHosted,
  hostedSettingsFromFlags,
  hostedAnalyzer,
  subagentK,
  subagentMaxTurns,
  subagentMaxWallSecs,
  subagentEnabled,
  autoIndexEnabled,
  autoSyncEnabled,
  embedProvider,
  hostedClientOptions,
  hostedLabel,
  hostedTarget,
  isHosted,
  type HostedFlags,
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

// --- settings fixture -----------------------------------------------------------------

/** Environment the tests must not inherit: the key (a developer's real one
 * would leak into the "no key" test) and the pre-existing local knobs. */
const ENV_NAMES = [API_KEY_ENV, "CX_AUTO_INDEX", "CX_AUTO_SYNC", "CX_INDEX_DIR", "CX_ROOT"];

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  configureHosted(null);
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  configureHosted(null);
});

const URL = "https://api.example.test/cx";
const KEY = "inf_test_key_do_not_log";

/** The settings `cx <command> --db URL ...` resolves to, the key coming from a
 * scripted environment rather than the process's own. */
function settingsFor(flags: HostedFlags = {}) {
  return hostedSettingsFromFlags({ db: URL, ...flags }, { [API_KEY_ENV]: KEY });
}

/** Install a hosted target, as the CLI does once it has parsed the flags. */
function hostedMode(flags: HostedFlags = {}): void {
  configureHosted(settingsFor(flags));
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

describe("hosted settings", () => {
  it("is local without --db, and a hosted flag without --db is a usage error, not ignored", () => {
    expect(hostedSettingsFromFlags({}, {})).toBeNull();
    expect(isHosted()).toBe(false);
    expect(hostedTarget()).toBeNull();
    expect(() => hostedSettingsFromFlags({ embedProvider: "platform" }, {})).toThrow(/--embed-provider needs --db <url>/);
    expect(() => hostedSettingsFromFlags({ subagent: true }, {})).toThrow(/--subagent needs --db <url>/);
    expect(() => hostedSettingsFromFlags({ analyzer: "standard" }, {})).toThrow(/--analyzer needs --db <url>/);
    // commander hands an unset boolean flag through as undefined or false; neither is a stray
    expect(hostedSettingsFromFlags({ subagent: false }, {})).toBeNull();
  });

  it("builds the target from --db with the key from INFINO_API_KEY", () => {
    hostedMode();
    expect(isHosted()).toBe(true);
    expect(hostedTarget()).toEqual({ baseUrl: "https://api.example.test", database: "cx", apiKey: KEY });
  });

  it("reads the key from --api-key-file, trimmed, ahead of the environment", () => {
    const file = join(root, "key");
    writeFileSync(file, "inf_from_file\n");
    const settings = hostedSettingsFromFlags({ db: URL, apiKeyFile: file }, { [API_KEY_ENV]: KEY });
    expect(settings?.target.apiKey).toBe("inf_from_file");
    expect(() => hostedSettingsFromFlags({ db: URL, apiKeyFile: join(root, "missing") }, {})).toThrow(/ENOENT/);
  });

  it("names the target without the key", () => {
    expect(hostedLabel({ baseUrl: "https://api.example.test/", database: "cx" })).toBe(URL);
  });

  it("refuses --db with no key rather than failing on the first request", () => {
    expect(() => hostedSettingsFromFlags({ db: URL }, {})).toThrow(new RegExp(`--api-key-file <path> or set ${API_KEY_ENV}`));
    expect(isHosted()).toBe(false);
  });

  it("refuses a plaintext URL for a remote host and allows loopback", () => {
    expect(() => settingsFor({ db: "http://example.com/cx" })).toThrow(/https:\/\/ for a remote host/);
    expect(settingsFor({ db: "http://127.0.0.1:9110/cx" })?.target).toMatchObject({ baseUrl: "http://127.0.0.1:9110", database: "cx" });
  });

  it("embeds on the platform by default for a hosted target, locally for a local index, and refuses a misspelling", () => {
    expect(embedProvider()).toBe("local");
    expect(DEFAULT_HOSTED_EMBED_PROVIDER).toBe("platform");
    hostedMode();
    expect(embedProvider()).toBe("platform");
    hostedMode({ embedProvider: "local" });
    expect(embedProvider()).toBe("local");
    expect(settingsFor({ embedProvider: "Platform" })?.embedProvider).toBe("platform");
    expect(() => settingsFor({ embedProvider: "openai" })).toThrow(/--embed-provider must be "platform" or "local"/);
  });

  it("tunes the client from --db-timeout-ms / --cold-start-secs with the documented defaults", () => {
    expect(hostedClientOptions()).toEqual({ timeoutMs: DEFAULT_DB_TIMEOUT_MS, coldStartSecs: DEFAULT_DB_COLD_START_SECS });
    expect(DEFAULT_DB_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_DB_COLD_START_SECS).toBe(120);
    hostedMode({ dbTimeoutMs: "1500", coldStartSecs: "7" });
    expect(hostedClientOptions()).toEqual({ timeoutMs: 1500, coldStartSecs: 7 });
    expect(() => settingsFor({ dbTimeoutMs: "soon" })).toThrow(/--db-timeout-ms must be a positive integer/);
    expect(() => settingsFor({ coldStartSecs: "0" })).toThrow(/--cold-start-secs must be a positive integer/);
  });

  it("creates the hosted table with ascii_lower unless --analyzer says otherwise, and refuses a name the engine lacks", () => {
    expect(hostedAnalyzer()).toBe("ascii_lower");
    hostedMode();
    expect(hostedAnalyzer()).toBe("ascii_lower");
    hostedMode({ analyzer: "standard" });
    expect(hostedAnalyzer()).toBe("standard");
    expect(() => settingsFor({ analyzer: "icu" })).toThrow(/--analyzer must be "ascii_lower" or "standard"/);
  });

  it("keeps the subagent tool off by default and reads its caps from the flags", () => {
    hostedMode();
    expect(subagentEnabled()).toBe(false);
    expect(subagentMaxTurns()).toBe(DEFAULT_SUBAGENT_MAX_TURNS);
    expect(subagentMaxWallSecs()).toBe(DEFAULT_SUBAGENT_MAX_WALL_SECS);
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(4);
    expect(DEFAULT_SUBAGENT_MAX_WALL_SECS).toBe(120);
    expect(subagentK()).toBe(DEFAULT_SUBAGENT_K);
    expect(DEFAULT_SUBAGENT_K).toBe(DEFAULT_SEARCH_K);
    hostedMode({ subagent: true, subagentMaxTurns: "3", subagentMaxWallSecs: "30", subagentK: "100" });
    expect(subagentEnabled()).toBe(true);
    expect(subagentMaxTurns()).toBe(3);
    expect(subagentMaxWallSecs()).toBe(30);
    expect(subagentK()).toBe(100);
    expect(() => settingsFor({ subagentMaxTurns: "-1" })).toThrow(/--subagent-max-turns must be a positive integer/);
    expect(() => settingsFor({ subagentK: "0" })).toThrow(/--subagent-k must be a positive integer/);
    expect(() => settingsFor({ db: undefined, subagentK: "5" })).toThrow(/--subagent-k needs --db/);
  });

  it("forces auto-index and auto-sync off for a hosted target whatever the env says", () => {
    expect(autoIndexEnabled()).toBe(true);
    expect(autoSyncEnabled()).toBe(true);
    process.env.CX_AUTO_INDEX = "0";
    expect(autoIndexEnabled()).toBe(false);
    delete process.env.CX_AUTO_INDEX;
    hostedMode();
    process.env.CX_AUTO_INDEX = "1";
    process.env.CX_AUTO_SYNC = "true";
    expect(autoIndexEnabled()).toBe(false);
    expect(autoSyncEnabled()).toBe(false);
  });
});

// --- embedder -----------------------------------------------------------------------------

describe("embedder under the platform provider", () => {
  it("creates no embedder and says so", () => {
    hostedMode(); // platform is the hosted default
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
    hostedMode();
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
    hostedMode();
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
    hostedMode();
    const fake = fakeFetch([[TABLE], CLIENT_VECTOR_SCHEMA, COUNTS]);
    const { manifest } = await openIndexAsync(root, { fetch: fake.fetch });
    expect(manifest.vectors).toBe("ready");
    expect(manifest.embedder).toBeUndefined();
  });

  it("records no vectors for a keyword-only table", async () => {
    hostedMode();
    const fake = fakeFetch([[TABLE], KEYWORD_SCHEMA, []]);
    const { manifest } = await openIndexAsync(root, { fetch: fake.fetch });
    expect(manifest.vectors).toBe("none");
    expect(manifest.chunks).toBe(0);
    expect(manifest.files).toBe(0);
    expect(manifest.languages).toEqual({});
  });

  it("trusts a hosted sidecar manifest and skips the schema round trip", async () => {
    hostedMode();
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
    hostedMode();
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
    hostedMode();
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
  it("refuse to open a local catalog while --db is set", () => {
    hostedMode();
    expect(() => openIndex(root)).toThrow(new RegExp(`--db is set \\(${URL.replace(/[.]/g, "\\.")}\\)`));
    expect(() => openForIndexing(root)).toThrow(/--db is set/);
    expect(existsSync(join(root, ".infino"))).toBe(false);
  });

  it("openForIndexingAsync yields the hosted client and the sidecar, no connection, no request", async () => {
    hostedMode();
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
