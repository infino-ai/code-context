// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// File-cap truncation: when a repo exceeds the file cap, the index is partial
// and every query must say so. Covers the manifest record, the search marker,
// and the sync recompute as a repo grows past / shrinks back under the cap.
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Connection } from "@infino-ai/infino";
import { indexRepo, syncRepo } from "../src/core/indexer.js";
import { readManifest, type Manifest } from "../src/core/manifest.js";
import { search, partialIndex } from "../src/core/searcher.js";
import type { IndexHandle } from "../src/core/context.js";
import type { Embedder } from "../src/core/embedder.js";

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => new Array(16).fill(0.01)),
  dim: async () => 16,
  provider: "fake",
  model: "fake-16d",
};

let root: string;
let dir: string;
let db: Connection;

const cap = (maxFiles: number) => ({ maxFiles, maxFileBytes: 1024 * 1024 });
const writeFile = (n: number) =>
  writeFileSync(join(root, "src", `f${n}.ts`), `export const value${n} = "token${n}";\n`);
const handleFrom = (m: Manifest): IndexHandle => ({ root, dir, db, manifest: m });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-trunc-"));
  mkdirSync(join(root, "src"), { recursive: true });
  dir = join(root, ".infino");
  db = connect(dir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("partialIndex", () => {
  it("returns undefined when the whole tree was indexed", () => {
    expect(partialIndex({ truncatedFiles: 0 } as unknown as Manifest)).toBeUndefined();
    expect(partialIndex({} as unknown as Manifest)).toBeUndefined();
  });

  it("builds a marker with counts and an actionable note when truncated", () => {
    const p = partialIndex({ truncatedFiles: 3, maxFiles: 10 } as unknown as Manifest);
    expect(p).toEqual({
      filesSkipped: 3,
      fileCap: 10,
      note: expect.stringContaining("CX_MAX_FILES"),
    });
    expect(p!.note).toContain("3 file");
    expect(p!.note).toContain("10-file cap");
  });
});

describe("truncation end to end", () => {
  it("records truncation in the manifest and surfaces it in search", async () => {
    writeFile(0);
    writeFile(1);
    writeFile(2);
    const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(1) });
    expect(stats.truncatedFiles).toBe(2);

    const m = readManifest(dir)!;
    expect(m.truncatedFiles).toBe(2);
    expect(m.maxFiles).toBe(1);

    const r = await search(handleFrom(m), fakeEmbedder, "token", 5);
    expect(r.partial).toBeDefined();
    expect(r.partial!.filesSkipped).toBe(2);
    expect(r.partial!.fileCap).toBe(1);
  });

  it("omits truncation fields and the marker when the whole tree fits", async () => {
    writeFile(0);
    writeFile(1);
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(10) });

    const m = readManifest(dir)!;
    expect(m.truncatedFiles).toBeUndefined();
    expect(m.maxFiles).toBeUndefined();
    expect((await search(handleFrom(m), fakeEmbedder, "token", 5)).partial).toBeUndefined();
  });

  it("starts tracking truncation once a growing repo crosses the cap", async () => {
    writeFile(0);
    writeFile(1);
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(5) });
    expect(readManifest(dir)!.truncatedFiles).toBeUndefined();

    for (const n of [2, 3, 4, 5]) writeFile(n); // now 6 files, cap 5
    const outcome = await syncRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(5) });
    expect(outcome.action).toBe("synced");
    if (outcome.action !== "synced") return;
    expect(outcome.truncatedFiles).toBe(1);

    const m = readManifest(dir)!;
    expect(m.truncatedFiles).toBe(1);
    expect(m.maxFiles).toBe(5);
  });

  it("clears truncation when files beyond the cap are deleted (noop-path reconcile)", async () => {
    writeFile(0);
    writeFile(1);
    writeFile(2);
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(1) });
    expect(readManifest(dir)!.truncatedFiles).toBe(2);

    // f1/f2 were the truncated tail - never indexed - so deleting them changes
    // no indexed content: the sync is a noop, but truncation must still clear.
    unlinkSync(join(root, "src", "f1.ts"));
    unlinkSync(join(root, "src", "f2.ts"));
    const outcome = await syncRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(1) });
    expect(outcome.action).toBe("noop");
    expect(outcome.truncatedFiles).toBe(0);

    const m = readManifest(dir)!;
    expect(m.truncatedFiles).toBeUndefined();
    expect(m.maxFiles).toBeUndefined();
  });

  it("records truncation when a tail file pushes a full index over the cap (noop-path reconcile)", async () => {
    writeFile(0); // exactly one file, cap 1 - fits
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(1) });
    expect(readManifest(dir)!.truncatedFiles).toBeUndefined();

    // A new file that sorts into the truncated tail never enters the diff, so
    // the sync is a noop - but the index is now partial and must say so.
    writeFile(1);
    const outcome = await syncRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder, caps: cap(1) });
    expect(outcome.action).toBe("noop");
    expect(outcome.truncatedFiles).toBe(1);

    const m = readManifest(dir)!;
    expect(m.truncatedFiles).toBe(1);
    expect(m.maxFiles).toBe(1);
    expect((await search(handleFrom(m), fakeEmbedder, "token", 5)).partial!.filesSkipped).toBe(1);
  });
});
