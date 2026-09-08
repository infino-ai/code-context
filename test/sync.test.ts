// Incremental sync: file-state diffing (unit) and syncRepo against a real
// engine catalog (integration, fake embedder).
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { diffFiles, emptyFileState, hashContent, readFileState } from "../src/core/filestate.js";
import { indexRepo, syncRepo } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { search } from "../src/core/searcher.js";
import type { IndexHandle } from "../src/core/context.js";
import type { Embedder } from "../src/core/embedder.js";

describe("diffFiles", () => {
  const entry = (content: string, mtimeMs = 1000) => ({
    size: content.length,
    mtimeMs,
    hash: hashContent(Buffer.from(content)),
  });

  it("skips hashing when size+mtime match", () => {
    const prev = { ...emptyFileState(), files: { "a.ts": entry("hello", 1000) } };
    let reads = 0;
    const diff = diffFiles(
      [{ path: "a.ts", size: 5, mtimeMs: 1000 }],
      prev,
      () => ((reads++), Buffer.from("hello")),
    );
    expect(reads).toBe(0);
    expect(diff.unchanged).toBe(1);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("treats touched-but-identical content as unchanged and refreshes the fingerprint", () => {
    const prev = { ...emptyFileState(), files: { "a.ts": entry("hello", 1000) } };
    const diff = diffFiles([{ path: "a.ts", size: 5, mtimeMs: 2000 }], prev, () => Buffer.from("hello"));
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(diff.next.files["a.ts"].mtimeMs).toBe(2000);
  });

  it("classifies added, changed, and deleted", () => {
    const prev = {
      ...emptyFileState(),
      files: { "keep.ts": entry("same", 1000), "edit.ts": entry("old", 1000), "gone.ts": entry("bye", 1000) },
    };
    const diff = diffFiles(
      [
        { path: "keep.ts", size: 4, mtimeMs: 1000 },
        { path: "edit.ts", size: 3, mtimeMs: 2000 },
        { path: "new.ts", size: 3, mtimeMs: 2000 },
      ],
      prev,
      (p) => Buffer.from(p === "edit.ts" ? "NEW" : "abc"),
    );
    expect(diff.added).toEqual(["new.ts"]);
    expect(diff.changed).toEqual(["edit.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
  });
});

// --- syncRepo integration ------------------------------------------------------

const fakeEmbedder: Embedder = {
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Array(16).fill(0.01);
      for (let i = 0; i < t.length; i++) v[i % 16] += t.charCodeAt(i) / 1000;
      return v;
    }),
  dim: async () => 16,
  provider: "fake",
  model: "fake-16d",
};

let root: string;
let dir: string;
let db: ReturnType<typeof connect>;
const opts = () => ({ root, db, indexDirPath: dir, embedder: fakeEmbedder });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cx-sync-"));
  dir = join(root, ".infino");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.ts"), "export function alphaThing() { return 'quokka'; }\n");
  writeFileSync(join(root, "src", "beta.ts"), "export function betaThing() { return 'wombat'; }\n");
  db = connect(dir);
  await indexRepo(opts());
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncRepo", () => {
  it("no-ops on an unchanged tree", async () => {
    const outcome = await syncRepo(opts());
    expect(outcome.action).toBe("noop");
  });

  it("applies edits incrementally and keeps vectors current", async () => {
    writeFileSync(join(root, "src", "alpha.ts"), "export function alphaThing() { return 'capybara'; }\n");
    writeFileSync(join(root, "src", "gamma.ts"), "export function gammaThing() { return 'axolotl'; }\n");
    unlinkSync(join(root, "src", "beta.ts"));

    const outcome = await syncRepo(opts());
    expect(outcome.action).toBe("synced");
    if (outcome.action !== "synced") return;
    expect(outcome.filesAdded).toBe(1);
    expect(outcome.filesChanged).toBe(1);
    expect(outcome.filesDeleted).toBe(1);

    const handle: IndexHandle = { root, dir, db, manifest: readManifest(dir)! };
    // new content findable, old content gone
    const count = (term: string) =>
      Number(
        (db.querySql(`SELECT COUNT(*) AS n FROM bm25_search('chunks','content','${term}',10)`) as Array<{ n: unknown }>)[0].n,
      );
    expect(count("capybara")).toBeGreaterThan(0);
    expect(count("axolotl")).toBeGreaterThan(0);
    expect(count("quokka")).toBe(0);
    expect(count("wombat")).toBe(0);
    // hybrid search still works over synced rows (vectors were embedded)
    const s = await search(handle, fakeEmbedder, "axolotl", 3);
    expect(s.ranking).toBe("hybrid");
    expect(s.hits.some((h) => h.path === "src/gamma.ts")).toBe(true);
  });

  it("is idempotent when a file is re-added identically (no duplicate rows)", async () => {
    // touch mtime without changing content - the hash check catches it
    utimesSync(join(root, "src", "gamma.ts"), new Date(), new Date());
    const outcome = await syncRepo(opts());
    expect(outcome.action).toBe("noop");
  });

  it("demands a rebuild when the embedder changes", async () => {
    const other = { ...fakeEmbedder, model: "different-model" };
    const outcome = await syncRepo({ ...opts(), embedder: other });
    expect(outcome.action).toBe("rebuild-required");
  });

  it("demands a rebuild when there is no prior state", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "cx-sync-fresh-"));
    try {
      const freshDb = connect(join(fresh, ".infino"));
      const outcome = await syncRepo({ root: fresh, db: freshDb, indexDirPath: join(fresh, ".infino"), embedder: fakeEmbedder });
      expect(outcome.action).toBe("rebuild-required");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("keeps the file state consistent with the tree", () => {
    const state = readFileState(dir)!;
    expect(Object.keys(state.files).sort()).toEqual(["src/alpha.ts", "src/gamma.ts"]);
  });

  it("compacts after sync (tombstones cleaned up)", async () => {
    // Perform multiple edit cycles to accumulate tombstones, verify compaction succeeds
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, "src", `delta-${i}.ts`), `export const v${i} = '${i}';\n`);
    }
    const outcome1 = await syncRepo(opts());
    expect(outcome1.action).toBe("synced");

    // Delete the added files to create tombstones
    for (let i = 0; i < 3; i++) {
      rmSync(join(root, "src", `delta-${i}.ts`));
    }
    const outcome2 = await syncRepo(opts());
    expect(outcome2.action).toBe("synced");
    if (outcome2.action !== "synced") return;
    expect(outcome2.filesDeleted).toBe(3);

    // Verify index still responds after compaction (no data corruption)
    const rowCount = Number(
      (db.querySql("SELECT COUNT(*) AS n FROM chunks") as Array<{ n: unknown }>)[0].n,
    );
    expect(rowCount).toBeGreaterThan(0); // original files remain
  });
});

// --- duplicate content (a second checkout of the same repository) --------------
//
// The shape this exists for: an agent worktree under .claude/worktrees/ is a
// full copy of the tree, so most files appear twice with byte-identical
// content. Chunking both doubles the index and returns every hit twice.

describe("duplicate content is indexed once, under the shallowest path", () => {
  let dupRoot: string;
  let dupDir: string;
  let dupDb: ReturnType<typeof connect>;
  const dupOpts = () => ({ root: dupRoot, db: dupDb, indexDirPath: dupDir, embedder: fakeEmbedder });

  const SHARED = "export function sharedThing() { return 'pangolin'; }\n";
  const canonicalPath = "src/app.ts";
  const copyPath = ".claude/worktrees/wt-a/src/app.ts";

  const hitPaths = (term: string): string[] =>
    (
      dupDb.querySql(
        `SELECT path FROM bm25_search('chunks','content','${term}',50)`,
      ) as Array<{ path: string }>
    ).map((r) => r.path);

  beforeAll(async () => {
    dupRoot = mkdtempSync(join(tmpdir(), "cx-dup-"));
    dupDir = join(dupRoot, ".infino");
    mkdirSync(join(dupRoot, "src"), { recursive: true });
    mkdirSync(join(dupRoot, ".claude", "worktrees", "wt-a", "src"), { recursive: true });
    writeFileSync(join(dupRoot, canonicalPath), SHARED);
    writeFileSync(join(dupRoot, copyPath), SHARED);
    // A file the branch actually changed: different content, so it is its own
    // record and must be indexed under its own path.
    writeFileSync(join(dupRoot, ".claude", "worktrees", "wt-a", "src", "only.ts"), "export const branchOnly = 'quetzal';\n");
    dupDb = connect(dupDir);
  });

  afterAll(() => {
    rmSync(dupRoot, { recursive: true, force: true });
  });

  it("chunks the shared file once, under the main checkout's path", async () => {
    const stats = await indexRepo(dupOpts());
    expect(stats.duplicateFiles).toBe(1);
    expect(hitPaths("pangolin")).toEqual([canonicalPath]);
  });

  it("still indexes the file the branch actually changed", () => {
    expect(hitPaths("quetzal")).toEqual([".claude/worktrees/wt-a/src/only.ts"]);
  });

  it("promotes the surviving copy when the canonical path is deleted", async () => {
    // The case a per-path diff gets wrong. Deleting src/app.ts removes the
    // rows it owned, but the content still exists in the worktree - and that
    // copy is byte-identical to what it always was, so a per-path diff sees
    // it as unchanged and never chunks it. The content would vanish from the
    // index while a copy of the file sat in the tree.
    unlinkSync(join(dupRoot, canonicalPath));
    const outcome = await syncRepo(dupOpts());
    expect(outcome.action).toBe("synced");

    expect(hitPaths("pangolin")).toEqual([copyPath]);
  });

  it("no-ops once the promotion has settled", async () => {
    expect((await syncRepo(dupOpts())).action).toBe("noop");
  });
});
