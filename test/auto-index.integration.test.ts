// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Auto-index on first query, end to end: ensureIndexed wired to the real
// staged indexer and manifest, against a real engine catalog. Mirrors exactly
// how the MCP server builds its `getHandle` and `build` dependencies, so this
// proves the feature works, not just the control flow.
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Connection } from "@infino-ai/infino";
import { indexRepoStaged, type IndexStats } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { search } from "../src/core/searcher.js";
import type { IndexHandle } from "../src/core/context.js";
import type { Embedder } from "../src/core/embedder.js";
import type { RepoCtx } from "../src/mcp/repos.js";
import { ensureIndexed, type EnsureDeps } from "../src/mcp/ensure.js";

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => new Array(16).fill(0.01)),
  dim: async () => 16,
  provider: "fake",
  model: "fake-16d",
};

let root: string;
let ctx: RepoCtx;

// The two dependencies exactly as the MCP server constructs them.
const getHandle = (c: RepoCtx): IndexHandle | null => {
  if (!existsSync(c.dir)) return null;
  const manifest = readManifest(c.dir);
  return manifest ? { root: c.root, dir: c.dir, db: c.db, manifest } : null;
};
const exclusive = (c: RepoCtx, fn: () => Promise<IndexStats>): Promise<IndexStats> | null => {
  if (c.mutation) return null;
  const p = fn().finally(() => {
    c.mutation = null;
  });
  c.mutation = p.catch(() => undefined);
  return p;
};
const build = (c: RepoCtx): Promise<IndexStats> | null =>
  exclusive(c, async () => {
    const run = await indexRepoStaged({ root: c.root, db: c.db, indexDirPath: c.dir, embedder: fakeEmbedder });
    await run.completion; // await vectors here so the assertion on ranking is deterministic
    return run.text;
  });

const deps = (autoIndexEnabled: boolean): EnsureDeps => ({ autoIndexEnabled, getHandle, build });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-autoidx-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "auth.ts"),
    "export function verifySession(token: string) { return token.length > 0; }\n",
  );
  const dir = join(root, ".infino");
  ctx = { root, dir, db: connect(dir) as Connection, lastSyncCheck: 0, mutation: null };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("auto-index on first query (end to end)", () => {
  it("builds a real index on the first query and answers from it", async () => {
    expect(getHandle(ctx)).toBeNull(); // nothing indexed yet

    const res = await ensureIndexed(ctx, deps(true));
    expect("handle" in res).toBe(true);
    if (!("handle" in res)) return;
    expect(res.autoIndexed?.chunks).toBeGreaterThan(0);
    expect(existsSync(ctx.dir)).toBe(true);

    // The freshly built index actually answers a query.
    const hits = await search(res.handle, fakeEmbedder, "verifySession token", 5);
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(hits.hits[0].path).toContain("auth.ts");
  });

  it("does not rebuild when the index already exists", async () => {
    await ensureIndexed(ctx, deps(true)); // first call builds
    const res = await ensureIndexed(ctx, deps(true)); // second call reuses
    expect("handle" in res && res.autoIndexed).toBeUndefined();
  });

  it("reports needsIndex (no build) when auto-index is disabled", async () => {
    const res = await ensureIndexed(ctx, deps(false));
    expect(res).toEqual({ needsIndex: true });
    expect(readManifest(ctx.dir)).toBeUndefined(); // no index was built
    expect(getHandle(ctx)).toBeNull();
  });
});
