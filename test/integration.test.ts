// End-to-end over a real engine catalog in a temp dir: index a small fixture
// repo (fake embedder - no model download in CI), then exercise every door.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo, indexRepoStaged, syncRepo } from "../src/core/indexer.js";
import { readManifest } from "../src/core/manifest.js";
import { analyzerOf, analyzerTokens, find, plainTerms, runSql, search } from "../src/core/searcher.js";
import { TABLE } from "../src/core/config.js";
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
  // windows 1-60 and 51-110; line 20 carries analyzer edge cases; lines 30
  // and 40 carry the engine's query-grammar characters as literal text; line
  // 130 is longer than the excerpt cap with its marker past the cap.
  const notes = Array.from({ length: 130 }, (_, i) => `filler ${i + 1}`);
  notes[19] = "parse_config(Path) ABC-123 x.y Süd ok";
  notes[29] = "run git -C repo status --max-files 5";
  notes[39] = 'log("hello wörld there")';
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
    // A local build goes through the binding's bare IndexSpec.fts, which the
    // pinned engine indexes with its default analyzer; the manifest says so.
    expect(m.analyzer).toBe("ascii_lower");
    expect(analyzerOf(m)).toBe("ascii_lower");
    const rows = handle.db.querySql("SELECT DISTINCT path FROM chunks ORDER BY path") as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).not.toContain("ignored.ts");
  });

  it("staged run reports keyword readiness before vectors", async () => {
    const staged = await indexRepoStaged({ root, db: handle.db, indexDirPath: dir, embedder: fakeEmbedder });
    expect(staged.text.vectors).toBe("building");
    const final = await staged.completion;
    expect(final.vectors).toBe("ready");
  });

  it("sync asks for a rebuild when the requested analyzer differs from the recorded one", async () => {
    // The analyzer is fixed at table creation; a sync cannot change it.
    const out = await syncRepo({ root, db: handle.db, indexDirPath: dir, embedder: fakeEmbedder, analyzer: "standard" });
    expect(out.action).toBe("rebuild-required");
    expect((out as { reason: string }).reason).toMatch(/analyzer changed \(index: ascii_lower, current: standard\)/);
    // The recorded analyzer, or none named, is fine.
    const same = await syncRepo({ root, db: handle.db, indexDirPath: dir, embedder: fakeEmbedder, analyzer: "ascii_lower" });
    expect(same.action).toBe("noop");
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

describe("find", () => {
  it("returns every line containing the literal, cited path:line, in file order", async () => {
    // `verifySession(` on line 2 and `revokeSession(` on line 5 of auth.ts; the
    // header comment's "Session tokens" has no "(" and must not match.
    const r = await find(handle, "Session(");
    expect(r.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/auth.ts:2", "src/auth.ts:5"]);
    expect(r.matches[0].text).toContain("export function verifySession(token: string)");
    expect(r.matches[0].symbol).toContain("verifySession");
    expect(r.total).toBe(2);
    expect(r.files).toBe(1);
    expect(r.byFile).toEqual([{ path: "src/auth.ts", count: 2 }]);
    expect(r.truncated).toBeUndefined();
    expect(r.ignoreCase).toBe(false);
  });

  it("counts matches per file over every match, most first, even when the list is cut", async () => {
    // `export function` twice in each of auth.ts and storage.ts; the tie
    // breaks on path. The cut list is one line, the counts are still whole.
    const r = await find(handle, "export function", { limit: 1 });
    expect(r.matches.length).toBe(1);
    expect(r.total).toBe(4);
    expect(r.byFile).toEqual([
      { path: "src/auth.ts", count: 2 },
      { path: "src/storage.ts", count: 2 },
    ]);
  });

  it("reports a line that lives in two overlapping chunks once", async () => {
    const r = await find(handle, "OVERLAP_MARK");
    expect(r.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["notes.txt:55"]);
    expect(r.total).toBe(1);
    // The overlap is real: the line is in two indexed chunks.
    const rows = handle.db.querySql(
      `SELECT start_line FROM ${TABLE} WHERE path = 'notes.txt' AND start_line <= 55 AND end_line >= 55`,
    );
    expect(rows.length).toBe(2);
  });

  it("windows a long line around the match so the cited text contains it", async () => {
    const r = await find(handle, "FAR_MARK");
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].line).toBe(130);
    expect(r.matches[0].text).toContain("FAR_MARK");
    expect(r.matches[0].text.startsWith("...")).toBe(true);
  });

  it("agrees with the engine's analyzer on which chunks are candidates", () => {
    // find hands the engine the query text (grammar characters blanked) and
    // lets the index's own analyzer tokenize it. That must select the same
    // chunks as the client's ascii_lower mirror, pre-tokenized and joined, or
    // the mirror's "is there anything to look up" check would disagree with
    // what the engine matches. Checked on the analyzer's edge cases:
    // underscores and punctuation as separators, digits, a dropped non-ASCII
    // run, and the engine's own query-grammar characters as literal text.
    const table = handle.db.openTable(TABLE);
    const analyzer = analyzerOf(handle.manifest);
    const chunks = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => `${r.path}:${r.start_line}`).sort();
    for (const text of [
      "parse_config(Path)",
      "ABC-123 x.y",
      "Süd ok",
      "Session(",
      "session record",
      "git -C repo",
      "--max-files 5",
      '"hello wörld there"',
    ]) {
      const viaEngine = table.tokenMatch("content", plainTerms(text), { mode: "and", projection: ["path", "start_line"] });
      const viaMirror = table.tokenMatch("content", analyzerTokens(text, analyzer).join(" "), {
        mode: "and",
        projection: ["path", "start_line"],
      });
      expect(viaEngine.length, text).toBeGreaterThan(0);
      expect(chunks(viaMirror), text).toEqual(chunks(viaEngine));
    }
  });

  it("treats the engine's query-grammar characters as literal text", async () => {
    // Handed raw, `-C` would exclude every chunk holding the token `c`,
    // `--max-files` would be a negation-only query (an engine error), and the
    // quoted phrase would fail its adjacency check across the dropped `wörld`.
    expect((await find(handle, "git -C repo")).matches.map((m) => `${m.path}:${m.line}`)).toEqual(["notes.txt:30"]);
    expect((await find(handle, "--max-files")).matches.map((m) => `${m.path}:${m.line}`)).toEqual(["notes.txt:30"]);
    expect((await find(handle, '"hello wörld there"')).matches.map((m) => `${m.path}:${m.line}`)).toEqual(["notes.txt:40"]);
    // Still a literal match: the same tokens in another order occur nowhere.
    expect((await find(handle, "repo -C git")).total).toBe(0);
    // The witness for why: the engine parses the same strings as grammar.
    const table = handle.db.openTable(TABLE);
    const raw = (q: string) => table.tokenMatch("content", q, { mode: "and", projection: ["path", "start_line"] });
    expect(raw("git -C repo").map((r) => r.path)).not.toContain("notes.txt");
    expect(() => raw("--max-files")).toThrow(/negated/);
  });

  it("carries the partial-index marker like search does", async () => {
    const partial = { ...handle, manifest: { ...handle.manifest, truncatedFiles: 3, maxFiles: 10 } };
    expect((await find(partial, "Session(")).partial?.filesSkipped).toBe(3);
    expect((await find(handle, "Session(")).partial).toBeUndefined();
  });

  it("rejects a malformed limit instead of returning nothing", async () => {
    await expect(find(handle, "Session(", { limit: Number.NaN })).rejects.toThrow(/positive integer/);
    await expect(find(handle, "Session(", { limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(find(handle, "Session(", { limit: 2.5 })).rejects.toThrow(/positive integer/);
    // Over the hard cap clamps rather than errors: a big number is a valid wish.
    expect((await find(handle, "Session(", { limit: 10_000 })).total).toBe(2);
  });

  it("matches the literal, not just its tokens", async () => {
    // The comment says "session record"; "record session" has the same tokens
    // in the same chunk and occurs nowhere.
    expect((await find(handle, "session record")).total).toBe(1);
    expect((await find(handle, "record session")).total).toBe(0);
  });

  it("is case-sensitive unless asked otherwise", async () => {
    expect((await find(handle, "verifysession")).total).toBe(0);
    const r = await find(handle, "verifysession", { ignoreCase: true });
    expect(r.matches.map((m) => m.line)).toEqual([2]);
    expect(r.ignoreCase).toBe(true);
  });

  it("caps the matches and still reports the repo-wide total", async () => {
    const r = await find(handle, "Session(", { limit: 1 });
    expect(r.matches.length).toBe(1);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("refuses a query the index cannot look up, naming the index's analyzer", async () => {
    await expect(find(handle, "->")).rejects.toThrow(/ascii_lower analyzer keeps none/);
    // Under ascii_lower a non-ASCII word is not indexed either.
    await expect(find(handle, "Süd")).rejects.toThrow(/ascii_lower analyzer keeps none/);
    await expect(find(handle, "a\nb")).rejects.toThrow(/newline/);
    await expect(find(handle, "")).rejects.toThrow(/non-empty/);
  });

  it("takes the analyzer from the manifest", async () => {
    // A handle whose manifest records `standard` would accept `Süd`: the
    // rejection is decided by the recorded analyzer, not a built-in rule. (The
    // fixture table is ascii_lower, so the engine finds no candidates - the
    // point is that the client no longer refuses the query.)
    const std = { ...handle, manifest: { ...handle.manifest, analyzer: "standard" as const } };
    expect((await find(std, "Süd")).total).toBe(0);
    await expect(find(std, "->")).rejects.toThrow(/standard analyzer keeps none/);
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
