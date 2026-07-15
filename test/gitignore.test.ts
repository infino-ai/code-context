// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Auto-manage .gitignore: a build keeps the on-disk index out of the user's
// commits, idempotently and only when it makes sense.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo } from "../src/core/indexer.js";
import type { Embedder } from "../src/core/embedder.js";

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => new Array(16).fill(0.01)),
  dim: async () => 16,
  provider: "fake",
  model: "fake-16d",
};

let root: string;
const gitignore = () => join(root, ".gitignore");
const readIgnore = () => readFileSync(gitignore(), "utf8");

/** A git checkout with one source file, ready to index. */
function makeRepo(): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
}

async function index(indexDirPath = join(root, ".infino")): Promise<void> {
  const db = connect(indexDirPath);
  await indexRepo({ root, db, indexDirPath, embedder: fakeEmbedder });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-gitignore-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("auto-manage .gitignore", () => {
  it("creates a .gitignore and ignores the index dir on first build", async () => {
    makeRepo();
    await index();
    expect(existsSync(gitignore())).toBe(true);
    expect(readIgnore().split(/\r?\n/)).toContain(".infino/");
  });

  it("appends to an existing .gitignore without clobbering it (and fixes a missing trailing newline)", async () => {
    makeRepo();
    writeFileSync(gitignore(), "node_modules\ndist"); // no trailing newline
    await index();
    const lines = readIgnore().split(/\r?\n/);
    expect(lines).toContain("node_modules");
    expect(lines).toContain("dist");
    expect(lines).toContain(".infino/");
  });

  it("is idempotent - no duplicate entry when already ignored", async () => {
    makeRepo();
    writeFileSync(gitignore(), ".infino\n"); // already ignored, slash-free form
    await index();
    const count = readIgnore()
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter((l) => l === ".infino").length;
    expect(count).toBe(1);
  });

  it("does nothing outside a git checkout", async () => {
    // no .git dir
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
    await index();
    expect(existsSync(gitignore())).toBe(false);
  });

  it("does not touch .gitignore when the index lives outside the repo", async () => {
    makeRepo();
    const external = mkdtempSync(join(tmpdir(), "cx-ext-"));
    try {
      await index(join(external, "idx"));
      expect(existsSync(gitignore())).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
