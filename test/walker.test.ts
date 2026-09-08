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
