// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx search` / `cx sql` / `cx status` — the query commands.

import { openIndex, NoIndexError } from "../core/context.js";
import { createEmbedder, embedderInfo } from "../core/embedder.js";
import { search, runSql, jsonify } from "../core/searcher.js";
import { bold, dim, cyan, yellow, table, fmtAge, fmtCount, fmtMs } from "../core/output.js";

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
    if (opts.json) {
      console.log(jsonify(result, true));
      return;
    }
    if (result.note) console.error(yellow(`note: ${result.note}`));
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
    if (opts.json) {
      console.log(jsonify(rows, true));
      return;
    }
    console.log(table(rows));
    console.error(dim(`${rows.length} row${rows.length === 1 ? "" : "s"}`));
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
  console.log(`${bold("code-context")} — ${handle.root}`);
  console.log(`  chunks     ${fmtCount(m.chunks)} from ${fmtCount(m.files)} files`);
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
