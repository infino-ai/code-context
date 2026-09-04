// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over one code index.
//
//   find    - the grep door: every line containing an exact string, cited
//             path:line - complete and unranked
//   search  - find code: exact terms AND meaning in one ranked pass
//   sql     - the power door: relevance-ranked aggregation over the search
//             table functions (bm25_search / hybrid_search + GROUP BY)
//
// Three tools, each a different question: where does this exact text occur,
// what is most relevant to this, how much of what is where. Freshness is not
// a tool: the first query on an unindexed repo builds the index, and every
// query re-syncs it against the working tree (auto-sync, below). A reindex
// tool used to be the fourth; measured, no Sonnet run ever called it and
// Haiku called it where it hurt, and every tool in the list is prompt text
// on every turn. `cx index --full` is the forced rebuild.
// No near-duplicate retrieval tools - those worsen the agent's tool
// selection - so find is unranked and complete where search is ranked and
// top-k, and hybrid search's keyword half already ranks exact identifiers.
// Every sentence in the descriptions below is paid for on every turn and
// was measured to steer selection (docs/benchmark.md, "The tool surface"):
// change them with the bench, not by taste.
// Results carry took_ms - server-side time for the call (query embedding
// included where one happens; no transport).

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "@infino-ai/infino";
import {
  indexDir,
  resolveRoot,
  TABLE,
  DEFAULT_CAPS,
  DEFAULT_SEARCH_K,
  DEFAULT_FIND_LIMIT,
  MAX_FIND_LIMIT,
  hostedTarget,
  hostedLabel,
  autoIndexEnabled as autoIndexSetting,
  autoSyncEnabled as autoSyncSetting,
  subagentEnabled,
  subagentMaxTurns,
  subagentMaxWallSecs,
} from "../core/config.js";
import { runRetrievalAgent } from "../core/retrieval-agent.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import { localDb, openHostedHandle, newHostedMemo, type IndexHandle } from "../core/context.js";
import { find, search, runSql, jsonify, partialIndex } from "../core/searcher.js";
import {
  newSession,
  receiptEnabled,
  findEntry,
  searchEntry,
  sqlEntry,
  subagentEntry,
  withPlatform,
  formatReceipt,
  recordUsage,
} from "../core/usage.js";
import {
  indexRepoStaged,
  syncRepo,
  type SyncOutcome,
  type IndexStats,
  type StagedIndexRun,
} from "../core/indexer.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, type Embedder } from "../core/embedder.js";
import { RepoRegistry, type RepoCtx } from "./repos.js";
import { ensureIndexed, type EnsureResult } from "./ensure.js";

export async function serveMcp(rootPath?: string): Promise<void> {
  const defaultRoot = resolveRoot(rootPath);

  // Hosted mode (--db <url>): the default root's chunks table lives on a
  // platform database. Resolved once here - a bad URL or a missing key fails
  // the server at startup, not on the first tool call. The key stays inside
  // the target; only `hostedLabel` ever reaches a log line.
  const hosted = hostedTarget();

  // Null when the platform embeds server-side (--embed-provider platform):
  // the query paths then run without a client-side vector.
  let embedder: Embedder | null = null;
  const getEmbedder = (): Embedder | null => (embedder ??= createEmbedder());

  // --- per-repo state ---------------------------------------------------------
  // One server serves every repo a session touches: the optional `path` tool
  // arg targets one, defaulting to the startup root. Each repo keeps its own
  // connection, auto-sync clock, and mutation lock, held in a small LRU so a
  // session that roams across many repos doesn't accumulate connections. Only
  // the default root can be hosted (see RepoRegistry.targetFor).
  const registry = new RepoRegistry(defaultRoot, { connect, ...(hosted ? { hosted: { target: hosted } } : {}) });
  const repoFor = (requested?: string): RepoCtx => registry.get(requested);

  // Local: the manifest is re-read per call so staged vector readiness is
  // noticed the moment it lands. Hosted: readiness is the server's (the table
  // exists), memoized on the context once seen; the manifest is the sidecar's
  // when it is a hosted one, else synthesized once from the server's schema.
  const getHandle = async (ctx: RepoCtx): Promise<IndexHandle | null> => {
    if (ctx.hosted) return openHostedHandle(ctx.hosted, ctx.root, ctx.dir, (ctx.hostedMemo ??= newHostedMemo()));
    if (!existsSync(ctx.dir)) return null;
    const manifest = readManifest(ctx.dir);
    if (!manifest) return null;
    return { root: ctx.root, dir: ctx.dir, target: ctx.target, db: ctx.db, manifest };
  };

  // --- freshness: one index mutation at a time per repo, auto-sync on queries -
  // Queries are not queued behind syncs; they run against the current index and
  // the next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce
  // keeps the stat walk off the hot path (~20ms to ~2s depending on repo size).
  // Both switches are forced off for a hosted target whatever the env says: a
  // query must never drop and recreate a table other people share.
  const autoSyncEnabled = autoSyncSetting();
  const syncIntervalMs = Number(process.env.CX_SYNC_INTERVAL_SECS ?? 30) * 1000;
  // A search/sql on a never-indexed repo builds the index inline, then answers
  // on the same call (staged: keyword search live in seconds). Off restores the
  // strict "index it first" error.
  const autoIndexEnabled = autoIndexSetting();

  // A terse, local, factual receipt appended to each query result (tokens
  // returned, files touched, whole-file size it stood in for, session running
  // total). Default on - the trust signal only works when it's there; silence
  // it with CX_NO_RECEIPT. One accumulator per session (this long-lived process).
  const receiptOn = receiptEnabled();
  const session = newSession();

  /** Run an index mutation on a repo exclusively; null if one is in flight. */
  const exclusive = <T,>(ctx: RepoCtx, fn: () => Promise<T>): Promise<T> | null => {
    if (ctx.mutation) return null;
    const p = fn().finally(() => {
      ctx.mutation = null;
    });
    ctx.mutation = p.catch(() => undefined); // guard must not reject
    return p;
  };

  /** Fresh build-scoped embedder: full builds embed in a child process so the
   * bulk pipeline's memory leaves with it (issue #9). Query and sync
   * embedding keep the warm in-process singleton via getEmbedder(). */
  const buildEmbedder = (): Embedder | null => (process.env.CX_NO_EMBED ? null : createIndexingEmbedder());

  /** Let vectors backfill in-process (the manifest flips to "ready"), then
   * release the build's embedder. `completion` never rejects by contract, but
   * nothing on this chain may take that on faith - an unhandled rejection
   * here would kill the whole server. */
  const backfill = (run: StagedIndexRun, emb: Embedder | null) => {
    void run.completion
      .catch(() => undefined)
      .finally(() => void emb?.dispose?.()?.catch(() => undefined));
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight.
   * Local repos only (`localDb` throws for a hosted one; auto-index is off
   * there so this is never reached for it). */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async () => {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({
        root: ctx.root,
        db: localDb(ctx),
        indexDirPath: ctx.dir,
        embedder: emb,
        caps: DEFAULT_CAPS,
      });
      backfill(run, emb);
      return run.text;
    });

  const doSync = async (ctx: RepoCtx): Promise<SyncOutcome> => {
    const outcome = await syncRepo({
      root: ctx.root,
      db: localDb(ctx),
      indexDirPath: ctx.dir,
      embedder: process.env.CX_NO_EMBED ? null : getEmbedder(),
      caps: DEFAULT_CAPS,
    });
    if (outcome.action === "rebuild-required" && outcome.reason !== "vector backfill in progress") {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({
        root: ctx.root,
        db: localDb(ctx),
        indexDirPath: ctx.dir,
        embedder: emb,
        caps: DEFAULT_CAPS,
      });
      backfill(run, emb);
    }
    return outcome;
  };

  const maybeAutoSync = (ctx: RepoCtx) => {
    // A hosted table is never synced by a query, whatever the switch says: the
    // guard sits here, on the one path that would run the mutation, and not
    // only in the environment flag that is meant to keep it off.
    if (ctx.hosted || !autoSyncEnabled || performance.now() - ctx.lastSyncCheck < syncIntervalMs) return;
    ctx.lastSyncCheck = performance.now();
    // Deferred so the triggering query's engine call runs first; the sync's
    // stat walk still shares the process, so on very large repos a
    // concurrent query can feel it. Queries are never queued behind syncs.
    setImmediate(() => {
      const p = exclusive(ctx, () => doSync(ctx));
      p?.catch((err) => console.error(`auto-sync failed: ${(err as Error).message}`));
    });
  };

  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: jsonify(value, true) }] });
  const fail = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });
  const noIndex = (ctx: RepoCtx) =>
    fail(
      ctx.hosted
        ? `no ${TABLE} table at ${ctx.target} - load it with \`cx index --db ${ctx.target}\`.`
        : `no index for ${ctx.root} yet - run \`cx index\` there once (keyword search is live in seconds).`,
    );

  /** Marker attached to a query result when this call built the index. */
  const autoIndexNote = (stats: IndexStats) => ({
    files: stats.files,
    chunks: stats.chunks,
    note:
      "no index existed - built one on this call; keyword search is live now" +
      (stats.vectors === "building" ? " and vectors are backfilling in the background" : ""),
  });

  // The hosted `subagent` tool (--subagent, default off). Its routing line
  // joins the instructions only when the tool is registered: the instructions
  // are prompt text on every turn, and a line for a tool that is not there
  // would cost tokens and steer toward nothing.
  const subagent = subagentEnabled();

  const server = new McpServer(
    { name: "code-context", version: "0.1.2" },
    {
      instructions:
        "code-context is a local index of this repository. Which tool for which question:\n" +
        "- find - every line containing an exact string, where you would grep.\n" +
        "- search - how does X work, where is Y handled, code by meaning.\n" +
        "- sql - counts, rankings, and aggregates across the repo.\n" +
        (subagent
          ? "- subagent - a question or task in plain language; returns the rows it retrieved (facts with path:line and the code), not an answer: compose from them. Spawn several in parallel for independent questions.\n"
          : "") +
        "Hits carry the code: when a hit answers the question, answer from it and cite path:line " +
        "without re-reading the file or re-checking with grep; Read a file only for a hit marked " +
        "truncated. " +
        "Every tool takes an optional 'path' (an absolute repo root) to target another repository. " +
        "A 'partial' marker means files over the index cap were left out, so a missing match is not " +
        "proof of absence.",
    },
  );

  server.registerTool(
    "search",
    {
      title: "Code search (exact terms + meaning)",
      description:
        "Ranked code search fusing exact keyword matching with semantic similarity, so it works " +
        "whether or not you know the words. Use it for 'how does X work', 'where is Y handled', code " +
        "by meaning, context before a change, similar implementations. Each hit carries path, line " +
        "range, and the chunk content: answer and cite from the hits without re-confirming them with " +
        "grep or by opening the file; Read a file only for one marked truncated. When one search is " +
        "not enough, refine the query and search again. For every occurrence of an exact string use " +
        "find; for counts and rankings use sql. The result includes a 'usage' field, a one-line " +
        "receipt of tokens returned, chunks and files.",
      inputSchema: {
        query: z.string().describe("What you're looking for - terms, a phrase, or a description."),
        k: z.number().int().positive().max(50).default(DEFAULT_SEARCH_K).describe("Maximum hits."),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to search. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ query, k, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      let ensured: EnsureResult;
      try {
        ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
      } catch (err) {
        return fail(`indexing failed: ${(err as Error).message}`);
      }
      if ("needsIndex" in ensured) return noIndex(ctx);
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        const result = await search(handle, getEmbedder(), query, k);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = withPlatform(searchEntry(result, ctx.root), ctx);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          ...result,
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`search failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "find",
    {
      title: "Find exact text (every occurrence, like grep -n)",
      description:
        "Every line in the repository containing an exact string, like grep -n: complete and " +
        "unranked, with the repo-wide total and per-file counts (byFile, the grep -c answer). " +
        "Literal text within one line, case-sensitive unless ignoreCase. Use it where you would " +
        "grep: every use or definition of an identifier, an error message, a config key. Not for a " +
        "file you already know - Read that file. For meaning or 'how does X work' use search; for " +
        "rankings use sql. The result includes a 'usage' field, a one-line receipt of tokens " +
        "returned, matches and files.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("The exact text to find, as it appears in the code - an identifier, a string, a key."),
        ignoreCase: z
          .boolean()
          .optional()
          .describe("Match regardless of letter case. Default false: case-sensitive, like grep."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_FIND_LIMIT)
          .default(DEFAULT_FIND_LIMIT)
          .describe("Maximum matching lines to return; the result reports the total either way."),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to search. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ query, ignoreCase, limit, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      let ensured: EnsureResult;
      try {
        ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
      } catch (err) {
        return fail(`indexing failed: ${(err as Error).message}`);
      }
      if ("needsIndex" in ensured) return noIndex(ctx);
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        const result = await find(handle, query, { ignoreCase, limit });
        let usage: string | undefined;
        if (receiptOn) {
          const entry = withPlatform(findEntry(result), ctx);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          ...result,
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`find failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "sql",
    {
      title: "SQL over the code index",
      description:
        "Read-only SQL, one SELECT or WITH, over " +
        `${TABLE}(path, start_line, end_line, lang, symbol, content[, embedding]) - lang is the ` +
        "file extension, e.g. 'rs' - for counts, rankings, and GROUP BY across the whole repo. " +
        "Search functions are table-valued: " +
        `bm25_search('${TABLE}','content','terms', k) needs no embedding; ` +
        `hybrid_search('${TABLE}','content','terms','embedding', {{q}}, k) and ` +
        `vector_search('${TABLE}','embedding', {{q}}, k) take a {{name}} placeholder filled from ` +
        "the embed map. Canonical: SELECT path, SUM(end_line - start_line + 1) AS lines FROM " +
        `bm25_search('${TABLE}','content','<terms>', 300) GROUP BY path ORDER BY lines DESC LIMIT 15. ` +
        "The result includes a 'usage' field, a one-line receipt of tokens returned and rows.",
      inputSchema: {
        query: z
          .string()
          .describe("A single read-only SELECT or WITH statement. May use search table functions and {{name}} vector placeholders."),
        embed: z
          .record(z.string(), z.string())
          .optional()
          .describe('Map of placeholder name → query text, embedded server-side. E.g. {"q":"vector indexing"} fills {{q}}.'),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to query. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ query, embed, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      let ensured: EnsureResult;
      try {
        ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
      } catch (err) {
        return fail(`indexing failed: ${(err as Error).message}`);
      }
      if ("needsIndex" in ensured) return noIndex(ctx);
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        const rows = await runSql(handle, getEmbedder(), query, embed as Record<string, string> | undefined);
        const partial = partialIndex(handle.manifest);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = withPlatform(sqlEntry(query, rows), ctx);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          rows,
          ...(partial ? { partial } : {}),
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`sql failed: ${(err as Error).message}`);
      }
    },
  );

  if (subagent) {
    server.registerTool(
      "subagent",
      {
        title: "Retrieval subagent over the hosted index",
        description:
          "A read-only retrieval subagent over the repository index. Give it a question or task in " +
          "plain language; it searches and ranks across the index itself and returns the facts it " +
          "retrieved - the top rows with exact path, start_line, end_line and the code, in the shape of " +
          "search hits, plus aggregate rows (counts, rankings) and the SQL whose rows answer the " +
          "question - never a summary. Use it " +
          "for how does X work, where is Y handled, which files or symbols, counts and rankings; spawn " +
          "several in parallel for independent questions instead of exploring the code yourself. For " +
          "every occurrence of an exact string use find; for a file you already know, Read it. Answer " +
          "from the rows and cite path:line. The result includes a 'usage' field, a one-line receipt of " +
          "what the call cost.",
        inputSchema: {
          question: z.string().min(1).describe("The question or task, in plain language, about the indexed code."),
          answer: z
            .enum(["sql", "text", "scalar"])
            .default("sql")
            .describe(
              "How the agent closes: sql (default) submits one statement whose rows answer the question and those rows lead the result; " +
                "text or scalar let it reason toward a written answer, which is not returned - the rows it retrieved are.",
            ),
          path: z
            .string()
            .optional()
            .describe(
              "Absolute path to the repository root to ask about. Defaults to the server's configured root; " +
                "set it to target a specific repo when a session spans more than one.",
            ),
        },
      },
      async ({ question, answer, path }) => {
        let ctx: RepoCtx;
        try {
          ctx = repoFor(path);
        } catch (err) {
          return fail((err as Error).message);
        }
        // Only the hosted default root has a retrieval agent behind it; a
        // local repo (any `path` other than the default root) does not.
        if (!ctx.hosted) return fail("subagent needs a hosted index: serve with --db");
        // The same readiness check the other tools make: without a chunks
        // table the platform would spend the whole cold-start budget on
        // "no table described yet" before saying anything useful.
        let ensured: EnsureResult;
        try {
          ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
        } catch (err) {
          return fail(`indexing failed: ${(err as Error).message}`);
        }
        if ("needsIndex" in ensured) return noIndex(ctx);
        try {
          const t0 = performance.now();
          // The spend (turns, tokens) goes to the ledger and the receipt only;
          // the result the model sees is the facts: sql, hits, rows, queries.
          const { result, spend } = await runRetrievalAgent(
            ctx.hosted,
            { question, answer },
            { maxTurns: subagentMaxTurns(), maxWallSecs: subagentMaxWallSecs() },
          );
          let usage: string | undefined;
          if (receiptOn) {
            const entry = withPlatform(subagentEntry(result, spend), ctx);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok({
            ...result,
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`subagent failed: ${(err as Error).message}`);
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (hosted) {
    // The host and the provider, never the key. Readiness is not probed here:
    // a cold database can take a while to answer, and the first tool call
    // reports "no chunks table" itself when the table is missing.
    console.error(
      `code-context MCP server ready on stdio (default root: ${defaultRoot}, hosted ${TABLE} table at ${hostedLabel(hosted)}, ` +
        `embedder: ${embedderInfo()}; auto-index and auto-sync are off for the hosted table; ` +
        "tools accept an optional 'path' to target other, local repos)",
    );
    return;
  }
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}; tools accept an optional 'path' to target other repos)`,
  );
}
