// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` — drop per-client steering into the repo so agents actually
// use the index: a Claude Code project skill + MCP registration + a
// SessionStart status hook; Cursor rules + MCP config with --cursor; an
// AGENTS.md section for everything else. Every write is idempotent and
// merge-preserving — existing config is never clobbered.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "../core/config.js";
import { green, dim, bold } from "../core/output.js";

// assets/ ships in the npm package next to dist/.
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

export interface InstallOptions {
  cursor?: boolean;
  all?: boolean;
  path?: string;
}

export function installCmd(opts: InstallOptions): void {
  const root = resolveRoot(opts.path);
  const wrote: string[] = [];
  const note = (path: string, action: string) => wrote.push(`${green("✓")} ${path} ${dim(`(${action})`)}`);

  // --- always: keep the index out of version control -------------------------
  if (ensureGitignoreEntry(root)) note(".gitignore", ".infino/ added");

  // --- Claude Code ------------------------------------------------------------
  const skillDest = join(root, ".claude", "skills", "code-context", "SKILL.md");
  mkdirSync(dirname(skillDest), { recursive: true });
  copyFileSync(join(ASSETS, "claude-skill", "SKILL.md"), skillDest);
  note(".claude/skills/code-context/SKILL.md", "project skill");

  if (mergeMcpJson(join(root, ".mcp.json"))) note(".mcp.json", "code-context MCP server registered");
  if (mergeClaudeHook(join(root, ".claude", "settings.json"))) {
    note(".claude/settings.json", "SessionStart status hook");
  }

  // --- AGENTS.md (client-neutral) ----------------------------------------------
  if (upsertAgentsSection(join(root, "AGENTS.md"))) note("AGENTS.md", "code search section");

  // --- Cursor (opt-in) ----------------------------------------------------------
  if (opts.cursor || opts.all) {
    const rulesDest = join(root, ".cursor", "rules", "code-context.mdc");
    mkdirSync(dirname(rulesDest), { recursive: true });
    copyFileSync(join(ASSETS, "cursor-rules.mdc"), rulesDest);
    note(".cursor/rules/code-context.mdc", "cursor rules");
    if (mergeMcpJson(join(root, ".cursor", "mcp.json"))) {
      note(".cursor/mcp.json", "code-context MCP server registered");
    }
  }

  console.log(`${bold("code-context")} — installed agent steering in ${root}\n`);
  for (const line of wrote) console.log(`  ${line}`);
  console.log(
    `\n${dim("Next:")} run ${bold("cx index")} here${
      opts.cursor || opts.all ? "" : dim(" (add --cursor for Cursor rules + MCP config)")
    }`,
  );
}

/** Add `.infino/` to the repo .gitignore unless already covered. */
function ensureGitignoreEntry(root: string): boolean {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^\.infino\/?\s*$/m.test(current)) return false;
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}.infino/\n`);
  return true;
}

/** Register the MCP server in a `{"mcpServers": {...}}` JSON file, preserving
 * everything already there. */
function mergeMcpJson(path: string): boolean {
  const config = readJson(path) as { mcpServers?: Record<string, unknown> };
  config.mcpServers ??= {};
  const existing = JSON.stringify(config.mcpServers["code-context"] ?? null);
  config.mcpServers["code-context"] = { command: "cx", args: ["mcp"] };
  if (existing === JSON.stringify(config.mcpServers["code-context"])) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

const HOOK_COMMAND = "cx status --hook";

/** Add a SessionStart hook that surfaces index status, preserving any hooks
 * already configured. */
function mergeClaudeHook(path: string): boolean {
  const config = readJson(path) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
  };
  config.hooks ??= {};
  config.hooks.SessionStart ??= [];
  const present = config.hooks.SessionStart.some((m) =>
    (m.hooks ?? []).some((h) => h.command === HOOK_COMMAND),
  );
  if (present) return false;
  config.hooks.SessionStart.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Insert or refresh the marked code-search section in AGENTS.md. */
function upsertAgentsSection(path: string): boolean {
  const snippet = readFileSync(join(ASSETS, "agents-snippet.md"), "utf8").trimEnd();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const markers = /<!-- code-context:start -->[\s\S]*?<!-- code-context:end -->/;
  let next: string;
  if (markers.test(current)) {
    next = current.replace(markers, snippet);
  } else {
    const sep = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = `${current}${sep}${snippet}\n`;
  }
  if (next === current) return false;
  writeFileSync(path, next);
  return true;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} exists but is not valid JSON — fix or remove it, then re-run`);
  }
}
