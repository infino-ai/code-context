#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// code-context / cx - local code search for AI coding agents.

import { Command } from "commander";
import { indexCmd, type IndexCmdOptions } from "./commands/index-cmd.js";
import { findCmd, searchCmd, sqlCmd, statusCmd, usageCmd } from "./commands/query-cmds.js";
import { DEFAULT_SEARCH_K, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, DB_URL_ENV, API_KEY_ENV } from "./core/config.js";

/** Help text shared by every command that takes `--db`. */
const DB_OPTION_HELP = `hosted engine target, https://host/<database> (same as ${DB_URL_ENV}; the key comes from ${API_KEY_ENV})`;

/** `--db <url>` is the flag form of CX_DB_URL: it sets that very variable, so
 * every layer below reads one source of truth and the flag and the variable
 * cannot disagree. */
function applyDbOption(db?: string): void {
  if (db !== undefined) process.env[DB_URL_ENV] = db;
}

const program = new Command();

program
  .name("cx")
  .description(
    "Local code search for AI coding agents - an index in plain files under .infino/.\n" +
      "Keyword search seconds after `cx index`; semantic and hybrid search when vectors\n" +
      "finish backfilling; SQL with relevance-ranked aggregation over the whole repo.",
  )
  .version("0.5.0")
  .addHelpText(
    "after",
    `
Examples:
  cx index                            index the current repo (keyword search is live in seconds)
  cx find "parse_config"              every line containing it, path:line - like grep -n
  cx search "parse_config"            exact terms and meaning, one ranked pass
  cx search "where is auth handled"   works when you don't know the words
  cx sql "SELECT path, SUM(end_line - start_line + 1) AS lines \\
          FROM bm25_search('chunks','content','vector index', 300) \\
          GROUP BY path ORDER BY lines DESC LIMIT 10"
  cx mcp                              serve the MCP tools (find/search/sql) over stdio`,
  );

program
  .command("find")
  .description("every line containing an exact string, like grep -n: complete and unranked")
  .argument("<text>", "the exact text to find, as it appears in the code")
  .option("-i, --ignore-case", "match regardless of letter case")
  .option("-c, --count", "print matching lines per file instead of the lines, like grep -c")
  .option("--limit <n>", `maximum matching lines to print (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT})`)
  .option("--json", "machine-readable output")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(findCmd);

program
  .command("index")
  .description("bring the index up to date (incremental; full build on first run)")
  .argument("[path]", "repo root to index")
  .option("--full", "force a full rebuild instead of an incremental sync")
  .option("-w, --watch", "keep watching the tree and sync on changes")
  .option("--no-embed", "keyword index only - skip the vector stage")
  .option("--max-files <n>", "cap on files indexed (default 20000)")
  .option("--db <url>", DB_OPTION_HELP)
  .option("--json", "machine-readable stats")
  .action(async (path: string | undefined, opts: IndexCmdOptions & { db?: string }) => {
    applyDbOption(opts.db);
    await indexCmd(path, opts);
  });

program
  .command("search")
  .description("find code: exact terms and meaning in one ranked pass")
  .argument("<query>", "what you're looking for")
  .option("-k <n>", "maximum hits", String(DEFAULT_SEARCH_K))
  .option("--json", "machine-readable output")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(searchCmd);

program
  .command("sql")
  .description("read-only SQL over the index, including ranked search table functions")
  .argument("<statement>", "a single SELECT/WITH statement")
  .option(
    "--embed <name=text...>",
    "embed text for a {{name}} vector placeholder (repeatable)",
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .option("--json", "machine-readable output")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(sqlCmd);

program
  .command("status")
  .description("show what the index holds and how fresh it is")
  .option("--json", "machine-readable output")
  .option("--hook", "one-line output for a SessionStart hook (silent when unindexed)")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(statusCmd);

program
  .command("usage")
  .description("show the local ledger of queries run and what each returned (from .infino/usage.jsonl)")
  .option("-n <count>", "how many recent queries to list", "20")
  .option("--all", "list every recorded query, not just the most recent")
  .option("--clear", "delete the usage log")
  .option("--hook", "internal: consume a Claude Code hook event on stdin and update the prompt/invocation counters")
  .option("--json", "machine-readable output")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(usageCmd);

program
  .command("mcp")
  .description("serve the MCP tools (find / search / sql) over stdio")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .option("--db <url>", DB_OPTION_HELP)
  .action(async (opts: { path?: string; db?: string }) => {
    applyDbOption(opts.db);
    const { serveMcp } = await import("./mcp/server.js");
    await serveMcp(opts.path);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
