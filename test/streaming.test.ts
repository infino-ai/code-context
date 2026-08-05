// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Streaming-index regressions (issue #9): builds and syncs must hold only
// bounded batches - stage 1 interleaves chunk→append, stage 2 goes through
// the on-disk spills - and the spills must vanish when the vector stage
// settles, success or failure. Fixtures are sized past APPEND_BATCH so the
// multi-wave paths actually run; fake embedders keep CI off the network.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connection } from "@infino-ai/infino";
import { APPEND_BATCH, EMBED_BATCH } from "../src/core/config.js";
import { indexRepo, indexRepoStaged, syncRepo, type SyncResult } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { search } from "../src/core/searcher.js";
import { unpackRows, type Embedder } from "../src/core/embedder.js";
import type { IndexHandle } from "../src/core/context.js";

const DIM = 16; // engine minimum

/** Deterministic vector for a text (same math as the other suites' fakes). */
function vectorFor(t: string): number[] {
  const v = new Array<number>(DIM).fill(0.01);
  for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) / 1000;
  return v;
}

/** Fake that only implements embed() - the compatibility path. */
const embedOnlyFake: Embedder = {
  embed: async (texts) => texts.map(vectorFor),
  dim: async () => DIM,
  provider: "fake",
  model: "fake-16d",
};

/** Fake that also implements embedToFloat32() - the streaming fast path. */
const float32Fake: Embedder = {
  ...embedOnlyFake,
  embedToFloat32: async (texts) => {
    const vectors = new Float32Array(texts.length * DIM);
    texts.forEach((t, i) => vectors.set(vectorFor(t), i * DIM));
    return { vectors, dim: DIM };
  },
};

/** Enough .js files that total chunks cross APPEND_BATCH, so the interleaved
 * append loop and the spill replay both run multi-wave. Each file carries one
 * distinctive token so hits are attributable. */
function writeBigFixture(root: string, nFiles: number): void {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let f = 0; f < nFiles; f++) {
    const lines: string[] = [`// module ${f}: streamingfixture${f}`];
    for (let fn = 0; fn < 40; fn++) {
      lines.push(`export function handler${f}x${fn}(input) {`);
      for (let body = 0; body < 58; body++) {
        lines.push(`  input = input + ${body}; // step ${body} of pipeline ${f}.${fn}`);
      }
      lines.push(`  return input;`, `}`);
    }
    writeFileSync(join(root, "src", `mod${f}.js`), lines.join("\n") + "\n");
  }
}

function spillNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("spill.")) : [];
}

let root: string;
let dir: string;
let db: Connection;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cx-stream-"));
  dir = join(root, ".infino");
  writeBigFixture(root, 14);
  db = connect(dir);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("streamed staged build", () => {
  it("crosses APPEND_BATCH, lands hybrid search, and cleans its spills", async () => {
    const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: float32Fake });
    expect(stats.vectors).toBe("ready");
    expect(stats.chunks).toBeGreaterThan(APPEND_BATCH);

    // Every spilled row made it into the rebuilt table.
    const [{ n }] = db.querySql(`SELECT COUNT(*) AS n FROM chunks`) as [{ n: unknown }];
    expect(Number(n)).toBe(stats.chunks);

    const handle: IndexHandle = { root, dir, db, manifest: readManifest(dir)! };
    const r = await search(handle, float32Fake, "streamingfixture3 pipeline", 5);
    expect(r.ranking).toBe("hybrid");
    expect(r.hits.length).toBeGreaterThan(0);

    // Handoff files are gone once the vector stage settles.
    expect(spillNames(dir)).toEqual([]);
  });

  it("builds through embed() alone when embedToFloat32 is absent", async () => {
    const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: embedOnlyFake });
    expect(stats.vectors).toBe("ready");
    expect(stats.embedError).toBeUndefined();
    expect(spillNames(dir)).toEqual([]);
  });

  it("keeps keyword search live and cleans spills when the model fails", async () => {
    const broken: Embedder = {
      ...embedOnlyFake,
      embed: async () => {
        throw new Error("model download failed");
      },
      embedToFloat32: undefined,
      dim: async () => {
        throw new Error("model download failed");
      },
    };
    const run = await indexRepoStaged({ root, db, indexDirPath: dir, embedder: broken });
    expect(run.text.vectors).toBe("building");
    const final = await run.completion;
    expect(final.vectors).toBe("none");
    expect(final.embedError).toContain("model download failed");

    // Keyword search still answers from the stage-1 table.
    const handle: IndexHandle = { root, dir, db, manifest: readManifest(dir)! };
    const r = await search(handle, embedOnlyFake, "streamingfixture5", 3);
    expect(r.ranking).toBe("keyword");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(spillNames(dir)).toEqual([]);
  });

  it("refuses a short embedding stream instead of building a silently short table", async () => {
    // Drops one vector per batch: a truncated stream must surface as
    // embedError, never as a table that quietly lost rows.
    const short: Embedder = {
      ...embedOnlyFake,
      embedToFloat32: async (texts) => {
        const kept = Math.max(texts.length - 1, 0);
        const vectors = new Float32Array(kept * DIM);
        texts.slice(0, kept).forEach((t, i) => vectors.set(vectorFor(t), i * DIM));
        return { vectors, dim: DIM };
      },
    };
    const run = await indexRepoStaged({ root, db, indexDirPath: dir, embedder: short });
    const final = await run.completion;
    expect(final.vectors).toBe("none");
    expect(final.embedError).toMatch(/floats|mismatch/);
    expect(spillNames(dir)).toEqual([]);
  });
});

describe("streamed incremental sync", () => {
  it("re-embeds a multi-wave changeset in bounded batches", async () => {
    // Rebuild to a clean hybrid state, then grow the tree by several files
    // whose chunks cross EMBED_BATCH several times over.
    const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: float32Fake });
    expect(stats.vectors).toBe("ready");

    const added = 3;
    for (let f = 100; f < 100 + added; f++) {
      const lines: string[] = [`// module ${f}: syncwavefixture${f}`];
      for (let fn = 0; fn < 40; fn++) {
        lines.push(`export function later${f}x${fn}(x) {`);
        for (let body = 0; body < 58; body++) lines.push(`  x += ${body}; // sync step`);
        lines.push(`  return x;`, `}`);
      }
      writeFileSync(join(root, "src", `mod${f}.js`), lines.join("\n") + "\n");
    }

    const outcome = (await syncRepo({ root, db, indexDirPath: dir, embedder: float32Fake })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(outcome.filesAdded).toBe(added);
    expect(outcome.chunksAdded).toBeGreaterThan(EMBED_BATCH * 3);
    expect(outcome.chunks).toBe(stats.chunks + outcome.chunksAdded);

    const handle: IndexHandle = { root, dir, db, manifest: readManifest(dir)! };
    const r = await search(handle, float32Fake, "syncwavefixture101", 3);
    expect(r.ranking).toBe("hybrid");
    expect(r.hits.some((h) => h.path === "src/mod101.js")).toBe(true);
  });
});

describe("review-confirmed regressions", () => {
  it("indexes an empty corpus to vectors:ready, not a spurious spill error", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "cx-empty-"));
    const emptyDir = join(emptyRoot, ".infino");
    // One binary file: walked, fingerprinted, but yields zero chunks.
    writeFileSync(join(emptyRoot, "blob.js"), Buffer.from([0, 1, 2, 0, 3]));
    const emptyDb = connect(emptyDir);
    try {
      const stats = await indexRepo({ root: emptyRoot, db: emptyDb, indexDirPath: emptyDir, embedder: float32Fake });
      expect(stats.chunks).toBe(0);
      expect(stats.embedError).toBeUndefined();
      expect(stats.vectors).toBe("ready");
      expect(spillNames(emptyDir)).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("survives overlapping staged builds: separate spills, both end ready", async () => {
    // A slow embedder holds build A in its vector stage while build B runs
    // start to finish - the exact overlap a reindex(full) during backfill
    // produces. With per-build spills neither may ENOENT the other.
    const slow: Embedder = {
      ...float32Fake,
      embedToFloat32: async (texts) => {
        await new Promise((r) => setTimeout(r, 20));
        return float32Fake.embedToFloat32!(texts);
      },
    };
    const runA = await indexRepoStaged({ root, db, indexDirPath: dir, embedder: slow });
    const runB = await indexRepoStaged({ root, db, indexDirPath: dir, embedder: float32Fake });
    const [a, b] = await Promise.all([runA.completion, runB.completion]);
    expect(a.embedError).toBeUndefined();
    expect(b.embedError).toBeUndefined();
    expect(a.vectors).toBe("ready");
    expect(b.vectors).toBe("ready");
    // Whichever build won, the table is complete and consistent.
    const [{ n }] = db.querySql(`SELECT COUNT(*) AS n FROM chunks`) as [{ n: unknown }];
    expect(Number(n)).toBe(a.chunks);
    expect(spillNames(dir)).toEqual([]);
  });

  it("sync embeds before deleting: an embed failure leaves the index intact", async () => {
    const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: float32Fake });
    expect(stats.vectors).toBe("ready");
    const [{ n: before }] = db.querySql(`SELECT COUNT(*) AS n FROM chunks`) as [{ n: unknown }];

    writeFileSync(join(root, "src", "mod0.js"), "export function replacement() { return 1; }\n");
    const failing: Embedder = {
      ...embedOnlyFake,
      embed: async () => {
        throw new Error("endpoint down");
      },
    };
    await expect(syncRepo({ root, db, indexDirPath: dir, embedder: failing })).rejects.toThrow("endpoint down");

    // Nothing was deleted or appended; the old rows still serve hybrid search.
    const [{ n: after }] = db.querySql(`SELECT COUNT(*) AS n FROM chunks`) as [{ n: unknown }];
    expect(Number(after)).toBe(Number(before));
    const handle: IndexHandle = { root, dir, db, manifest: readManifest(dir)! };
    const r = await search(handle, float32Fake, "streamingfixture0 pipeline", 3);
    expect(r.hits.some((h) => h.path === "src/mod0.js")).toBe(true);
    expect(spillNames(dir)).toEqual([]);

    // A later sync with a healthy embedder heals the same changeset.
    const outcome = (await syncRepo({ root, db, indexDirPath: dir, embedder: float32Fake })) as SyncResult;
    expect(outcome.action).toBe("synced");
    expect(outcome.filesChanged).toBe(1);
  });

  it("sync reports phases in the pre-streaming order with embed progress", async () => {
    await indexRepo({ root, db, indexDirPath: dir, embedder: float32Fake });
    writeFileSync(join(root, "src", "mod1.js"), "export function phasedProbe() { return 2; }\n");
    const phases: string[] = [];
    let progressed = 0;
    const outcome = await syncRepo({
      root,
      db,
      indexDirPath: dir,
      embedder: float32Fake,
      onPhase: (p) => phases.push(p),
      onProgress: () => progressed++,
    });
    expect(outcome.action).toBe("synced");
    expect(phases).toEqual(["scan", "chunk", "embed", "commit-text"]);
    expect(progressed).toBeGreaterThan(0);
  });
});

describe("unpackRows", () => {
  it("splits a packed row-major array into per-row number[]s", () => {
    const packed = Float32Array.from([1, 2, 3, 4, 5, 6]);
    expect(unpackRows(packed, 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(unpackRows(new Float32Array(0), 3)).toEqual([]);
  });
});
