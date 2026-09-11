// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dev context handed to the platform's loop: which files, in what order,
// under what headings, and how the byte budget cuts it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DEV_CONTEXT_MAX_BYTES, devContext, devContextMaxBytes, devContextParts } from "../src/core/dev-context.js";

describe("devContext", () => {
  const roots: string[] = [];
  const root = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "cx-dev-context-"));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is undefined for a repository with no instructions", () => {
    expect(devContext(root())).toBeUndefined();
    expect(devContextParts(root())).toEqual([]);
  });

  it("shows CLAUDE.md, the .claude copy, the local file, AGENTS.md and then each skill, each under its path", () => {
    const dir = root();
    writeFileSync(join(dir, "AGENTS.md"), "agents body\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# Infino — notes for AI agents\n\nclaude body\n");
    mkdirSync(join(dir, ".claude", "skills", "release"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "bench"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "release", "SKILL.md"), "---\nname: release\n---\ncut a release\n");
    writeFileSync(join(dir, ".claude", "skills", "bench", "SKILL.md"), "run the bench\n");
    // A skill directory without a SKILL.md, and an empty instruction file,
    // are not context.
    mkdirSync(join(dir, ".claude", "skills", "empty"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.local.md"), "   \n");

    expect(devContextParts(dir).map((p) => p.path)).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      join(".claude", "skills", "bench", "SKILL.md"),
      join(".claude", "skills", "release", "SKILL.md"),
    ]);
    expect(devContext(dir)).toBe(
      [
        "# CLAUDE.md\n\n# Infino — notes for AI agents\n\nclaude body",
        "# AGENTS.md\n\nagents body",
        `# ${join(".claude", "skills", "bench", "SKILL.md")}\n\nrun the bench`,
        `# ${join(".claude", "skills", "release", "SKILL.md")}\n\n---\nname: release\n---\ncut a release`,
      ].join("\n\n"),
    );
  });

  it("shows the same text once when AGENTS.md is a copy of CLAUDE.md", () => {
    const dir = root();
    const map = "# Infino — notes for AI agents\n\nthe map of the tree\n";
    writeFileSync(join(dir, "CLAUDE.md"), map);
    writeFileSync(join(dir, "AGENTS.md"), map);
    writeFileSync(join(dir, "CLAUDE.local.md"), "my own notes\n");
    expect(devContextParts(dir).map((p) => p.path)).toEqual(["CLAUDE.md", "CLAUDE.local.md"]);
    expect(devContext(dir)).toBe(`# CLAUDE.md\n\n${map.trim()}\n\n# CLAUDE.local.md\n\nmy own notes`);
  });

  it("cuts at the byte budget on a line boundary and says how much was left out", () => {
    const dir = root();
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")} of the instructions`);
    writeFileSync(join(dir, "CLAUDE.md"), lines.join("\n"));
    const whole = devContext(dir)!;
    const cut = devContext(dir, 1_000)!;
    expect(cut.length).toBeLessThan(whole.length);
    const [kept, note] = cut.split("\n\n[dev context truncated: ");
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(1_000);
    // Whole lines only: the last kept line is one of the source lines.
    expect(kept.split("\n").at(-1)).toMatch(/^line \d{3} of the instructions$/);
    const dropped = Number(/^(\d+) more bytes not shown\]$/.exec(note)![1]);
    expect(dropped).toBe(Buffer.byteLength(whole, "utf8") - Buffer.byteLength(kept, "utf8"));
    // Infino's own CLAUDE.md (28 KB) fits the default whole.
    expect(DEFAULT_DEV_CONTEXT_MAX_BYTES).toBeGreaterThan(28 * 1024);
  });

  it("reads the byte budget from CX_DEV_CONTEXT_MAX_BYTES and refuses a value that is not a count", () => {
    expect(devContextMaxBytes({})).toBe(DEFAULT_DEV_CONTEXT_MAX_BYTES);
    expect(devContextMaxBytes({ CX_DEV_CONTEXT_MAX_BYTES: " 65536 " })).toBe(65_536);
    expect(devContextMaxBytes({ CX_DEV_CONTEXT_MAX_BYTES: "0" })).toBe(0);
    expect(() => devContextMaxBytes({ CX_DEV_CONTEXT_MAX_BYTES: "lots" })).toThrow(/CX_DEV_CONTEXT_MAX_BYTES/);
    expect(() => devContextMaxBytes({ CX_DEV_CONTEXT_MAX_BYTES: "-1" })).toThrow(/CX_DEV_CONTEXT_MAX_BYTES/);
  });
});
