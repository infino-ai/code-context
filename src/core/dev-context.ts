// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The repository's own instructions for an agent - what a developer's Claude
// Code session loads before it touches the code - gathered so `ask` and
// `explore` can hand the same context to the platform's loop. The caller
// already has it: it read CLAUDE.md at startup. The model inside the loop did
// not, and it is the one writing the queries, so a question that says "the
// manifest layer" reached a model that had never seen the file telling it
// where the manifest layer lives.
//
// Read on every call rather than memoized: the files are a few kilobytes,
// the MCP server lives for a whole session, and an instruction edited
// mid-session should reach the next question, not the next restart.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The instruction files a session loads, in the order they are shown. The
 * first two are Claude Code's own; `CLAUDE.local.md` is the developer's
 * uncommitted additions; `AGENTS.md` is the cross-tool convention some
 * repositories use instead of, or beside, CLAUDE.md. */
const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

/** Where a repository's skills live; each skill is one directory holding a
 * SKILL.md whose frontmatter and body say when and how to use it. */
const SKILLS_DIR = join(".claude", "skills");
const SKILL_FILE = "SKILL.md";

/** Environment override for the byte budget below. */
const MAX_BYTES_ENV = "CX_DEV_CONTEXT_MAX_BYTES";

/** The most dev context one call carries, in bytes.
 *
 * The context rides in the loop's user message and is therefore re-sent on
 * every turn - no provider the loop runs on prices cached input, so its cost
 * is bytes times turns. 32 KiB is about 8k tokens; at the explore budget of
 * 25 turns that is a ceiling of ~200k prompt tokens per call, a few cents at
 * the loop's blended rate and inside every window the loop's models offer.
 * Infino's own CLAUDE.md (28 KB) fits whole. Raise it with
 * CX_DEV_CONTEXT_MAX_BYTES when a repository's instructions are larger and
 * the spend is acceptable. */
export const DEFAULT_DEV_CONTEXT_MAX_BYTES = 32 * 1024;

/** What is said in place of the part that did not fit. */
const TRUNCATED_NOTE = (dropped: number) => `\n\n[dev context truncated: ${dropped} more bytes not shown]`;

export function devContextMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_BYTES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_DEV_CONTEXT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${MAX_BYTES_ENV} must be a non-negative integer byte count, got "${raw}"`);
  }
  return n;
}

/** One instruction file or skill, as it is shown to the loop. */
export interface DevContextPart {
  /** Path relative to the repository root, as the heading names it. */
  path: string;
  text: string;
}

/** Every instruction file and skill under `root`, in the order shown. The
 * same text under two names is shown once, under the first: repositories
 * keep AGENTS.md as a copy of CLAUDE.md for tools that read one or the
 * other, and infino's 28 KB map twice would have spent the whole budget on
 * one file. */
export function devContextParts(root: string): DevContextPart[] {
  const parts: DevContextPart[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const text = readIfFile(join(root, rel));
    if (text === undefined || seen.has(text)) return;
    seen.add(text);
    parts.push({ path: rel, text });
  };
  for (const rel of INSTRUCTION_FILES) add(rel);
  const skillsRoot = join(root, SKILLS_DIR);
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    // Sorted so the order is the same on every call and every machine.
    for (const name of readdirSync(skillsRoot).sort()) add(join(SKILLS_DIR, name, SKILL_FILE));
  }
  return parts;
}

/** The dev context for `root` as one string for the loop, each part under a
 * heading naming its file, cut at `maxBytes` with a note saying how much was
 * left out; `undefined` when the repository has none. */
export function devContext(root: string, maxBytes: number = devContextMaxBytes()): string | undefined {
  const parts = devContextParts(root);
  if (parts.length === 0) return undefined;
  const whole = parts.map((p) => `# ${p.path}\n\n${p.text.trim()}`).join("\n\n");
  const size = Buffer.byteLength(whole, "utf8");
  if (size <= maxBytes) return whole;
  // Cut on a line boundary inside the budget so the note follows a whole
  // line rather than half a word or half a multi-byte character.
  let cut = Buffer.from(whole, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
  const lastLine = cut.lastIndexOf("\n");
  if (lastLine > 0) cut = cut.slice(0, lastLine);
  return `${cut}${TRUNCATED_NOTE(size - Buffer.byteLength(cut, "utf8"))}`;
}

/** The file's text, or undefined when there is no regular file there or it
 * is empty; a directory or an unreadable entry is treated as absent. */
function readIfFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    const text = readFileSync(path, "utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
