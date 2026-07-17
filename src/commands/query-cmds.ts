// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx search` / `cx sql` / `cx status` - the query commands.

import { openIndex, NoIndexError } from "../core/context.js";
import { indexDir, resolveRoot } from "../core/config.js";
import { createEmbedder, embedderInfo } from "../core/embedder.js";
import { search, runSql, jsonify } from "../core/searcher.js";
import {
  receiptEnabled,
  searchEntry,
  sqlEntry,
  formatReceipt,
  recordUsage,
  readUsage,
  clearUsage,
  fmtTokens,
  recordHookEvent,
  currentSessionStats,
} from "../core/usage.js";
import { bold, dim, cyan, yellow, green, table, fmtAge, fmtCount, fmtMs } from "../core/output.js";

function die(err: unknown): never {
  const msg = err instanceof NoIndexError ? err.message : `error: ${(err as Error).message}`;
  console.error(msg);
  process.exit(1);
}

export interface SearchCmdOptions {
  k: string;
  json?: boolean;
  path?: string;
}

export async function searchCmd(query: string, opts: SearchCmdOptions): Promise<void> {
  try {
    const handle = openIndex(opts.path);
    const result = await search(handle, createEmbedder(), query, Number(opts.k));
    if (receiptEnabled()) {
      const entry = searchEntry(result, handle.root);
      recordUsage(handle.dir, entry);
      console.error(dim(formatReceipt(entry)));
    }
    if (opts.json) {
      console.log(jsonify(result, true));
      return;
    }
    if (result.note) console.error(yellow(`note: ${result.note}`));
    if (result.partial) console.error(yellow(`warning: ${result.partial.note}`));
    result.hits.forEach((h, i) => {
      console.log(
        `${bold(String(i + 1) + ".")} ${cyan(h.path)}${dim(`:${h.startLine}-${h.endLine}`)} ${dim(`(${result.ranking} ${h.score.toFixed(3)})`)}`,
      );
      console.log(`  ${h.content.split("\n").slice(0, 5).join("\n  ")}\n`);
    });
    if (result.hits.length === 0) console.error(yellow("no hits"));
  } catch (err) {
    die(err);
  }
}

export interface SqlCmdOptions {
  embed?: string[];
  json?: boolean;
  path?: string;
}

export async function sqlCmd(statement: string, opts: SqlCmdOptions): Promise<void> {
  try {
    const handle = openIndex(opts.path);
    const embeds: Record<string, string> = {};
    for (const pair of opts.embed ?? []) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--embed expects name=text, got "${pair}"`);
      embeds[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const rows = await runSql(handle, createEmbedder(), statement, embeds);
    if (receiptEnabled()) {
      const entry = sqlEntry(statement, rows);
      recordUsage(handle.dir, entry);
      console.error(dim(formatReceipt(entry)));
    }
    if (opts.json) {
      console.log(jsonify(rows, true));
      return;
    }
    console.log(table(rows));
  } catch (err) {
    die(err);
  }
}

export interface StatusCmdOptions {
  json?: boolean;
  /** One-line output for a SessionStart hook. */
  hook?: boolean;
  path?: string;
}

export function statusCmd(opts: StatusCmdOptions): void {
  let handle;
  try {
    handle = openIndex(opts.path);
  } catch (err) {
    if (opts.hook) return; // a hook in an unindexed repo stays silent
    die(err);
  }
  const m = handle.manifest;
  if (opts.hook) {
    console.log(
      `code-context index: ${fmtCount(m.chunks)} chunks from ${fmtCount(m.files)} files, ` +
        `vectors ${m.vectors}, indexed ${fmtAge(m.indexedAt)}. ` +
        `MCP tools: search (terms + meaning), sql (aggregation), reindex (after big edits).`,
    );
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  console.log(`${bold("code-context")} - ${handle.root}`);
  console.log(`  chunks     ${fmtCount(m.chunks)} from ${fmtCount(m.files)} files`);
  if (m.truncatedFiles) {
    console.log(
      yellow(
        `  partial    ${fmtCount(m.truncatedFiles)} files over the ${fmtCount(m.maxFiles ?? 0)}-file cap were skipped (raise CX_MAX_FILES / --max-files)`,
      ),
    );
  }
  console.log(`  vectors    ${m.vectors}${m.embedder ? dim(`  (${m.embedder.provider} ${m.embedder.model}, ${m.embedder.dim}d)`) : ""}`);
  console.log(`  indexed    ${fmtAge(m.indexedAt)}${dim(` (keyword ${fmtMs(m.indexMs)}${m.embedMs ? `, vectors ${fmtMs(m.embedMs)}` : ""})`)}`);
  const langs = Object.entries(m.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([lang, n]) => `${lang} ${fmtCount(n)}`)
    .join(" · ");
  if (langs) console.log(`  languages  ${langs}`);
  console.log(dim(`  embedder   ${embedderInfo()}`));
}

export interface UsageCmdOptions {
  json?: boolean;
  /** How many of the most recent queries to list (default 20). */
  n?: string;
  all?: boolean;
  clear?: boolean;
  /** Consume a Claude Code hook event on stdin instead of printing a report. */
  hook?: boolean;
  path?: string;
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 3) + "..." : s);

/** `cx usage` - the local ledger of what queries went through the index and a
 * compact summary of what each returned. Read straight off `.infino/usage.jsonl`,
 * so it's deterministic and needs no running server or model. */
export async function usageCmd(opts: UsageCmdOptions): Promise<void> {
  // Hook mode: invoked by Claude Code hooks (UserPromptSubmit / PostToolUse)
  // with the event JSON on stdin. Update the local prompt/invocation counters
  // and print nothing - hook stdout on UserPromptSubmit would be injected into
  // the prompt, and a hook must never fail the session.
  if (opts.hook) {
    try {
      const payload = JSON.parse(await readStdin());
      const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      recordHookEvent(indexDir(resolveRoot(cwd)), payload);
    } catch {
      // telemetry is best-effort
    }
    return;
  }

  const root = resolveRoot(opts.path);
  const dir = indexDir(root);

  if (opts.clear) {
    clearUsage(dir);
    console.log("usage log cleared");
    return;
  }

  const entries = readUsage(dir);
  const session = currentSessionStats(dir);
  if (opts.json) {
    console.log(jsonify({ queries: entries, session }, true));
    return;
  }
  if (entries.length === 0 && (!session || session.prompts === 0)) {
    console.error(yellow("no usage recorded yet - run `cx search`/`cx sql` here, or query via the MCP server"));
    return;
  }

  const totalReturned = entries.reduce((n, e) => n + e.returnedTokens, 0);
  console.log(`${bold("code-context usage")} - ${root}`);
  if (entries.length) {
    console.log(dim(`  ${fmtCount(entries.length)} queries | ~${fmtTokens(totalReturned)} tokens returned | since ${fmtAge(entries[0].ts)}`));
  }
  // The prompts-vs-invocations ratio comes from the Claude Code hooks (see
  // `cx hook`); it's only here when those hooks are wired up.
  if (session && session.prompts > 0) {
    const used = Math.min(session.promptsWithCx, session.prompts);
    const calls = `${session.cxCalls} call${session.cxCalls === 1 ? "" : "s"}`;
    console.log(dim(`  this session: code-context used in ${used} of ${session.prompts} prompts (${calls})`));
  }
  console.log("");

  const limit = opts.all ? entries.length : Math.max(1, Number(opts.n ?? 20));
  for (const e of entries.slice(-limit)) {
    const clock = new Date(e.ts).toLocaleTimeString("en-US", { hour12: false });
    const tool = e.tool.padEnd(6);
    const q = cyan(`"${truncate(e.query, 52)}"`);
    if (e.tool === "search") {
      const hits = e.hits ?? [];
      const files = new Set(hits.map((h) => h.path)).size;
      console.log(
        `${dim(clock)}  ${bold(tool)}  ${q}  ${dim(`-> ${hits.length} hits / ${files} files | ~${fmtTokens(e.returnedTokens)} tok | ${e.ranking ?? "?"}`)}`,
      );
      const locs = hits.slice(0, 5).map((h) => `${h.path}:${h.startLine}-${h.endLine}`);
      if (locs.length) console.log(green(`            ${locs.join("  ")}${hits.length > 5 ? dim(`  (+${hits.length - 5} more)`) : ""}`));
    } else {
      console.log(
        `${dim(clock)}  ${bold(tool)}  ${q}  ${dim(`-> ${e.rows ?? 0} rows | ~${fmtTokens(e.returnedTokens)} tok`)}`,
      );
    }
  }
}

/** Read all of stdin (the Claude Code hook payload); empty when run by hand. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(""); // invoked by hand, no payload
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}
