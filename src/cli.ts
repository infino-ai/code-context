#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// code-context / cx - local code search for AI coding agents.

import { Command } from "commander";
import { indexCmd } from "./commands/index-cmd.js";
import { sqlCmd, statusCmd, usageCmd } from "./commands/query-cmds.js";

const program = new Command();

program
  .name("cx")
  .description(
    "Local code search for AI coding agents - an index in plain files under .infino/,\n" +
      "queried through one door: read-only SQL with ranked search table functions.\n" +
      "hybrid_search fuses keyword + semantic ranking, bm25_search covers the window\n" +
      "before vectors finish backfilling, and GROUP BY turns either into aggregation.",
  )
  .version("0.1.4")
  .addHelpText(
    "after",
    `
Examples:
  cx index                            index the current repo (keyword search is live in seconds)
  cx sql "SELECT path, start_line, end_line, symbol, content \\
          FROM hybrid_search('chunks','content','auth handling','embedding', {{q}}, 10)" \\
        --embed "q=where is auth handled"
  cx sql "SELECT path, SUM(end_line - start_line + 1) AS lines \\
          FROM bm25_search('chunks','content','vector index', 300) \\
          GROUP BY path ORDER BY lines DESC LIMIT 10"
  cx mcp                              serve the MCP tools (sql/reindex) over stdio`,
  );

program
  .command("index")
  .description("bring the index up to date (incremental; full build on first run)")
  .argument("[path]", "repo root to index")
  .option("--full", "force a full rebuild instead of an incremental sync")
  .option("-w, --watch", "keep watching the tree and sync on changes")
  .option("--no-embed", "keyword index only - skip the vector stage")
  .option("--max-files <n>", "cap on files indexed (default 20000)")
  .option("--json", "machine-readable stats")
  .action(indexCmd);

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
  .description("serve the MCP tools (sql / reindex) over stdio")
  .option("-C, --path <dir>", "repo root (default: current directory)")
  .action(async (opts: { path?: string }) => {
    const { serveMcp } = await import("./mcp/server.js");
    await serveMcp(opts.path);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
