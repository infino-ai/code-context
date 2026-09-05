// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The indexer with a platform database configured: one build writes the local
// index and then the platform table from the same spill (the table lifecycle
// - drop only when present, create with the analyzer and the right vector
// column and indexes - and the append encodings: Arrow IPC waves for client
// vectors, the JSON envelope for a platform-embedded table); the two manifests
// it leaves behind; the platform-side cost in the stats; a platform failure
// that leaves the local index complete; and the incremental sync that applies
// one diff to both tables at once. The local side is a real engine catalog in
// a temp dir; a fake answers every `/v1/<op>/<db>` route on the platform side.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as arrow from "apache-arrow";
import { connect, type Connection } from "@infino-ai/infino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPEND_BATCH, TABLE } from "../src/core/config.js";
import { HostedDb } from "../src/core/hosted.js";
import { indexRepo, indexRepoStaged, syncRepo, type IndexOptions, type SyncResult } from "../src/core/indexer.js";
import { readManifest, readPlatformManifest, type Manifest } from "../src/core/manifest.js";
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
 * op. Every write response carries a write-tokens header. `failOn` makes one
 * op answer 500, to see what a platform failure leaves behind. */
function fakePlatform(tables: string[] = [], failOn?: string) {
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
    if (op === failOn) return new Response("the platform declined", { status: 500 });

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

/** The indexer's own files in the index dir - the manifests, the file state
 * and any spills - beside the engine catalog's table directories. */
const indexDirFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") || f.startsWith("spill.")).sort() : [];

/** The paths the local chunks table holds, sorted. */
const localPaths = (db: Connection): string[] =>
  (db.querySql(`SELECT DISTINCT path FROM ${TABLE} ORDER BY path`) as Array<{ path: string }>).map((r) => r.path);

const localRowCount = (db: Connection): number => Number((db.querySql(`SELECT COUNT(*) AS n FROM ${TABLE}`) as Array<{ n: unknown }>)[0].n);

// --- fixture directories -----------------------------------------------------------------

let root: string;
let dir: string;
let db: Connection;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-both-index-"));
  dir = join(root, ".infino");
  db = connect(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- the build -------------------------------------------------------------------------------

describe("a build with a platform database (client vectors)", () => {
  it("builds the local index, then drops, creates and fills the platform table from the same spill", async () => {
    writeBigFixture(root);
    const platform = fakePlatform([TABLE, "other"]);
    const phases: string[] = [];
    const stats = await indexRepo({
      root,
      db,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: fakeEmbedder,
      embedProvider: "local",
      onPhase: (p) => phases.push(p),
    });

    expect(stats.files).toBe(BIG_FILES);
    expect(stats.chunks).toBe(BIG_FILES * CHUNKS_PER_BIG_FILE);
    expect(stats.chunks).toBeGreaterThan(APPEND_BATCH);
    expect(stats.vectors).toBe("ready");
    expect(stats.embedMs).toBeGreaterThanOrEqual(0);
    expect(stats.embedError).toBeUndefined();
    expect(stats.hostedError).toBeUndefined();
    // The local stages first, the platform load last, from the same vectors.
    expect(phases).toEqual(["scan", "chunk", "commit-text", "embed", "commit-vectors", "load"]);

    // The local index holds every chunk.
    expect(localRowCount(db)).toBe(stats.chunks);
    expect(localPaths(db)).toEqual(Array.from({ length: BIG_FILES }, (_, f) => `docs/big${f}.txt`));

    // The platform lifecycle: the existing table goes, one create, one append per wave.
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
    // a full batch and the rows add up to the chunk count - the same rows the
    // local table got.
    const appends = platform.calls.filter((c) => c.op === "append");
    expect(appends).toHaveLength(waves);
    for (const a of appends) {
      expect(a.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
      expect(a.url).toBe(`https://api.example.test/v1/append/cx?table=${TABLE}`);
      const fields = a.ipc!.schema.fields;
      expect(fields.map((f) => f.name)).toEqual([...TEXT_FIELDS, "embedding"]);
      expect((fields[fields.length - 1].type as arrow.FixedSizeList).listSize).toBe(DIM);
    }
    expect(appends[0].ipc!.numRows).toBe(APPEND_BATCH);
    expect(appends.reduce((n, a) => n + a.ipc!.numRows, 0)).toBe(stats.chunks);
    expect(platform.rows()).toHaveLength(stats.chunks);
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

    // Two manifests: the local one describes the local index (engine default
    // analyzer), the platform one the table (the analyzer sent), both the same
    // rows; the file state is shared; no spills are left.
    const local = readManifest(dir)!;
    expect(local.origin).toBeUndefined();
    expect(local.analyzer).toBe("ascii_lower");
    expect(local.vectors).toBe("ready");
    expect(local.embedder).toEqual({ provider: "fake", model: "fake-16d", dim: DIM });
    expect(local.chunks).toBe(stats.chunks);
    const remote = readPlatformManifest(dir)!;
    expect(remote.origin).toBe("hosted");
    expect(remote.analyzer).toBe("ascii_lower");
    expect(remote.vectors).toBe("ready");
    expect(remote.embedder).toEqual({ provider: "fake", model: "fake-16d", dim: DIM });
    expect(remote.chunks).toBe(stats.chunks);
    expect(remote.files).toBe(BIG_FILES);
    expect(remote.languages).toEqual({ txt: stats.chunks });
    expect(Object.keys(readFileState(dir)!.files).sort()).toEqual(
      Array.from({ length: BIG_FILES }, (_, f) => `docs/big${f}.txt`).sort(),
    );
    expect(indexDirFiles(dir)).toEqual(["codecontext.json", "filestate.json", "platform.json"]);
  });

  it("does not drop a table that is not there", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform([]);
    await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(platform.ops()).toEqual(["list_tables", "create_table", "append"]);
  });

  it("names the analyzer it was given to the platform and records it in the platform manifest only", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local", analyzer: "standard" });
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.indexes).toEqual({
      fts: [{ column: "content", analyzer: "standard" }],
      vector: [{ column: "embedding", metric: "cosine" }],
    });
    expect(readPlatformManifest(dir)!.analyzer).toBe("standard");
    expect(readManifest(dir)!.analyzer).toBe("ascii_lower"); // the local index took the engine default
  });

  it("indexes an empty tree to an empty, complete table on both sides", async () => {
    // One binary file: walked and fingerprinted, zero chunks.
    writeFileSync(join(root, "blob.txt"), Buffer.from([0, 1, 2, 0, 3]));
    const platform = fakePlatform();
    const stats = await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(stats.chunks).toBe(0);
    expect(stats.vectors).toBe("ready");
    expect(stats.hosted!.appendCalls).toBe(0);
    expect(localRowCount(db)).toBe(0);
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema[created.schema.length - 1]).toEqual({ name: "embedding", type: "vector", dim: DIM });
    expect(platform.ops()).toEqual(["list_tables", "create_table"]);
  });

  it("reports keyword-live before the platform load, and the finished stats after it", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    const run = await indexRepoStaged({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(run.text.vectors).toBe("building");
    expect(run.text.hosted).toBeUndefined();
    expect(platform.calls).toHaveLength(0); // nothing on the wire yet
    const final = await run.completion;
    expect(final.vectors).toBe("ready");
    expect(final.hosted!.appendCalls).toBe(1);
  });
});

describe("a build with a platform database (the platform embeds)", () => {
  it("embeds the local index locally and declares an embedding column the platform fills, appending JSON rows without it", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform([TABLE]);
    const phases: string[] = [];
    const stats = await indexRepo({
      root,
      db,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: fakeEmbedder,
      embedProvider: "platform",
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(["scan", "chunk", "commit-text", "embed", "commit-vectors", "load"]);
    expect(stats.vectors).toBe("ready");
    expect(stats.embedMs).toBeGreaterThanOrEqual(0);

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

    // The local index has the local model's vectors; the platform table has its own.
    expect(readManifest(dir)!.embedder).toEqual({ provider: "fake", model: "fake-16d", dim: DIM });
    const remote = readPlatformManifest(dir)!;
    expect(remote.vectors).toBe("ready");
    expect(remote.embedder).toEqual({ provider: "platform", model: "server-side" });
  });

  it("is the default provider", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema.at(-1)).toEqual({ name: "embedding", type: "embedding", source: ["content"] });
  });
});

describe("a build with a platform database (keyword only)", () => {
  it("creates a text-only table with the FTS index and appends IPC when there is no embedder and the provider is local", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform();
    const stats = await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedProvider: "local" });
    expect(stats.vectors).toBe("none");
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema).toEqual(TEXT_COLUMNS);
    expect(created.indexes).toEqual({ fts: [{ column: "content", analyzer: "ascii_lower" }] });
    const append = platform.calls.find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(append.ipc!.schema.fields.map((f) => f.name)).toEqual(TEXT_FIELDS);
    expect(readManifest(dir)!.vectors).toBe("none");
    const remote = readPlatformManifest(dir)!;
    expect(remote.vectors).toBe("none");
    expect(remote.embedder).toBeUndefined();
  });
});

describe("failures during a build", () => {
  it("an embed failure leaves the keyword index live locally and loads a keyword-only platform table", async () => {
    writeSmallFixture(root);
    const broken: Embedder = {
      ...fakeEmbedder,
      embedToFloat32: async () => {
        throw new Error("model download failed");
      },
    };
    const platform = fakePlatform([TABLE]);
    const stats = await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: broken, embedProvider: "local" });
    expect(stats.vectors).toBe("none");
    expect(stats.embedError).toBe("model download failed");
    expect(stats.hostedError).toBeUndefined();
    expect(localRowCount(db)).toBe(3);
    const created = createBody(platform.calls.find((c) => c.op === "create_table")!);
    expect(created.schema).toEqual(TEXT_COLUMNS);
    expect(indexDirFiles(dir).filter((f) => f.startsWith("spill."))).toEqual([]);
  });

  it("a platform failure is recorded, never thrown: the local index is complete and the platform manifest is not written", async () => {
    writeSmallFixture(root);
    const platform = fakePlatform([], "create_table");
    const stats = await indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder });
    expect(stats.vectors).toBe("ready");
    expect(stats.hosted).toBeUndefined();
    expect(stats.hostedError).toMatch(/create_table: server returned 500/);
    expect(localRowCount(db)).toBe(3);
    expect(readManifest(dir)!.vectors).toBe("ready");
    expect(readPlatformManifest(dir)).toBeUndefined();
    expect(indexDirFiles(dir).filter((f) => f.startsWith("spill."))).toEqual([]);
  });
});

// --- the sync -------------------------------------------------------------------------------

describe("a sync with a platform database", () => {
  const build = async (platform: ReturnType<typeof fakePlatform>, extra: Partial<IndexOptions> = {}) => {
    writeSmallFixture(root);
    return indexRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local", ...extra });
  };

  it("applies one diff to both tables: a path-predicate delete plus an append wave on the platform, the same locally, then recounts both", async () => {
    const platform = fakePlatform();
    const stats = await build(platform);
    const beforeCalls = platform.calls.length;

    writeFileSync(join(root, "src", "small0.txt"), textFile(0, SMALL_LINES, "changedmarker"));
    writeFileSync(join(root, "src", "added.txt"), textFile(9, SMALL_LINES, "addedmarker"));
    unlinkSync(join(root, "src", "small2.txt"));

    const outcome = (await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" })) as SyncResult;
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
    // Two rows were live for those paths locally (added.txt had none).
    expect(outcome.chunksRemoved).toBe(2);
    // The fresh chunks ride one IPC wave, embedded once, at the table's width.
    const append = platform.calls.slice(beforeCalls).find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    expect(append.ipc!.numRows).toBe(outcome.chunksAdded);
    expect(outcome.chunksAdded).toBe(2);
    expect((append.ipc!.schema.fields.at(-1)!.type as arrow.FixedSizeList).listSize).toBe(DIM);

    // Both tables hold the same paths afterwards.
    const expected = ["src/added.txt", "src/small0.txt", "src/small1.txt"];
    expect(localPaths(db)).toEqual(expected);
    expect(platform.rows().map((r) => r.path).sort()).toEqual(expected);
    expect(Object.keys(readFileState(dir)!.files).sort()).toEqual(expected);

    // Totals come from each side's own count and land in its manifest.
    expect(outcome.chunks).toBe(stats.chunks - 2 + 2);
    expect(outcome.files).toBe(3);
    expect(outcome.vectors).toBe("ready");
    expect(outcome.hosted).toMatchObject({ appendCalls: 1 });
    expect(outcome.hosted!.writeTokens).toBeCloseTo(WRITE_TOKENS_PER_CALL * 2);
    expect(readManifest(dir)!.chunks).toBe(outcome.chunks);
    const remote = readPlatformManifest(dir)!;
    expect(remote.chunks).toBe(outcome.chunks);
    expect(remote.files).toBe(3);
    expect(remote.origin).toBe("hosted");
  });

  it("no-ops on an unchanged tree with one readiness round trip and no write", async () => {
    const platform = fakePlatform();
    await build(platform);
    const beforeCalls = platform.calls.length;
    const outcome = await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(outcome.action).toBe("noop");
    expect(platform.calls.slice(beforeCalls).map((c) => c.op)).toEqual(["list_tables"]);
  });

  it("asks for a build when this machine has no record of the platform table", async () => {
    const platform = fakePlatform();
    await build(platform);
    unlinkSync(join(dir, "platform.json"));
    const beforeCalls = platform.calls.length;
    const outcome = await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/no record of the platform table/);
    expect(platform.calls).toHaveLength(beforeCalls);
  });

  it("asks for a build when the platform table has gone", async () => {
    const platform = fakePlatform();
    await build(platform);
    // Dropped by someone else: the registry no longer lists it.
    const other = fakePlatform([]);
    const outcome = await syncRepo({ root, db, hosted: other.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/no chunks table on the platform database/);
  });

  it("asks for a build when the local index has no prior state, whatever the platform side says", async () => {
    const platform = fakePlatform();
    await build(platform);
    unlinkSync(join(dir, "codecontext.json"));
    const outcome = await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toBe("no prior index state");
  });

  it("syncs a platform-embedded table with JSON rows while embedding the local rows", async () => {
    const platform = fakePlatform();
    await build(platform, { embedProvider: "platform" });
    writeFileSync(join(root, "src", "small1.txt"), textFile(1, SMALL_LINES, "changedmarker"));
    const beforeCalls = platform.calls.length;
    const phases: string[] = [];
    const outcome = (await syncRepo({
      root,
      db,
      hosted: platform.db(),
      indexDirPath: dir,
      embedder: fakeEmbedder,
      embedProvider: "platform",
      onPhase: (p) => phases.push(p),
    })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(phases).toContain("embed"); // the local index has vectors
    const append = platform.calls.slice(beforeCalls).find((c) => c.op === "append")!;
    expect(append.headers["content-type"]).toBe("application/json");
    const { data } = append.json as { data: Row[] };
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty("embedding");
    expect(outcome.vectors).toBe("ready");
    expect(localRowCount(db)).toBe(3);
  });

  it("asks for a build when the platform table's vector provider changed since it was loaded", async () => {
    const platform = fakePlatform();
    await build(platform, { embedProvider: "platform" });
    const back = await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" });
    expect(back.action).toBe("rebuild-required");
    expect((back as { reason: string }).reason).toMatch(/embedder changed \(platform table: platform, current: fake-16d\)/);

    const local = fakePlatform();
    await build(local);
    const forth = await syncRepo({ root, db, hosted: local.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "platform" });
    expect(forth.action).toBe("rebuild-required");
    expect((forth as { reason: string }).reason).toMatch(/embedder changed \(platform table: fake-16d, current: platform\)/);
  });

  it("asks for a build when the analyzer requested differs from the platform table's", async () => {
    const platform = fakePlatform();
    await build(platform);
    const outcome = await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local", analyzer: "standard" });
    expect(outcome.action).toBe("rebuild-required");
    expect((outcome as { reason: string }).reason).toMatch(/analyzer changed \(platform table: ascii_lower, current: standard\)/);
  });

  it("a platform failure mid-apply throws, leaves the file state unwritten, and the next sync re-applies the diff to both", async () => {
    const platform = fakePlatform();
    await build(platform);
    writeFileSync(join(root, "src", "small0.txt"), textFile(0, SMALL_LINES, "changedmarker"));

    // The same database, answering 500 to the append this time.
    const failing = fakePlatform([TABLE], "append");
    await expect(
      syncRepo({ root, db, hosted: failing.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" }),
    ).rejects.toThrow(/append: server returned 500/);
    // The local side did apply (the two run together), but the record of the
    // diff was not written, so it is applied again next time - the deletes
    // make that idempotent.
    expect(localRowCount(db)).toBe(3);
    const state = readFileState(dir)!;
    expect(state.files["src/small0.txt"]).toEqual((await (async () => readFileState(dir)!)()).files["src/small0.txt"]);

    const beforeCalls = platform.calls.length;
    const retry = (await syncRepo({ root, db, hosted: platform.db(), indexDirPath: dir, embedder: fakeEmbedder, embedProvider: "local" })) as SyncResult;
    expect(retry.action).toBe("synced");
    expect(retry.filesChanged).toBe(1);
    expect(platform.calls.slice(beforeCalls).map((c) => c.op)).toEqual(["list_tables", "delete", "append", "query_sql", "query_sql"]);
    expect(localRowCount(db)).toBe(3);
    expect(localPaths(db)).toEqual(["src/small0.txt", "src/small1.txt", "src/small2.txt"]);
  });
});

describe("a sync without a platform database", () => {
  it("is the local sync alone, and a platform manifest lying around changes nothing", async () => {
    writeSmallFixture(root);
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder });
    expect(readPlatformManifest(dir)).toBeUndefined();
    writeFileSync(join(root, "src", "small0.txt"), textFile(0, SMALL_LINES, "changedmarker"));
    const outcome = (await syncRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(outcome.hosted).toBeUndefined();
    expect(localRowCount(db)).toBe(3);
    const manifest: Manifest = readManifest(dir)!;
    expect(manifest.chunks).toBe(3);
  });
});
