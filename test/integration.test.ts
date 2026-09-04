// End-to-end over a real engine catalog in a temp dir: index a small fixture
// repo (fake embedder - no model download in CI), then exercise every door.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo, indexRepoStaged } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { analyzerTokens, find, runSql, search } from "../src/core/searcher.js";
import { SEARCH_FULL_HITS, TABLE } from "../src/core/config.js";
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
  // A plain-text file long enough to chunk as fixed windows (60 lines, 10
  // overlapping), so a line in the overlap lives in two chunks. Line 55 is in
  // windows 1-60 and 51-110; line 20 carries analyzer edge cases; line 130 is
  // longer than the excerpt cap with its marker past the cap.
  const notes = Array.from({ length: 130 }, (_, i) => `filler ${i + 1}`);
  notes[19] = "parse_config(Path) ABC-123 x.y Süd ok";
  notes[54] = "OVERLAP_MARK sits in two windows";
  notes[129] = "z".repeat(600) + " FAR_MARK " + "z".repeat(300);
  writeFileSync(join(root, "notes.txt"), notes.join("\n") + "\n");
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
    expect(m.files).toBe(4); // auth.ts, storage.ts, README.md, notes.txt (.gitignore is not indexable)
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

  it("tiers the result: content on the top hits, a one-line excerpt below them", async () => {
    // The fixture has more chunks than SEARCH_FULL_HITS, so a wide k reaches
    // the excerpt tier. Every hit stays citable: path, line range, and either
    // the chunk or the line of it that best matches the query.
    const r = await search(handle, fakeEmbedder, "filler", 10);
    expect(r.fullHits).toBe(SEARCH_FULL_HITS);
    expect(r.hits.length).toBeGreaterThan(SEARCH_FULL_HITS);
    r.hits.forEach((h, rank) => {
      if (rank < SEARCH_FULL_HITS) {
        expect(h.content, `hit ${rank}`).toBeDefined();
        expect(h.excerpt, `hit ${rank}`).toBeUndefined();
      } else {
        expect(h.content, `hit ${rank}`).toBeUndefined();
        expect(h.excerpt, `hit ${rank}`).toBeTruthy();
        expect(h.excerpt!.includes("\n"), `hit ${rank}`).toBe(false);
        // A chunk that holds the term shows the line with it, not its first line.
        if (h.path === "notes.txt") expect(h.excerpt, `hit ${rank}`).toMatch(/filler/);
      }
    });
  });
});

describe("find", () => {
  it("returns every line containing the literal, cited path:line, in file order", () => {
    // `verifySession(` on line 2 and `revokeSession(` on line 5 of auth.ts; the
    // header comment's "Session tokens" has no "(" and must not match.
    const r = find(handle, "Session(");
    expect(r.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/auth.ts:2", "src/auth.ts:5"]);
    expect(r.matches[0].text).toContain("export function verifySession(token: string)");
    expect(r.matches[0].symbol).toContain("verifySession");
    expect(r.total).toBe(2);
    expect(r.files).toBe(1);
    expect(r.byFile).toEqual([{ path: "src/auth.ts", count: 2 }]);
    expect(r.truncated).toBeUndefined();
    expect(r.ignoreCase).toBe(false);
  });

  it("counts matches per file over every match, most first, even when the list is cut", () => {
    // `export function` twice in each of auth.ts and storage.ts; the tie
    // breaks on path. The cut list is one line, the counts are still whole.
    const r = find(handle, "export function", { limit: 1 });
    expect(r.matches.length).toBe(1);
    expect(r.total).toBe(4);
    expect(r.byFile).toEqual([
      { path: "src/auth.ts", count: 2 },
      { path: "src/storage.ts", count: 2 },
    ]);
  });

  it("reports a line that lives in two overlapping chunks once", () => {
    const r = find(handle, "OVERLAP_MARK");
    expect(r.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["notes.txt:55"]);
    expect(r.total).toBe(1);
    // The overlap is real: the line is in two indexed chunks.
    const rows = handle.db.querySql(
      `SELECT start_line FROM ${TABLE} WHERE path = 'notes.txt' AND start_line <= 55 AND end_line >= 55`,
    );
    expect(rows.length).toBe(2);
  });

  it("windows a long line around the match so the cited text contains it", () => {
    const r = find(handle, "FAR_MARK");
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].line).toBe(130);
    expect(r.matches[0].text).toContain("FAR_MARK");
    expect(r.matches[0].text.startsWith("...")).toBe(true);
  });

  it("agrees with the engine's analyzer on which chunks are candidates", () => {
    // The client-side token mirror must produce the same candidate set as
    // handing the raw text to the engine, or a literal the repo does contain
    // could be missed. Checked on strings with the analyzer's edge cases:
    // underscores and punctuation as separators, digits, a dropped non-ASCII run.
    const table = handle.db.openTable(TABLE);
    const chunks = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => `${r.path}:${r.start_line}`).sort();
    for (const text of ["parse_config(Path)", "ABC-123 x.y", "Süd ok", "Session(", "session record"]) {
      const viaEngine = table.tokenMatch("content", text, { mode: "and", projection: ["path", "start_line"] });
      const viaMirror = table.tokenMatch("content", analyzerTokens(text).join(" "), {
        mode: "and",
        projection: ["path", "start_line"],
      });
      expect(viaEngine.length, text).toBeGreaterThan(0);
      expect(chunks(viaMirror), text).toEqual(chunks(viaEngine));
    }
  });

  it("carries the partial-index marker like search does", () => {
    const partial = { ...handle, manifest: { ...handle.manifest, truncatedFiles: 3, maxFiles: 10 } };
    expect(find(partial, "Session(").partial?.filesSkipped).toBe(3);
    expect(find(handle, "Session(").partial).toBeUndefined();
  });

  it("rejects a malformed limit instead of returning nothing", () => {
    expect(() => find(handle, "Session(", { limit: Number.NaN })).toThrow(/positive integer/);
    expect(() => find(handle, "Session(", { limit: 0 })).toThrow(/positive integer/);
    expect(() => find(handle, "Session(", { limit: 2.5 })).toThrow(/positive integer/);
    // Over the hard cap clamps rather than errors: a big number is a valid wish.
    expect(find(handle, "Session(", { limit: 10_000 }).total).toBe(2);
  });

  it("matches the literal, not just its tokens", () => {
    // The comment says "session record"; "record session" has the same tokens
    // in the same chunk and occurs nowhere.
    expect(find(handle, "session record").total).toBe(1);
    expect(find(handle, "record session").total).toBe(0);
  });

  it("is case-sensitive unless asked otherwise", () => {
    expect(find(handle, "verifysession").total).toBe(0);
    const r = find(handle, "verifysession", { ignoreCase: true });
    expect(r.matches.map((m) => m.line)).toEqual([2]);
    expect(r.ignoreCase).toBe(true);
  });

  it("caps the matches and still reports the repo-wide total", () => {
    const r = find(handle, "Session(", { limit: 1 });
    expect(r.matches.length).toBe(1);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("refuses a query the index cannot look up", () => {
    expect(() => find(handle, "->")).toThrow(/ASCII/);
    expect(() => find(handle, "a\nb")).toThrow(/newline/);
    expect(() => find(handle, "")).toThrow(/non-empty/);
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
