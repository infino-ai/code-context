// End-to-end over a real engine catalog in a temp dir: index a small fixture
// repo (fake embedder - no model download in CI), then exercise every door.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo, indexRepoStaged } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { runSql, search } from "../src/core/searcher.js";
import type { IndexHandle } from "../src/core/context.js";
import type { Embedder } from "../src/core/embedder.js";

let root: string;
let dir: string;
let handle: IndexHandle;

// Deterministic fake embedder (dim 16 = engine minimum).
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cx-int-"));
  dir = join(root, ".infino");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "auth.ts"),
    `// Session tokens and verification.
export function verifySession(token: string): boolean {
  return token.length > 10;
}
export function revokeSession(token: string): void {
  // tombstone the session record
}
`,
  );
  writeFileSync(
    join(root, "src", "storage.ts"),
    `// Durable writes go through the commit log.
export function appendCommit(data: Buffer): void {}
export function replayLog(): number { return 42; }
`,
  );
  writeFileSync(join(root, "README.md"), "# Fixture\n\nA tiny repo about sessions and commit logs.\n");
  writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(root, "ignored.ts"), "export const SHOULD_NOT_APPEAR = 1;\n");

  const db = connect(dir);
  const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder });
  expect(stats.vectors).toBe("ready");
  handle = { root, dir, db, manifest: readManifest(dir)! };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("indexing", () => {
  it("indexes the fixture and honors .gitignore", () => {
    const m = handle.manifest;
    expect(m.files).toBe(3); // auth.ts, storage.ts, README.md (.gitignore is not indexable)
    expect(m.vectors).toBe("ready");
    expect(m.embedder?.dim).toBe(16);
    const rows = handle.db.querySql("SELECT DISTINCT path FROM chunks ORDER BY path") as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).not.toContain("ignored.ts");
  });

  it("staged run reports keyword readiness before vectors", async () => {
    const staged = await indexRepoStaged({ root, db: handle.db, indexDirPath: dir, embedder: fakeEmbedder });
    expect(staged.text.vectors).toBe("building");
    const final = await staged.completion;
    expect(final.vectors).toBe("ready");
  });
});

describe("search", () => {
  it("finds exact identifiers through the keyword half", async () => {
    const r = await search(handle, fakeEmbedder, "verifySession token", 5);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].path).toBe("src/auth.ts");
    expect(r.hits[0].startLine).toBeGreaterThan(0);
    expect(r.hits[0].content).toContain("verifySession");
  });

  it("hybrid ranking once vectors are ready", async () => {
    const r = await search(handle, fakeEmbedder, "session verification", 5);
    expect(r.ranking).toBe("hybrid");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].path).toMatch(/auth|README/);
  });

  it("keyword ranking while vectors are not ready", async () => {
    const noVec = { ...handle, manifest: { ...handle.manifest, vectors: "building" as const } };
    const r = await search(noVec, fakeEmbedder, "commit log", 5);
    expect(r.ranking).toBe("keyword");
    expect(r.note).toMatch(/vectors not ready/);
  });
});

describe("sql", () => {
  it("ranked aggregation through the search table function", async () => {
    const rows = await runSql(
      handle,
      fakeEmbedder,
      "SELECT path, SUM(end_line - start_line + 1) AS lines FROM bm25_search('chunks','content','session', 100) GROUP BY path ORDER BY lines DESC",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[0].path)).toBe("src/auth.ts");
  });

  it("hybrid table function via {{q}} embed map", async () => {
    const rows = await runSql(
      handle,
      fakeEmbedder,
      "SELECT path FROM hybrid_search('chunks','content','session','embedding', {{q}}, 10)",
      { q: "session verification" },
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects writes", async () => {
    await expect(runSql(handle, fakeEmbedder, "DELETE FROM chunks")).rejects.toThrow(/read-only/);
  });
});
