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
    const paths = walkRepo(root).map((f) => f.path);
    expect(paths).toContain("keep.ts");
    expect(paths).toContain(".gitignore");
    expect(paths).not.toContain("secret.txt");
    expect(paths).not.toContain("logs/app.log");
  });

  it("applies nested .gitignore files to their own subtree", () => {
    file("sub/.gitignore", "local.out\n");
    file("sub/local.out");
    file("local.out"); // same name at root is NOT covered by sub's ignore
    const paths = walkRepo(root).map((f) => f.path);
    expect(paths).not.toContain("sub/local.out");
    expect(paths).toContain("local.out");
  });

  it("always skips vendored directories and the index dir", () => {
    file("node_modules/pkg/index.js");
    file(".infino/manifest.json");
    file(".git/HEAD");
    file("src/app.ts");
    const paths = walkRepo(root).map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".infino/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("sorts shallow-first so caps keep the important files", () => {
    file("deep/nested/far/away.ts");
    file("README.md");
    const paths = walkRepo(root).map((f) => f.path);
    expect(paths.indexOf("README.md")).toBeLessThan(paths.indexOf("deep/nested/far/away.ts"));
  });

  it("does not follow symlinks", () => {
    file("real/target.ts");
    symlinkSync(join(root, "real"), join(root, "link"));
    const paths = walkRepo(root).map((f) => f.path);
    expect(paths.some((p) => p.startsWith("link/"))).toBe(false);
  });
});
