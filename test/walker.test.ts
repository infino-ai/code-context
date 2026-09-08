import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkRepo } from "../src/core/walker.js";

let root: string;

function file(rel: string, content = "x") {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-walker-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("walkRepo", () => {
  it("respects the root .gitignore", () => {
    file(".gitignore", "secret.txt\nlogs/\n");
    file("keep.ts");
    file("secret.txt");
    file("logs/app.log");
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths).toContain("keep.ts");
    expect(paths).toContain(".gitignore");
    expect(paths).not.toContain("secret.txt");
    expect(paths).not.toContain("logs/app.log");
  });

  it("applies nested .gitignore files to their own subtree", () => {
    file("sub/.gitignore", "local.out\n");
    file("sub/local.out");
    file("local.out"); // same name at root is NOT covered by sub's ignore
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths).not.toContain("sub/local.out");
    expect(paths).toContain("local.out");
  });

  it("always skips vendored directories and the index dir", () => {
    file("node_modules/pkg/index.js");
    file(".infino/manifest.json");
    file(".git/HEAD");
    file("src/app.ts");
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".infino/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("walks agent worktrees rather than skipping them", () => {
    // A worktree holds a live branch, which is the code most worth searching.
    // The duplication a second checkout brings is handled by content dedup at
    // chunk time, not by hiding the tree - so the walk must surface it, and
    // shallow-first ordering must put the main checkout's copy first so it is
    // the one that gets chunked.
    file("src/app.ts");
    file(".claude/worktrees/wt-a/src/app.ts");
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain(".claude/worktrees/wt-a/src/app.ts");
    expect(paths.indexOf("src/app.ts")).toBeLessThan(paths.indexOf(".claude/worktrees/wt-a/src/app.ts"));
  });

  it("sorts shallow-first so caps keep the important files", () => {
    file("deep/nested/far/away.ts");
    file("README.md");
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths.indexOf("README.md")).toBeLessThan(paths.indexOf("deep/nested/far/away.ts"));
  });

  it("does not follow symlinks", () => {
    file("real/target.ts");
    symlinkSync(join(root, "real"), join(root, "link"));
    const paths = walkRepo(root).files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("link/"))).toBe(false);
  });

  it("reports the directories .gitignore kept out, outermost-only", () => {
    // The shape that made this a bug: an umbrella repo whose sibling checkouts
    // are gitignored so they stay out of `git status`. They are still the code
    // somebody wants to search.
    file(".gitignore", "engine/\nplatform/\nbuilt-docs/\n");
    file("engine/src/lib.rs");
    file("engine/deep/nested/mod.rs");
    file("platform/gateway.rs");
    file("built-docs/index.html");
    file("src/app.ts");

    const walked = walkRepo(root);
    expect(walked.files.map((f) => f.path)).toContain("src/app.ts");
    expect(walked.files.some((f) => f.path.startsWith("engine/"))).toBe(false);
    // Outermost-only: `engine` stands for its whole subtree, so the nested
    // directories under it are not listed separately.
    expect(walked.ignoredDirs).toEqual(["built-docs", "engine", "platform"]);
  });

  it("does not report the always-skipped directories as gitignored", () => {
    // `.git` and `node_modules` are the normal state of every walk; listing
    // them would bury the entries that mean a real coverage gap.
    file("node_modules/pkg/index.js");
    file(".git/HEAD");
    file("src/app.ts");
    expect(walkRepo(root).ignoredDirs).toEqual([]);
  });

  it(".cxignore excludes from search without touching what git tracks", () => {
    // The distinction the file exists for: a committed fixture directory is
    // tracked by git and is still not worth searching, and .gitignore cannot
    // say that without also untracking it.
    file(".cxignore", "fixtures/\n*.golden\n");
    file("fixtures/huge.json");
    file("expected.golden");
    file("src/app.ts");

    const walked = walkRepo(root);
    const paths = walked.files.map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths.some((p) => p.startsWith("fixtures/"))).toBe(false);
    expect(paths).not.toContain("expected.golden");
    // Not reported as a coverage gap: the caller wrote it down, and warning
    // about it every run would train them to ignore the warning that matters.
    expect(walked.ignoredDirs).toEqual([]);
  });

  it("keeps .cxignore in force with .gitignore turned off", () => {
    file(".gitignore", "engine/\n");
    file(".cxignore", "fixtures/\n");
    file("engine/src/lib.rs");
    file("fixtures/huge.json");
    file("src/app.ts");

    const paths = walkRepo(root, { respectGitignore: false }).files.map((f) => f.path);
    // --no-ignore is about git's opinion, not the caller's.
    expect(paths).toContain("engine/src/lib.rs");
    expect(paths.some((p) => p.startsWith("fixtures/"))).toBe(false);
  });

  it("--include re-admits one gitignored tree without admitting the rest", () => {
    file(".gitignore", "engine/\nplatform/\nbuilt-docs/\n");
    file("engine/src/lib.rs");
    file("platform/gateway.rs");
    file("built-docs/index.html");
    file("src/app.ts");

    const walked = walkRepo(root, { include: ["engine/"] });
    const paths = walked.files.map((f) => f.path);
    expect(paths).toContain("engine/src/lib.rs");
    expect(paths.some((p) => p.startsWith("platform/"))).toBe(false);
    // And the ones still excluded are still reported, so the remaining gap is
    // visible rather than looking solved.
    expect(walked.ignoredDirs).toEqual(["built-docs", "platform"]);
  });

  it("--include cannot re-admit what .cxignore excluded", () => {
    // Precedence that has to hold: git's opinion is overridable, the caller's
    // own is not.
    file(".gitignore", "fixtures/\n");
    file(".cxignore", "fixtures/\n");
    file("fixtures/huge.json");
    file("src/app.ts");

    const paths = walkRepo(root, { include: ["fixtures/"] }).files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("fixtures/"))).toBe(false);
  });

  it("--include cannot re-admit the never-useful directories", () => {
    file("node_modules/pkg/index.js");
    file("src/app.ts");
    const paths = walkRepo(root, { include: ["node_modules/"] }).files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });

  it("indexes gitignored trees when asked not to honour .gitignore", () => {
    file(".gitignore", "engine/\n");
    file("engine/src/lib.rs");
    file("src/app.ts");

    const walked = walkRepo(root, { respectGitignore: false });
    expect(walked.files.map((f) => f.path)).toContain("engine/src/lib.rs");
    // Nothing was kept out, so there is nothing to warn about.
    expect(walked.ignoredDirs).toEqual([]);
    // The skip list still applies with .gitignore off.
    file("node_modules/pkg/index.js");
    const again = walkRepo(root, { respectGitignore: false });
    expect(again.files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
  });
});
