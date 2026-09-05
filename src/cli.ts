#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// code-context / cx - local code search for AI coding agents.
//
// Configuration is command-line flags. The platform knobs are flags on the two
// commands that write or serve the platform table (`index`, `mcp`); they are
// resolved once, here, into the settings every layer reads (config.ts). The
// API key is the one value that is never a flag - argv is visible to every
// process on the machine - so it comes from a file (--api-key-file) or the
// INFINO_API_KEY environment variable.

import { Command } from "commander";
import { indexCmd, type IndexCmdOptions } from "./commands/index-cmd.js";
import { findCmd, searchCmd, sqlCmd, statusCmd, usageCmd } from "./commands/query-cmds.js";
import {
  DEFAULT_SEARCH_K,
  DEFAULT_FIND_LIMIT,
  MAX_FIND_LIMIT,
  API_KEY_ENV,
  DEFAULT_DB_TIMEOUT_MS,
  DEFAULT_DB_COLD_START_SECS,
  DEFAULT_EXPLORE_MAX_WALL_SECS,
  DEFAULT_SUBAGENT_K,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_MAX_WALL_SECS,
  configureHosted,
  hostedSettingsFromFlags,
  type HostedFlags,
} from "./core/config.js";

/** The flags that name the platform database and tune the client, on the
 * commands that write the platform table (`index`) or serve it (`mcp`): where
 * the database is, how to authenticate, who fills the table's vectors, and the
 * two request budgets. */
function hostedOptions(command: Command): Command {
  return command
    .option("--db <url>", "platform database that also holds this repository's index, https://host/<database> (plain http only for localhost)")
    .option("--api-key-file <path>", `file holding the API key for --db (default: the ${API_KEY_ENV} environment variable)`)
    .option(
      "--embed-provider <platform|local>",
      "who fills the platform table's vectors: platform (default; its own model, server-side) or local (this machine's model, vectors shipped)",
    )
    .option("--db-timeout-ms <n>", `per-request timeout for --db (default ${DEFAULT_DB_TIMEOUT_MS})`)
    .option("--cold-start-secs <n>", `how long to wait out a cold database or a starting embedder (default ${DEFAULT_DB_COLD_START_SECS})`);
}

/** Resolve and install the platform settings from a command's parsed flags. */
function applyHosted(flags: HostedFlags): void {
  configureHosted(hostedSettingsFromFlags(flags));
}

const program = new Command();

program
  .name("cx")
  .description(
    "Local code search for AI coding agents - an index in plain files under .infino/.\n" +
      "Keyword search seconds after `cx index`; semantic and hybrid search when vectors\n" +
      "finish backfilling; SQL with relevance-ranked aggregation over the whole repo.\n" +
      "With --db the same index is also kept on an infino-platform database, where the\n" +
      "subagent and explore tools run.",
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
  cx mcp                              serve the MCP tools (find/search/sql) over stdio
  cx index --db https://api.platform.infino.ws/my-repo --api-key-file ~/.infino/key
                                      index the repo locally AND load it into the platform database
  cx mcp --db https://api.platform.infino.ws/my-repo --api-key-file ~/.infino/key
                                      serve find/search/sql over the local index, plus subagent and
                                      explore over the platform copy; every sync updates both`,
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

hostedOptions(
  program
    .command("index")
    .description("bring the index up to date (incremental; full build on first run); with --db, the platform table too")
    .argument("[path]", "repo root to index")
    .option("--full", "force a full rebuild instead of an incremental sync")
    .option("-w, --watch", "keep watching the tree and sync on changes")
    .option("--no-embed", "keyword index only - skip the vector stage")
    .option("--max-files <n>", "cap on files indexed (default 20000)")
    .option("--json", "machine-readable stats"),
)
  .option(
    "--analyzer <ascii_lower|standard>",
    "FTS analyzer the platform table is created with (default ascii_lower: splits code identifiers on . _ and ::)",
  )
  .action(async (path: string | undefined, opts: IndexCmdOptions & HostedFlags) => {
    applyHosted(opts);
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
  .description("show what the index holds and how fresh it is (and the platform table, when one was loaded)")
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

hostedOptions(
  program
    .command("mcp")
    .description("serve the MCP tools (find / search / sql) over stdio; with --db, also subagent and explore over the platform table")
    .option("-C, --path <dir>", "repo root (default: current directory)"),
)
  .option("--subagent-max-turns <n>", `turn cap for one subagent call (default ${DEFAULT_SUBAGENT_MAX_TURNS})`)
  .option("--subagent-max-wall-secs <n>", `wall-clock cap for one subagent call, in seconds (default ${DEFAULT_SUBAGENT_MAX_WALL_SECS})`)
  .option("--subagent-k <n>", `facts one subagent call asks for and returns (default ${DEFAULT_SUBAGENT_K}, search's k)`)
  .option("--explore-max-turns <n>", "turn cap for one explore call (default: the platform's explore budget)")
  .option("--explore-max-wall-secs <n>", `wall-clock cap for one explore call, in seconds (default ${DEFAULT_EXPLORE_MAX_WALL_SECS})`)
  .action(async (opts: { path?: string } & HostedFlags) => {
    applyHosted(opts);
    const { serveMcp } = await import("./mcp/server.js");
    await serveMcp(opts.path);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
