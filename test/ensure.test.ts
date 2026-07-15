// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Auto-index-on-first-query control flow: when a build is triggered, when it
// is skipped, and how an in-flight build is awaited. Dependencies (handle
// lookup, staged build) are faked, so this exercises the orchestration itself
// without an engine.
import { describe, expect, it } from "vitest";
import type { Connection } from "@infino-ai/infino";
import type { RepoCtx } from "../src/mcp/repos.js";
import type { IndexHandle } from "../src/core/context.js";
import type { IndexStats } from "../src/core/indexer.js";
import { ensureIndexed, type EnsureDeps } from "../src/mcp/ensure.js";

const makeCtx = (): RepoCtx => ({
  root: "/repo",
  dir: "/repo/.infino",
  db: {} as unknown as Connection,
  lastSyncCheck: 0,
  mutation: null,
});

const STATS: IndexStats = {
  files: 3,
  chunks: 10,
  languages: { ts: 10 },
  vectors: "building",
  indexMs: 5,
};

const handleFor = (ctx: RepoCtx): IndexHandle =>
  ({ root: ctx.root, dir: ctx.dir, db: ctx.db, manifest: { vectors: "building" } } as unknown as IndexHandle);

describe("ensureIndexed", () => {
  it("returns the existing index without building", async () => {
    const ctx = makeCtx();
    let builds = 0;
    const deps: EnsureDeps = {
      autoIndexEnabled: true,
      getHandle: (c) => handleFor(c),
      build: () => ((builds++), Promise.resolve(STATS)),
    };
    const res = await ensureIndexed(ctx, deps);
    expect("handle" in res && res.handle.root).toBe("/repo");
    expect("handle" in res && res.autoIndexed).toBeUndefined();
    expect(builds).toBe(0);
  });

  it("reports needsIndex without building when auto-index is disabled", async () => {
    const ctx = makeCtx();
    let builds = 0;
    const deps: EnsureDeps = {
      autoIndexEnabled: false,
      getHandle: () => null,
      build: () => ((builds++), Promise.resolve(STATS)),
    };
    const res = await ensureIndexed(ctx, deps);
    expect(res).toEqual({ needsIndex: true });
    expect(builds).toBe(0);
  });

  it("builds on first query and returns the fresh handle with stats", async () => {
    const ctx = makeCtx();
    let indexed = false;
    let builds = 0;
    const deps: EnsureDeps = {
      autoIndexEnabled: true,
      getHandle: (c) => (indexed ? handleFor(c) : null),
      build: (c) => {
        builds++;
        return (async () => {
          indexed = true; // the build makes keyword search live
          return STATS;
        })();
      },
    };
    const res = await ensureIndexed(ctx, deps);
    expect(builds).toBe(1);
    expect("handle" in res && res.autoIndexed).toEqual(STATS);
  });

  it("waits for an in-flight build instead of starting another", async () => {
    const ctx = makeCtx();
    let indexed = false;
    let resolveInflight!: () => void;
    // Someone else already holds the lock: build() returns null, and the
    // in-flight build lives on ctx.mutation. It resolves keyword-live.
    ctx.mutation = new Promise<void>((r) => {
      resolveInflight = () => {
        indexed = true;
        r();
      };
    });
    let builds = 0;
    const deps: EnsureDeps = {
      autoIndexEnabled: true,
      getHandle: (c) => (indexed ? handleFor(c) : null),
      build: () => ((builds++), null), // lock is taken
    };
    const p = ensureIndexed(ctx, deps);
    resolveInflight();
    const res = await p;
    expect(builds).toBe(1); // attempted once, got null, did not spin
    expect("handle" in res && res.handle.root).toBe("/repo");
    expect("handle" in res && res.autoIndexed).toBeUndefined(); // not our build, no stats
  });

  it("reports needsIndex when a build produced no usable index", async () => {
    const ctx = makeCtx();
    const deps: EnsureDeps = {
      autoIndexEnabled: true,
      getHandle: () => null, // still nothing after the build
      build: () => Promise.resolve(STATS),
    };
    const res = await ensureIndexed(ctx, deps);
    expect(res).toEqual({ needsIndex: true });
  });

  it("propagates a build failure to the caller", async () => {
    const ctx = makeCtx();
    const deps: EnsureDeps = {
      autoIndexEnabled: true,
      getHandle: () => null,
      build: () => Promise.reject(new Error("read-only index dir")),
    };
    await expect(ensureIndexed(ctx, deps)).rejects.toThrow(/read-only index dir/);
  });
});
