// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The hosted load and sync paths of the indexer against a scripted fake
// platform: the table lifecycle (drop only when present, create with the
// analyzer and the right vector column and indexes), the append encodings
// (Arrow IPC waves for client vectors, the JSON envelope for a
// platform-embedded table), the sidecar the load leaves behind (hosted
// manifest, file state, no spills, no local catalog), the platform-side cost
// in the stats, and the incremental sync as delete-by-predicate plus append.
// No network and no engine: the fake answers every `/v1/<op>/<db>` route.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as arrow from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPEND_BATCH, TABLE } from "../src/core/config.js";
import { HostedDb } from "../src/core/hosted.js";
import { FTS_ANALYZER_ENV, hostedAnalyzer, indexRepo, indexRepoStaged, syncRepo, type IndexOptions, type SyncResult } from "../src/core/indexer.js";
import { readManifest, writeManifest, INDEX_FORMAT_VERSION, type Manifest } from "../src/core/manifest.js";
import { readFileState } from "../src/core/filestate.js";
import type { Embedder } from "../src/core/embedder.js";

// --- fixtures -------------------------------------------------------------------------

/** Engine minimum vector width; also what the fake embedder produces. */
const DIM = 16;

/** Plain-text files chunk as fixed 60-line windows stepping 50 lines, so a
 * file of this many lines yields 100 chunks without tree-sitter. */
const LINES_PER_BIG_FILE = 5001;
const CHUNKS_PER_BIG_FILE = 100;

/** Files in the big fixture: enough chunks to cross APPEND_BATCH (512) so the
 * append path runs multi-wave. */
const BIG_FILES = 6;

/** The small fixture: three short text files, one chunk each. */
const SMALL_LINES = 12;

/** Write tokens the fake stamps on every write response. */
const WRITE_TOKENS_PER_CALL = 0.5;

const KEY = "inf_test_key_do_not_log";
const TARGET = { baseUrl: "https://api.example.test", database: "cx", apiKey: KEY };

const TEXT_COLUMNS = [
  { name: "path", type: "large_utf8" },
  { name: "start_line", type: "int32" },
  { name: "end_line", type: "int32" },
  { name: "lang", type: "large_utf8" },
  { name: "symbol", type: "large_utf8" },
  { name: "content", type: "large_utf8" },
];

const TEXT_FIELDS = TEXT_COLUMNS.map((c) => c.name);

function vectorFor(t: string): number[] {
  const v = new Array<number>(DIM).fill(0.01);
  for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) / 1000;
  return v;
}

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(vectorFor),
  embedToFloat32: async (texts) => {
    const vectors = new Float32Array(texts.length * DIM);
    texts.forEach((t, i) => vectors.set(vectorFor(t), i * DIM));
    return { vectors, dim: DIM };
  },
  dim: async () => DIM,
  provider: "fake",
  model: "fake-16d",
};

function textFile(name: number, lines: number, marker: string): string {
  return Array.from({ length: lines }, (_, i) => `file ${name} line ${i + 1} ${marker}`).join("\n") + "\n";
}

function writeBigFixture(root: string): void {
  mkdirSync(join(root, "docs"), { recursive: true });
  for (let f = 0; f < BIG_FILES; f++) {
    writeFileSync(join(root, "docs", `big${f}.txt`), textFile(f, LINES_PER_BIG_FILE, `bigmarker${f}`));
  }
}

function writeSmallFixture(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let f = 0; f < 3; f++) {
    writeFileSync(join(root, "src", `small${f}.txt`), textFile(f, SMALL_LINES, `smallmarker${f}`));
  }
}

// --- the fake platform -----------------------------------------------------------------

interface Call {
  op: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** A JSON body, parsed. */
  json?: unknown;
  /** An Arrow IPC body, decoded. */
  ipc?: arrow.Table;
}

type Row = Record<string, unknown>;

/** A platform database with one table registry and a row mirror of the chunks
 * table (path and lang only - enough to answer the sync's recount), driven by
 * op. Every write response carries a write-tokens header. */
function fakePlatform(tables: string[] = []) {
  const calls: Call[] = [];
  const live = new Set(tables);
  let rows: Row[] = [];

  const respond = (value: unknown, write = false): Response =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(write ? { "x-infino-write-tokens": String(WRITE_TOKENS_PER_CALL) } : {}),
      },
    });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const op = url.split("/v1/")[1].split(/[/?]/)[0];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { op, url, method: init?.method ?? "GET", headers };
    const body = init?.body;
    if (typeof body === "string") call.json = JSON.parse(body);
    else if (body instanceof Uint8Array) call.ipc = arrow.tableFromIPC(body);
    calls.push(call);

    switch (op) {
      case "list_tables":
        return respond([...live]);
      case "drop_table":
        live.delete((call.json as { table_name: string }).table_name);
        rows = [];
        return respond({}, true);
      case "create_table":
        live.add((call.json as { table_name: string }).table_name);
        rows = [];
        return respond({}, true);
      case "append": {
        const appended: Row[] = call.ipc
          ? call.ipc.toArray().map((r) => ({ path: String(r.path), lang: String(r.lang) }))
          : (call.json as { data: Row[] }).data;
        rows.push(...appended);
        return respond({}, true);
      }
      case "delete": {
        const predicate = new URL(url).searchParams.get("predicate") ?? "";
        const gone = new Set([...predicate.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")));
        const before = rows.length;
        rows = rows.filter((r) => !gone.has(String(r.path)));
        const n = before - rows.length;
        return respond({ matched: n, n_tombstoned: n, n_not_found: 0 }, true);
      }
      case "query_sql": {
        const sql = (call.json as { query: string }).query;
        if (sql.includes("GROUP BY lang")) {
          const byLang = new Map<string, number>();
          for (const r of rows) byLang.set(String(r.lang), (byLang.get(String(r.lang)) ?? 0) + 1);
          return respond([...byLang].map(([lang, n]) => ({ lang, n })));
        }
        return respond([{ n: rows.length, f: new Set(rows.map((r) => r.path)).size }]);
      }
      default:
        return new Response(`unexpected op ${op}`, { status: 400 });
    }
  };

  return {
    fetch: fetchImpl,
    calls,
    ops: () => calls.map((c) => c.op),
    rows: () => rows,
    db: () => new HostedDb(TARGET, { fetch: fetchImpl }),
  };
}

const createBody = (call: Call) => call.json as { table_name: string; schema: Row[]; indexes: Row };

const sidecarFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

// --- environment ------------------------------------------------------------------------

let root: string;
let dir: string;
let savedAnalyzer: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-hosted-index-"));
  dir = join(root, ".infino");
  savedAnalyzer = process.env[FTS_ANALYZER_ENV];
  delete process.env[FTS_ANALYZER_ENV];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedAnalyzer === undefined) delete process.env[FTS_ANALYZER_ENV];
  else process.env[FTS_ANALYZER_ENV] = savedAnalyzer;
});

// --- the analyzer knob -------------------------------------------------------------------

describe("hostedAnalyzer", () => {
  it("defaults to ascii_lower, the analyzer that finds code identifiers whole, and declares it", () => {
    expect(hostedAnalyzer()).toBe("ascii_lower");
  });

  it("reads CX_FTS_ANALYZER and refuses a name the engine does not have", () => {
    process.env[FTS_ANALYZER_ENV] = "ascii_lower";
    expect(hostedAnalyzer()).toBe("ascii_lower");
    process.env[FTS_ANALYZER_ENV] = "standard";
    expect(hostedAnalyzer()).toBe("standard");
    process.env[FTS_ANALYZER_ENV] = "icu";
    expect(() => hostedAnalyzer()).toThrow(/CX_FTS_ANALYZER must be "standard" or "ascii_lower"/);
  });
});

// --- the hosted load -----------------------------------------------------------------------

describe("hosted load (client vectors)", () => {
  it("drops the old table, creates one with the analyzer and a cosine index, and appends IPC waves", async () => {
    writeBigFixture(root);
    const platform = fakePlatform([TABLE, "other"]);
    const phases: string[] = [];
    const stats = await indexRepo({
      root,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: fakeEmbedder,
      onPhase: (p) => phases.push(p),
    });

    expect(stats.files).toBe(BIG_FILES);
    expect(stats.chunks).toBe(BIG_FILES * CHUNKS_PER_BIG_FILE);
    expect(stats.chunks).toBeGreaterThan(APPEND_BATCH);
    expect(stats.vectors).toBe("ready");
    expect(stats.embedMs).toBeGreaterThanOrEqual(0);
    expect(stats.embedError).toBeUndefined();
    // Embedding runs before the table is touched; the load is one pass.
    expect(phases).toEqual(["scan", "chunk", "embed", "load"]);

    // The lifecycle: the existing table goes, one create, one append per wave.
    const waves = Math.ceil(stats.chunks / APPEND_BATCH);
    expect(platform.ops()).toEqual(["list_tables", "drop_table", "create_table", ...Array<string>(waves).fill("append")]);
    for (const call of platform.calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(platform.calls[1].json).toEqual({ table_name: TABLE, purge: true });

    const created = createBody(platform.calls[2]);
    expect(created.table_name).toBe(TABLE);
    expect(created.schema).toEqual([...TEXT_COLUMNS, { name: "embedding", type: "vector", dim: DIM }]);
    expect(created.indexes).toEqual({
      fts: [{ column: "content", analyzer: "ascii_lower" }],
      vector: [{ column: "embedding", metric: "cosine" }],
    });

    // Every wave is an Arrow IPC stream with the table's schema; the first is
    // a full batch and the rows add up to the chunk count.
    const appends = platform.calls.filter((c) => c.op === "append");
    expect(appends).toHaveLength(waves);
    for (const a of appends) {
      expect(a.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
      expect(a.url).toBe(`https://api.example.test/v1/append/cx?table=${TABLE}`);
      const fields = a.ipc!.schema.fields;
      expect(fields.map((f) => f.name)).toEqual([...TEXT_FIELDS, "embedding"]);
      const embedding = fields[fields.length - 1].type as arrow.FixedSizeList;
      expect(embedding).toBeInstanceOf(arrow.FixedSizeList);
      expect(embedding.listSize).toBe(DIM);
    }
    expect(appends[0].ipc!.numRows).toBe(APPEND_BATCH);
    expect(appends.reduce((n, a) => n + a.ipc!.numRows, 0)).toBe(stats.chunks);
    // The first row of the first wave is the first chunk of the first file,
    // with its own vector.
    const first = appends[0].ipc!.get(0)!;
    expect(String(first.path)).toBe("docs/big0.txt");
    expect(Number(first.start_line)).toBe(1);
    expect(String(first.content)).toContain("bigmarker0");
    const vector = Array.from((first.embedding as arrow.Vector).toArray() as Float32Array);
    expect(vector).toHaveLength(DIM);
    expect(vector.some((x) => x !== 0)).toBe(true);

    // The platform-side cost: one meter per write, appends counted.
    expect(stats.hosted).toBeDefined();
    expect(stats.hosted!.appendCalls).toBe(waves);
    expect(stats.hosted!.writeTokens).toBeCloseTo(WRITE_TOKENS_PER_CALL * (2 + waves));
    expect(stats.hosted!.loadWallMs).toBeGreaterThanOrEqual(0);

    // The sidecar: a hosted manifest, the file state, no spills, no catalog.
    const manifest = readManifest(dir)!;
    expect(manifest.origin).toBe("hosted");
    expect(manifest.analyzer).toBe("ascii_lower");
    expect(manifest.vectors).toBe("ready");
    expect(manifest.embedder).toEqual({ provider: "fake", model: "fake-16d", dim: DIM });
    expect(manifest.chunks).toBe(stats.chunks);
    expect(manifest.files).toBe(BIG_FILES);
    expect(manifest.languages).toEqual({ txt: stats.chunks });
    expect(Object.keys(readFileState(dir)!.files).sort()).toEqual(
      Array.from({ length: BIG_FILES }, (_, f) => `docs/big${f}.txt`).sort(),
    );
    expect(sidecarFiles(dir)).toEqual(["codecontext.json", "filestate.json"]);
  });

  it("does not drop a table that is not there", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform([]);
    await indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(platform.ops()).toEqual(["list_tables", "create_table", "append"]);
  });

  it("names the analyzer it was given to the platform and records it", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    await indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, analyzer: "standard" });
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.indexes).toEqual({
      fts: [{ column: "content", analyzer: "standard" }],
      vector: [{ column: "embedding", metric: "cosine" }],
    });
    expect(readManifest(dir)!.analyzer).toBe("standard");
  });

  it("indexes an empty tree to an empty, complete table", async () => {
    // One binary file: walked and fingerprinted, zero chunks.
    writeFileSync(join(root, "blob.txt"), Buffer.from([0, 1, 2, 0, 3]));
    const platform = fakePlatform();
    const stats = await indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(stats.chunks).toBe(0);
    expect(stats.vectors).toBe("ready");
    expect(stats.hosted!.appendCalls).toBe(0);
    // The schema still carries the vector column at the embedder's width.
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema[created.schema.length - 1]).toEqual({ name: "embedding", type: "vector", dim: DIM });
    expect(platform.ops()).toEqual(["list_tables", "create_table"]);
    expect(sidecarFiles(dir)).toEqual(["codecontext.json", "filestate.json"]);
  });

  it("returns the finished stats as both text and completion", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    const run = await indexRepoStaged({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(run.text.vectors).toBe("ready");
    expect(await run.completion).toBe(run.text);
  });
});

describe("hosted load (platform embeds)", () => {
  it("declares an embedding column, no vector index, and appends JSON rows without it", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform([TABLE]);
    const phases: string[] = [];
    const stats = await indexRepo({
      root,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: null,
      embedProvider: "platform",
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(["scan", "chunk", "load"]);
    expect(stats.vectors).toBe("ready");
    expect(stats.embedMs).toBeUndefined();

    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema).toEqual([...TEXT_COLUMNS, { name: "embedding", type: "embedding", source: ["content"] }]);
    // The platform indexes an embedding column by itself; a vector entry for
    // it would be a 400.
    expect(created.indexes).toEqual({ fts: [{ column: "content", analyzer: "ascii_lower" }] });

    const appends = platform.calls.filter((c) => c.op === "append");
    expect(appends).toHaveLength(1);
    expect(appends[0].headers["content-type"]).toBe("application/json");
    expect(appends[0].ipc).toBeUndefined();
    const { data } = appends[0].json as { data: Row[] };
    expect(data).toHaveLength(stats.chunks);
    for (const row of data) {
      expect(Object.keys(row).sort()).toEqual([...TEXT_FIELDS].sort());
      expect(row).not.toHaveProperty("embedding");
    }
    expect(stats.hosted!.appendCalls).toBe(1);

    const manifest = readManifest(dir)!;
    expect(manifest.origin).toBe("hosted");
    expect(manifest.vectors).toBe("ready");
    expect(manifest.embedder).toEqual({ provider: "platform", model: "server-side" });
  });

  it("refuses a local embedder alongside the platform provider before any request", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    await expect(
      indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "platform" }),
    ).rejects.toThrow(/embedProvider is "platform"/);
    expect(platform.calls).toHaveLength(0);
  });
});

describe("hosted load (keyword only)", () => {
  it("creates a text-only table with the FTS index and appends IPC", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    const stats = await indexRepo({ root, hosted: platform.db(), indexDirPath: dir });
    expect(stats.vectors).toBe("none");
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema).toEqual(TEXT_COLUMNS);
    expect(created.indexes).toEqual({ fts: [{ column: "content", analyzer: "ascii_lower" }] });
    const append = platform.calls.find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(append.ipc!.schema.fields.map((f) => f.name)).toEqual(TEXT_FIELDS);
    const manifest = readManifest(dir)!;
    expect(manifest.vectors).toBe("none");
    expect(manifest.embedder).toBeUndefined();
    expect(manifest.origin).toBe("hosted");
  });
});

describe("hosted load failures", () => {
  it("an embed failure throws before the table is touched, with the spills cleaned up", async () => {
    writeSmallFixture(root);
    const broken: Embedder = {
      ...fakeEmbedder,
      embedToFloat32: async () => {
        throw new Error("model download failed");
      },
    };
    const platform = fakePlatform([TABLE]);
    await expect(indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: broken })).rejects.toThrow(
      "model download failed",
    );
    // Nothing went over the wire: the previous table stands.
    expect(platform.calls).toHaveLength(0);
    expect(sidecarFiles(dir).filter((f) => f.startsWith("spill."))).toEqual([]);
    expect(readManifest(dir)).toBeUndefined();
  });
});

// --- the hosted sync -------------------------------------------------------------------------

describe("hosted sync", () => {
  const load = async (platform: ReturnType<typeof fakePlatform>, extra: Partial<IndexOptions> = {}) => {
    writeSmallFixture(root);
    return indexRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, ...extra });
  };

  it("applies a diff as a path-predicate delete plus an append wave, then recounts", async () => {
    const platform = fakePlatform();
    const stats = await load(platform);
    const beforeCalls = platform.calls.length;

    writeFileSync(join(root, "src", "small0.txt"), textFile(0, SMALL_LINES, "changedmarker"));
    writeFileSync(join(root, "src", "added.txt"), textFile(9, SMALL_LINES, "addedmarker"));
    unlinkSync(join(root, "src", "small2.txt"));

    const outcome = (await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(outcome.filesAdded).toBe(1);
    expect(outcome.filesChanged).toBe(1);
    expect(outcome.filesDeleted).toBe(1);

    const ops = platform.calls.slice(beforeCalls).map((c) => c.op);
    expect(ops).toEqual(["list_tables", "delete", "append", "query_sql", "query_sql"]);
    // The stale rows of the changed, added and deleted paths go in one
    // predicate (a re-run of an interrupted sync stays idempotent).
    const del = platform.calls.slice(beforeCalls).find((c) => c.op === "delete")!;
    const url = new URL(del.url);
    expect(url.searchParams.get("table")).toBe(TABLE);
    expect(url.searchParams.get("predicate")).toBe("path IN ('src/added.txt','src/small0.txt','src/small2.txt')");
    // Two rows were live for those paths (added.txt had none).
    expect(outcome.chunksRemoved).toBe(2);
    // The fresh chunks ride one IPC wave, embedded, at the table's width.
    const append = platform.calls.slice(beforeCalls).find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(append.ipc!.numRows).toBe(outcome.chunksAdded);
    expect(outcome.chunksAdded).toBe(2);
    expect((append.ipc!.schema.fields.at(-1)!.type as arrow.FixedSizeList).listSize).toBe(DIM);

    // Totals come from the server's counts and land in the manifest.
    expect(outcome.chunks).toBe(stats.chunks - 2 + 2);
    expect(outcome.files).toBe(3);
    expect(outcome.vectors).toBe("ready");
    expect(outcome.hosted).toMatchObject({ appendCalls: 1 });
    expect(outcome.hosted!.writeTokens).toBeCloseTo(WRITE_TOKENS_PER_CALL * 2);
    const manifest = readManifest(dir)!;
    expect(manifest.chunks).toBe(outcome.chunks);
    expect(manifest.origin).toBe("hosted");
    expect(Object.keys(readFileState(dir)!.files).sort()).toEqual(["src/added.txt", "src/small0.txt", "src/small1.txt"]);
    expect(platform.rows().map((r) => r.path).sort()).toEqual(["src/added.txt", "src/small0.txt", "src/small1.txt"]);
  });

  it("no-ops on an unchanged tree with one readiness round trip and no write", async () => {
    const platform = fakePlatform();
    await load(platform);
    const beforeCalls = platform.calls.length;
    const outcome = await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(outcome.action).toBe("noop");
    expect(platform.calls.slice(beforeCalls).map((c) => c.op)).toEqual(["list_tables"]);
  });

  it("asks for a full reload when the sidecar has no file state (table loaded elsewhere)", async () => {
    const platform = fakePlatform();
    await load(platform);
    unlinkSync(join(dir, "filestate.json"));
    const beforeCalls = platform.calls.length;
    const outcome = await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/no file state for the hosted table/);
    expect(platform.calls).toHaveLength(beforeCalls);
  });

  it("does not trust a local index's sidecar for the hosted table", async () => {
    writeSmallFixture(root);
    const local: Manifest = {
      version: INDEX_FORMAT_VERSION,
      table: TABLE,
      vectors: "none",
      analyzer: "ascii_lower",
      files: 3,
      chunks: 3,
      languages: { txt: 3 },
      indexedAt: new Date().toISOString(),
      indexMs: 1,
    };
    writeManifest(dir, local);
    const platform = fakePlatform([TABLE]);
    const outcome = await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/describes a local index, not the hosted table/);
    expect(platform.calls).toHaveLength(0);
  });

  it("asks for a full reload when the hosted table has gone", async () => {
    const platform = fakePlatform();
    await load(platform);
    // Dropped by someone else: the registry no longer lists it.
    const other = fakePlatform([]);
    const outcome = await syncRepo({ root, hosted: other.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/no chunks table on the hosted target/);
  });

  it("syncs a platform-embedded table with JSON rows and no local embedding", async () => {
    const platform = fakePlatform();
    await load(platform, { embedder: null, embedProvider: "platform" });
    writeFileSync(join(root, "src", "small1.txt"), textFile(1, SMALL_LINES, "changedmarker"));
    const beforeCalls = platform.calls.length;
    const phases: string[] = [];
    const outcome = (await syncRepo({
      root,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: null,
      embedProvider: "platform",
      onPhase: (p) => phases.push(p),
    })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(phases).not.toContain("embed");
    const append = platform.calls.slice(beforeCalls).find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/json");
    const { data } = append.json as { data: Row[] };
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty("embedding");
    expect(outcome.vectors).toBe("ready");
  });

  it("asks for a rebuild when the vector provider changed since the load", async () => {
    const platform = fakePlatform();
    await load(platform, { embedder: null, embedProvider: "platform" });
    const back = await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(back.action).toBe("rebuild-required");
    expect((back as { reason: string }).reason).toMatch(/embedder changed \(index: platform, current: fake-16d\)/);

    const local = fakePlatform();
    await load(local);
    const forth = await syncRepo({ root, hosted: local.db(), indexDirPath: dir, embedder: null, embedProvider: "platform" });
    expect(forth.action).toBe("rebuild-required");
    expect((forth as { reason: string }).reason).toMatch(/embedder changed \(index: fake-16d, current: platform\)/);
  });

  it("asks for a rebuild when the analyzer requested differs from the table's", async () => {
    const platform = fakePlatform();
    await load(platform);
    const outcome = await syncRepo({ root, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, analyzer: "standard" });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/analyzer changed \(index: ascii_lower, current: standard\)/);
  });
});
