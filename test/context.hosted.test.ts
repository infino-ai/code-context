// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The platform database through config, context, manifest and embedder: the
// command-line surface (--db, the key from --api-key-file or INFINO_API_KEY,
// --embed-provider, the client and agent budgets, --analyzer), what opening an
// index yields with and without a database (the local index always; the
// platform client beside it for a build), the two manifests in one index dir,
// the platform table's readiness memo, and the embedder that is local either
// way. No network is touched; the engine catalogs opened live in temp dirs.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  DEFAULT_DB_TIMEOUT_MS,
  DEFAULT_DB_COLD_START_SECS,
  DEFAULT_EXPLORE_MAX_WALL_SECS,
  DEFAULT_HOSTED_EMBED_PROVIDER,
  DEFAULT_SEARCH_K,
  DEFAULT_SUBAGENT_K,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_MAX_WALL_SECS,
  MANIFEST_NAME,
  PLATFORM_MANIFEST_NAME,
  TABLE,
  configureHosted,
  hostedSettingsFromFlags,
  hostedAnalyzer,
  exploreMaxTurns,
  exploreMaxWallSecs,
  subagentK,
  subagentMaxTurns,
  subagentMaxWallSecs,
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
  hostedDbFor,
  newHostedMemo,
  openForIndexing,
  openIndex,
  platformLabel,
  platformTableReady,
} from "../src/core/context.js";
import {
  INDEX_FORMAT_VERSION,
  emptyManifest,
  readManifest,
  readPlatformManifest,
  writeManifest,
  writePlatformManifest,
  type Manifest,
} from "../src/core/manifest.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, platformEmbedderInfo } from "../src/core/embedder.js";

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

/** Install a platform database, as the CLI does once it has parsed the flags. */
function withPlatform(flags: HostedFlags = {}): void {
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-platform-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- config -----------------------------------------------------------------------------

describe("platform settings", () => {
  it("is null without --db, and a platform flag without --db is a usage error, not ignored", () => {
    expect(hostedSettingsFromFlags({}, {})).toBeNull();
    expect(isHosted()).toBe(false);
    expect(hostedTarget()).toBeNull();
    expect(() => hostedSettingsFromFlags({ embedProvider: "platform" }, {})).toThrow(/--embed-provider needs --db <url>/);
    expect(() => hostedSettingsFromFlags({ analyzer: "standard" }, {})).toThrow(/--analyzer needs --db <url>/);
    expect(() => hostedSettingsFromFlags({ subagentK: "5" }, {})).toThrow(/--subagent-k needs --db/);
    expect(() => hostedSettingsFromFlags({ exploreMaxWallSecs: "5" }, {})).toThrow(/--explore-max-wall-secs needs --db/);
  });

  it("builds the target from --db with the key from INFINO_API_KEY", () => {
    withPlatform();
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

  it("fills the platform table's vectors on the platform by default, refuses a misspelling", () => {
    expect(DEFAULT_HOSTED_EMBED_PROVIDER).toBe("platform");
    expect(embedProvider()).toBe("platform");
    withPlatform();
    expect(embedProvider()).toBe("platform");
    withPlatform({ embedProvider: "local" });
    expect(embedProvider()).toBe("local");
    expect(settingsFor({ embedProvider: "Platform" })?.embedProvider).toBe("platform");
    expect(() => settingsFor({ embedProvider: "openai" })).toThrow(/--embed-provider must be "platform" or "local"/);
  });

  it("tunes the client from --db-timeout-ms / --cold-start-secs with the documented defaults", () => {
    expect(hostedClientOptions()).toEqual({ timeoutMs: DEFAULT_DB_TIMEOUT_MS, coldStartSecs: DEFAULT_DB_COLD_START_SECS });
    expect(DEFAULT_DB_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_DB_COLD_START_SECS).toBe(120);
    withPlatform({ dbTimeoutMs: "1500", coldStartSecs: "7" });
    expect(hostedClientOptions()).toEqual({ timeoutMs: 1500, coldStartSecs: 7 });
    expect(() => settingsFor({ dbTimeoutMs: "soon" })).toThrow(/--db-timeout-ms must be a positive integer/);
    expect(() => settingsFor({ coldStartSecs: "0" })).toThrow(/--cold-start-secs must be a positive integer/);
  });

  it("asks for an analyzer only when --analyzer names one, and refuses a name the engine lacks", () => {
    // Absent, a build keeps the table's own analyzer (the default for a first
    // load lives in the indexer) and a sync asks for nothing.
    expect(hostedAnalyzer()).toBeUndefined();
    withPlatform();
    expect(hostedAnalyzer()).toBeUndefined();
    withPlatform({ analyzer: "standard" });
    expect(hostedAnalyzer()).toBe("standard");
    expect(() => settingsFor({ analyzer: "icu" })).toThrow(/--analyzer must be "ascii_lower" or "standard"/);
  });

  it("reads the platform tools' caps from the flags, with the documented defaults", () => {
    withPlatform();
    expect(subagentMaxTurns()).toBe(DEFAULT_SUBAGENT_MAX_TURNS);
    expect(subagentMaxWallSecs()).toBe(DEFAULT_SUBAGENT_MAX_WALL_SECS);
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(4);
    expect(DEFAULT_SUBAGENT_MAX_WALL_SECS).toBe(120);
    expect(subagentK()).toBe(DEFAULT_SUBAGENT_K);
    expect(DEFAULT_SUBAGENT_K).toBe(DEFAULT_SEARCH_K);
    withPlatform({ subagentMaxTurns: "3", subagentMaxWallSecs: "30", subagentK: "100" });
    expect(subagentMaxTurns()).toBe(3);
    expect(subagentMaxWallSecs()).toBe(30);
    expect(subagentK()).toBe(100);
    expect(() => settingsFor({ subagentMaxTurns: "-1" })).toThrow(/--subagent-max-turns must be a positive integer/);
    expect(() => settingsFor({ subagentK: "0" })).toThrow(/--subagent-k must be a positive integer/);
  });

  it("leaves explore's turn cap to the platform unless a flag names one, and gives it its own wall", () => {
    withPlatform();
    expect(exploreMaxTurns()).toBeUndefined();
    expect(exploreMaxWallSecs()).toBe(DEFAULT_EXPLORE_MAX_WALL_SECS);
    expect(DEFAULT_EXPLORE_MAX_WALL_SECS).toBe(300);
    withPlatform({ exploreMaxTurns: "12", exploreMaxWallSecs: "600" });
    expect(exploreMaxTurns()).toBe(12);
    expect(exploreMaxWallSecs()).toBe(600);
    expect(() => settingsFor({ exploreMaxTurns: "x" })).toThrow(/--explore-max-turns must be a positive integer/);
  });

  it("leaves auto-index and auto-sync to the env with or without a database - both write both places", () => {
    expect(autoIndexEnabled()).toBe(true);
    expect(autoSyncEnabled()).toBe(true);
    withPlatform();
    expect(autoIndexEnabled()).toBe(true);
    expect(autoSyncEnabled()).toBe(true);
    process.env.CX_AUTO_INDEX = "0";
    process.env.CX_AUTO_SYNC = "false";
    expect(autoIndexEnabled()).toBe(false);
    expect(autoSyncEnabled()).toBe(false);
  });
});

// --- embedder -----------------------------------------------------------------------------

describe("the embedder with a platform database configured", () => {
  it("is the local model either way; only the platform table's description changes", () => {
    expect(embedderInfo()).toMatch(/^local .* \(no key, no network\)$/);
    withPlatform();
    expect(createEmbedder()).not.toBeNull();
    expect(createEmbedder()!.provider).toBe("local");
    expect(createIndexingEmbedder()).not.toBeNull();
    expect(embedderInfo()).toMatch(/^local .* \(no key, no network\)$/);
    expect(platformEmbedderInfo()).toBe("platform (server-side)");
    withPlatform({ embedProvider: "local" });
    expect(platformEmbedderInfo()).toMatch(/^local .*, vectors shipped$/);
  });
});

// --- opening the index --------------------------------------------------------------------

describe("openIndex", () => {
  it("reads the local index whether or not a database is configured, and names the root when there is none", () => {
    expect(() => openIndex(root)).toThrow(NoIndexError);
    expect(() => openIndex(root)).toThrow(new RegExp(`no index found under ${root}`));
    withPlatform();
    expect(() => openIndex(root)).toThrow(NoIndexError);
    expect(existsSync(join(root, ".infino"))).toBe(false);
  });

  it("opens the local catalog from its manifest, never the platform table's", () => {
    const dir = join(root, ".infino");
    writeManifest(dir, { ...emptyManifest(), files: 1, chunks: 2 });
    withPlatform();
    const handle = openIndex(root);
    expect(handle.root).toBe(root);
    expect(handle.dir).toBe(dir);
    expect(handle.target).toBe(dir);
    expect(handle.db).toBeDefined();
    expect(handle.manifest.chunks).toBe(2);
    expect(handle.manifest.origin).toBeUndefined();
  });

  it("does not take the platform manifest for the local one (an index dir from before the split)", () => {
    const dir = join(root, ".infino");
    // A pre-split build of the platform table wrote its manifest under the
    // local name; it describes no local catalog and must read as absent.
    writeFileSync(
      join(dir, MANIFEST_NAME).replace(dir, (() => {
        // ensure the dir exists first
        writeManifest(dir, emptyManifest());
        return dir;
      })()),
      JSON.stringify({ ...emptyManifest(), origin: "hosted" }),
    );
    expect(readManifest(dir)).toBeUndefined();
    expect(() => openIndex(root)).toThrow(NoIndexError);
  });
});

describe("openForIndexing", () => {
  it("yields the local connection alone without a database", () => {
    const target = openForIndexing(root);
    expect(target.db).toBeDefined();
    expect(target.hosted).toBeUndefined();
    expect(target.dir).toBe(join(root, ".infino"));
    expect(target.target).toBe(target.dir);
  });

  it("yields the local connection AND the platform client with a database, making no request", () => {
    withPlatform();
    const fake = fakeFetch([]);
    const target = openForIndexing(root, { fetch: fake.fetch });
    expect(target.db).toBeDefined();
    expect(target.hosted).toBeDefined();
    expect(target.target).toBe(join(root, ".infino"));
    expect(platformLabel(target.hosted!)).toBe(URL);
    expect(fake.calls).toHaveLength(0);
  });
});

// --- the platform table's readiness ------------------------------------------------------

describe("platformTableReady", () => {
  it("lists tables until the table is seen, then never again", async () => {
    withPlatform();
    const fake = fakeFetch([["nope"], [TABLE, "other"]]);
    const db = hostedDbFor(hostedTarget()!, { fetch: fake.fetch });
    const memo = newHostedMemo();

    expect(await platformTableReady(db, memo)).toBe(false);
    expect(memo.ready).toBe(false);
    expect(await platformTableReady(db, memo)).toBe(true);
    expect(memo.ready).toBe(true);
    expect(await platformTableReady(db, memo)).toBe(true);
    expect(fake.calls.map(opOf)).toEqual(["list_tables", "list_tables"]);
    for (const call of fake.calls) {
      expect(call.url).toContain("/cx");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("tunes the client from the settings and labels it without the key", () => {
    withPlatform({ dbTimeoutMs: "1500" });
    const db = hostedDbFor(hostedTarget()!);
    expect(platformLabel(db)).toBe(URL);
    expect(platformLabel(db)).not.toContain(KEY);
  });
});

// --- the two manifests --------------------------------------------------------------------

describe("the two manifests", () => {
  it("live in separate files and each reader rejects the other's origin", () => {
    const dir = join(root, ".infino");
    const local: Manifest = { ...emptyManifest(), files: 2, chunks: 5, analyzer: "ascii_lower" };
    const platform: Manifest = { ...emptyManifest(), files: 2, chunks: 5, analyzer: "standard", embedder: { provider: "platform", model: "server-side" } };
    writeManifest(dir, local);
    writePlatformManifest(dir, platform);
    expect(existsSync(join(dir, MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(dir, PLATFORM_MANIFEST_NAME))).toBe(true);

    expect(readManifest(dir)).toEqual(local);
    expect(readManifest(dir)!.origin).toBeUndefined();
    const read = readPlatformManifest(dir)!;
    expect(read.origin).toBe("hosted"); // forced by the writer
    expect(read.analyzer).toBe("standard");
    expect(read.embedder).toEqual({ provider: "platform", model: "server-side" });
    expect(read.version).toBe(INDEX_FORMAT_VERSION);
  });

  it("reads the platform manifest as absent when there is none, or when the file describes a local index", () => {
    const dir = join(root, ".infino");
    expect(readPlatformManifest(dir)).toBeUndefined();
    writeManifest(dir, emptyManifest());
    expect(readPlatformManifest(dir)).toBeUndefined();
    writeFileSync(join(dir, PLATFORM_MANIFEST_NAME), JSON.stringify(emptyManifest()));
    expect(readPlatformManifest(dir)).toBeUndefined();
  });
});
