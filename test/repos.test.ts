// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Per-repo registry: root resolution, validation, index-dir mapping, and the
// LRU that keeps a roaming session from accumulating connections. Connection
// and stat are faked, so no engine or on-disk repo is needed.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "@infino-ai/infino";
import { RepoRegistry } from "../src/mcp/repos.js";

/** A fake connection tagged with the dir it was opened for, so tests can
 * assert identity (same ctx reused) and count (no redundant connects). */
const fakeConn = (dir: string) => ({ __dir: dir } as unknown as Connection);

/** Registry with a counting connect and a stat that treats a fixed set of
 * paths as directories, one as a file, and everything else as missing. */
function makeRegistry(
  defaultRoot: string,
  opts: { dirs?: string[]; files?: string[]; maxOpen?: number } = {},
) {
  const dirs = new Set([defaultRoot, ...(opts.dirs ?? [])]);
  const files = new Set(opts.files ?? []);
  let connects = 0;
  const connectedDirs: string[] = [];
  const registry = new RepoRegistry(defaultRoot, {
    connect: (dir) => {
      connects++;
      connectedDirs.push(dir);
      return fakeConn(dir);
    },
    stat: (p) => {
      if (dirs.has(p)) return { isDirectory: () => true };
      if (files.has(p)) return { isDirectory: () => false };
      throw new Error("ENOENT");
    },
    maxOpen: opts.maxOpen,
  });
  return { registry, connects: () => connects, connectedDirs };
}

const A = "/repos/alpha";
const B = "/repos/beta";
const C = "/repos/gamma";

let savedIndexDir: string | undefined;
beforeEach(() => {
  savedIndexDir = process.env.CX_INDEX_DIR;
  delete process.env.CX_INDEX_DIR;
});
afterEach(() => {
  if (savedIndexDir === undefined) delete process.env.CX_INDEX_DIR;
  else process.env.CX_INDEX_DIR = savedIndexDir;
});

describe("RepoRegistry.get", () => {
  it("defaults to the startup root when no path is given", () => {
    const { registry } = makeRegistry(A);
    expect(registry.get().root).toBe(A);
    expect(registry.get(undefined).root).toBe(A);
  });

  it("targets a requested repo and caches it (one connection per repo)", () => {
    const { registry, connects } = makeRegistry(A, { dirs: [B] });
    const first = registry.get(B);
    const second = registry.get(B);
    expect(first.root).toBe(B);
    expect(second).toBe(first); // same live ctx, not a rebuild
    expect(connects()).toBe(1);
  });

  it("keeps repos isolated - separate connection, clock, and lock per repo", () => {
    const { registry } = makeRegistry(A, { dirs: [B] });
    const a = registry.get(A);
    const b = registry.get(B);
    expect(a).not.toBe(b);
    expect(a.db).not.toBe(b.db);
    a.lastSyncCheck = 123;
    a.mutation = Promise.resolve();
    expect(b.lastSyncCheck).toBe(0);
    expect(b.mutation).toBeNull();
  });

  it("throws a clear error for a missing path", () => {
    const { registry } = makeRegistry(A);
    expect(() => registry.get("/repos/nope")).toThrow(/path does not exist: \/repos\/nope/);
  });

  it("throws a clear error for a non-directory path", () => {
    const { registry } = makeRegistry(A, { files: ["/repos/file.ts"] });
    expect(() => registry.get("/repos/file.ts")).toThrow(/not a directory: \/repos\/file.ts/);
  });
});

describe("RepoRegistry.dirFor", () => {
  it("puts each repo's index in its own .infino by default", () => {
    const { registry } = makeRegistry(A, { dirs: [B] });
    expect(registry.dirFor(A)).toBe(join(A, ".infino"));
    expect(registry.dirFor(B)).toBe(join(B, ".infino"));
  });

  it("CX_INDEX_DIR overrides only the startup root, never a secondary repo", () => {
    process.env.CX_INDEX_DIR = "/custom/index";
    const { registry } = makeRegistry(A, { dirs: [B] });
    // The single-repo override applies to the default root...
    expect(registry.dirFor(A)).toBe("/custom/index");
    // ...but a secondary repo must NOT collapse onto the same index dir.
    expect(registry.dirFor(B)).toBe(join(B, ".infino"));
  });
});

describe("RepoRegistry LRU eviction", () => {
  it("evicts the least-recently-used repo past maxOpen", () => {
    const { registry, connects } = makeRegistry(A, { dirs: [B, C], maxOpen: 2 });
    registry.get(A); // open: [A]
    registry.get(B); // open: [A, B]
    registry.get(C); // over cap -> evict A -> open: [B, C]
    expect(registry.openRoots()).toEqual([B, C]);
    expect(connects()).toBe(3);

    // A was evicted, so touching it reconnects (4th connect).
    registry.get(A);
    expect(connects()).toBe(4);
    expect(registry.openRoots()).toEqual([C, A]); // B is now LRU
  });

  it("marks a re-accessed repo most-recently-used so it survives the next eviction", () => {
    const { registry } = makeRegistry(A, { dirs: [B, C], maxOpen: 2 });
    registry.get(A); // [A]
    registry.get(B); // [A, B]
    registry.get(A); // touch A -> [B, A]; B is now LRU
    registry.get(C); // over cap -> evict B -> [A, C]
    expect(registry.openRoots()).toEqual([A, C]);
  });
});
