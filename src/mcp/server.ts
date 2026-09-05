// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over the local code index, and two
// more over the same index's platform copy when a database is configured.
//
//   find     - the grep door: every line containing an exact string, cited
//              path:line - complete and unranked
//   search   - find code: exact terms AND meaning in one ranked pass
//   sql      - the power door: relevance-ranked aggregation over the search
//              table functions (bm25_search / hybrid_search + GROUP BY)
//   subagent - with --db: a question handed to the platform's retrieval
//              loop, answered with the rows it retrieved
//   explore  - with --db: a question about a mechanism, answered in writing
//              by the platform's loop with the facts and chain behind it
//
// Each tool is a different question: where does this exact text occur, what
// is most relevant to this, how much of what is where, what do the rows say,
// how does it work. Freshness is not a tool: the first query on an unindexed
// repo builds the index (both places, with --db), and every query re-syncs
// it against the working tree (auto-sync, below). A reindex tool used to be
// one more; measured, no Sonnet run ever called it and Haiku called it where
// it hurt, and every tool in the list is prompt text on every turn.
// `cx index --full` is the forced rebuild.
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
  hostedAnalyzer,
  embedProvider,
  autoIndexEnabled as autoIndexSetting,
  autoSyncEnabled as autoSyncSetting,
  exploreMaxTurns,
  exploreMaxWallSecs,
  subagentK,
  subagentMaxTurns,
  subagentMaxWallSecs,
} from "../core/config.js";
import { runExploreAgent, runRetrievalAgent } from "../core/retrieval-agent.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import { localDb, newHostedMemo, platformLabel, platformTableReady, type IndexHandle } from "../core/context.js";
import { find, search, runSql, jsonify, partialIndex } from "../core/searcher.js";
import {
  newSession,
  receiptEnabled,
  findEntry,
  searchEntry,
  sqlEntry,
  exploreEntry,
  subagentEntry,
  withPlatform,
  formatReceipt,
  recordUsage,
} from "../core/usage.js";
import {
  indexRepoStaged,
  syncRepo,
  syncInProgress,
  type IndexOptions,
  type SyncOutcome,
  type IndexStats,
  type StagedIndexRun,
} from "../core/indexer.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, platformEmbedderInfo, type Embedder } from "../core/embedder.js";
import { RepoRegistry, type RepoCtx } from "./repos.js";
import { ensureIndexed, type EnsureResult } from "./ensure.js";

export async function serveMcp(rootPath?: string): Promise<void> {
  const defaultRoot = resolveRoot(rootPath);

  // The platform database (--db <url>), when one is configured: the default
  // root's chunks table also lives there, written by every build and sync
  // beside the local index and read by the `subagent` and `explore` tools.
  // Resolved once here - a bad URL or a missing key fails the server at
  // startup, not on the first tool call. The key stays inside the target;
  // only `hostedLabel` ever reaches a log line.
  const hosted = hostedTarget();

  // The local model: query embedding for search/sql and the sync's small
  // batches. Null under CX_NO_EMBED.
  let embedder: Embedder | null = null;
  const getEmbedder = (): Embedder | null => (process.env.CX_NO_EMBED ? null : (embedder ??= createEmbedder()));

  // --- per-repo state ---------------------------------------------------------
  // One server serves every repo a session touches: the optional `path` tool
  // arg targets one, defaulting to the startup root. Each repo keeps its own
  // connection, auto-sync clock, and mutation lock, held in a small LRU so a
  // session that roams across many repos doesn't accumulate connections. Only
  // the default root's context carries the platform client (see RepoRegistry).
  const registry = new RepoRegistry(defaultRoot, { connect, ...(hosted ? { hosted: { target: hosted } } : {}) });
  const repoFor = (requested?: string): RepoCtx => registry.get(requested);

  // The manifest is re-read per call so staged vector readiness is noticed
  // the moment it lands.
  const getHandle = (ctx: RepoCtx): IndexHandle | null => {
    if (!existsSync(ctx.dir)) return null;
    const manifest = readManifest(ctx.dir);
    if (!manifest) return null;
    return { root: ctx.root, dir: ctx.dir, target: ctx.target, db: ctx.db, manifest };
  };

  /** The indexer options a build or sync of `ctx` shares: the local index
   * always, and the platform table when the context carries the client - the
   * two are written together, so no path here ever writes one without the
   * other. CX_NO_EMBED means keyword-only in both places, as --no-embed does
   * on the CLI: with no local embedder, the `local` provider gives the
   * platform table no embedding column either. The analyzer is passed only
   * when a flag named one; otherwise a build keeps the table's own. */
  const noEmbed = Boolean(process.env.CX_NO_EMBED);
  const analyzer = hostedAnalyzer();
  const indexTargets = (ctx: RepoCtx): Pick<IndexOptions, "root" | "db" | "hosted" | "indexDirPath" | "embedProvider" | "analyzer" | "caps"> => ({
    root: ctx.root,
    db: localDb(ctx),
    indexDirPath: ctx.dir,
    caps: DEFAULT_CAPS,
    ...(ctx.hosted
      ? { hosted: ctx.hosted, embedProvider: noEmbed ? "local" : embedProvider(), ...(analyzer !== undefined ? { analyzer } : {}) }
      : {}),
  });

  // --- freshness: one index mutation at a time per repo, auto-sync on queries -
  // Queries are not queued behind syncs; they run against the current index and
  // the next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce
  // keeps the stat walk off the hot path (~20ms to ~2s depending on repo size).
  // A sync writes the platform table too, so the two never drift.
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
  const buildEmbedder = (): Embedder | null => (noEmbed ? null : createIndexingEmbedder());

  /** Let the build finish in-process - vectors backfill (the manifest flips
   * to "ready"), then the platform table loads when one is configured - and
   * release the build's embedder. The rest of the build is held on
   * `ctx.completion` so no sync starts under it and the platform tools can say
   * the table is being loaded. `completion` never rejects by contract, but
   * nothing on this chain may take that on faith - an unhandled rejection
   * here would kill the whole server. A failed platform load is logged: the
   * next sync asks for a build, which retries it. */
  const backfill = (ctx: RepoCtx, run: StagedIndexRun, emb: Embedder | null) => {
    const held = run.completion
      .then((stats) => {
        if (stats.hostedError) console.error(`platform load failed for ${ctx.root}: ${stats.hostedError} (the next sync reloads it)`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (ctx.completion === held) ctx.completion = null;
        void emb?.dispose?.()?.catch(() => undefined);
      });
    ctx.completion = held;
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight.
   * The build's completion (vectors, then the platform table when one is
   * configured) runs on in the background, held on `ctx.completion`. */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async () => {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb);
      return run.text;
    });

  const doSync = async (ctx: RepoCtx): Promise<SyncOutcome> => {
    const outcome = await syncRepo({ ...indexTargets(ctx), embedder: getEmbedder() });
    // A rebuild for every reason but "a build is already in flight" (the
    // vector stage, or the platform load - a second build would race it).
    if (outcome.action === "rebuild-required" && !syncInProgress(outcome)) {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb);
    }
    return outcome;
  };

  const maybeAutoSync = (ctx: RepoCtx) => {
    // Never under a build's completion: a diff or a second build would race
    // the vector stage or the platform load. The clock is not advanced, so
    // the first query after the build lands syncs.
    if (!autoSyncEnabled || ctx.completion || performance.now() - ctx.lastSyncCheck < syncIntervalMs) return;
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
    fail(`no index for ${ctx.root} yet - run \`cx index\` there once (keyword search is live in seconds).`);

  /** Marker attached to a query result when this call built the index. */
  const autoIndexNote = (stats: IndexStats) => ({
    files: stats.files,
    chunks: stats.chunks,
    note:
      "no index existed - built one on this call; keyword search is live now" +
      (stats.vectors === "building" ? " and vectors are backfilling in the background" : ""),
  });

  /** The platform tools' first precondition, checked before any build: the
   * context carries the platform client. A repo other than the default root
   * never does - the database holds one chunks table - and building its local
   * index for a tool that will not serve it would be waste. Null when it does. */
  const noPlatform = (tool: string, ctx: RepoCtx): ReturnType<typeof fail> | null =>
    ctx.hosted
      ? null
      : fail(`${tool} works on the repository the server was started for, whose index is also on the platform database; ${ctx.root} is served by find, search and sql only`);

  /** The platform tools' second precondition, after the index exists: the
   * platform's chunks table does too. A table not there yet is either being
   * loaded by the build in flight (its completion, or a sync's rebuild) or was
   * never loaded. Null when ready. */
  const platformNotReady = async (tool: string, ctx: RepoCtx): Promise<ReturnType<typeof fail> | null> => {
    const missing = noPlatform(tool, ctx);
    if (missing) return missing;
    if (await platformTableReady(ctx.hosted!, (ctx.hostedMemo ??= newHostedMemo()))) return null;
    const label = platformLabel(ctx.hosted!);
    return fail(
      ctx.mutation || ctx.completion
        ? `the ${TABLE} table at ${label} is being loaded by the index build in progress - retry when it finishes`
        : `no ${TABLE} table at ${label} yet - run \`cx index --db ${label}\` to load it`,
    );
  };

  // The platform tools (`subagent`, `explore`) are registered whenever a
  // platform database is configured. Their routing lines join the
  // instructions only then: the instructions are prompt text on every turn,
  // and a line for a tool that is not there would cost tokens and steer
  // toward nothing.
  const subagent = hosted !== null;

  const server = new McpServer(
    { name: "code-context", version: "0.1.2" },
    {
      instructions:
        "code-context is a local index of this repository. Which tool for which question:\n" +
        "- find - every line containing an exact string, where you would grep.\n" +
        "- search - how does X work, where is Y handled, code by meaning.\n" +
        "- sql - counts, rankings, and aggregates across the repo.\n" +
        (subagent
          ? "- subagent - a question or task in plain language; returns the rows it retrieved (facts with path:line and the code), not an answer: compose from them. Spawn several in parallel for independent questions. How often a string occurs, per file, is find's byFile.\n" +
            "- explore - a question about a mechanism that spans files (how X works end to end, what calls what); it reads and follows what it finds and returns a written answer grounded in the facts it lists, with the chain of queries. Take the answer and cite its facts. Slower than subagent: use it when one retrieval will not do.\n"
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
          const entry = searchEntry(result, ctx.root);
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
          const entry = findEntry(result);
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
          const entry = sqlEntry(query, rows);
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
        title: "Retrieval subagent over the repository index",
        description:
          "A read-only retrieval subagent over the repository index. Give it a question or task in " +
          "plain language; it searches and ranks across the index itself and returns the facts it " +
          "retrieved - the top rows with exact path, start_line, end_line and the code, in the shape of " +
          "search hits, plus aggregate rows (counts, rankings) and the SQL whose rows answer the " +
          "question - never a summary. Use it " +
          "for how does X work, where is Y handled, which files or symbols; spawn " +
          "several in parallel for independent questions instead of exploring the code yourself. For " +
          "every occurrence of an exact string, and for how many times it occurs per file, use find " +
          "(its byFile is the grep -c answer); for a file you already know, Read it. Answer " +
          "from the rows and cite path:line. The result includes a 'usage' field, a one-line receipt of " +
          "what the call cost.",
        inputSchema: {
          question: z.string().min(1).describe("The question or task, in plain language, about the indexed code."),
          path: z
            .string()
            .optional()
            .describe(
              "Absolute path to the repository root to ask about. Defaults to the server's configured root; " +
                "set it to target a specific repo when a session spans more than one.",
            ),
        },
      },
      async ({ question, path }) => {
        let ctx: RepoCtx;
        try {
          ctx = repoFor(path);
        } catch (err) {
          return fail((err as Error).message);
        }
        // A repo without the platform client is refused before any build.
        // Then the same first-query build and auto-sync the other tools make
        // (both write the platform table too), then the platform table's own
        // readiness: without a chunks table the platform would spend the whole
        // cold-start budget on "no table described yet" before saying
        // anything useful.
        const missing = noPlatform("subagent", ctx);
        if (missing) return missing;
        let ensured: EnsureResult;
        try {
          ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
        } catch (err) {
          return fail(`indexing failed: ${(err as Error).message}`);
        }
        if ("needsIndex" in ensured) return noIndex(ctx);
        if (!ensured.autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
        const notReady = await platformNotReady("subagent", ctx);
        if (notReady) return notReady;
        try {
          const t0 = performance.now();
          // The spend (turns, tokens) goes to the ledger and the receipt only;
          // the result the model sees is the facts: sql, hits, rows, queries.
          const { result, spend } = await runRetrievalAgent(
            ctx.hosted!,
            { question },
            { maxTurns: subagentMaxTurns(), maxWallSecs: subagentMaxWallSecs(), k: subagentK() },
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

    server.registerTool(
      "explore",
      {
        title: "Exploration subagent over the repository index",
        description:
          "A read-only exploration subagent over the repository index. Give it a question about a " +
          "mechanism that spans files - how X works end to end, what calls what, where a value flows; " +
          "it searches, reads what it finds, follows definitions to their uses, and returns answer, " +
          "its written answer, grounded in the facts it lists (hits: the rows it ended on, with exact " +
          "path, start_line, end_line and the code) and the chain of queries it ran. Take the answer " +
          "and cite path:line from its hits; it does not need re-reading or re-checking. Slower and " +
          "dearer than subagent: use subagent for one retrieval, explore when one retrieval will not " +
          "do. For every occurrence of an exact string use find; for a file you already know, Read " +
          "it. The result includes a 'usage' field, a one-line receipt of what the call cost.",
        inputSchema: {
          question: z.string().min(1).describe("The question, in plain language, about the indexed code."),
          path: z
            .string()
            .optional()
            .describe(
              "Absolute path to the repository root to ask about. Defaults to the server's configured root; " +
                "set it to target a specific repo when a session spans more than one.",
            ),
        },
      },
      async ({ question, path }) => {
        let ctx: RepoCtx;
        try {
          ctx = repoFor(path);
        } catch (err) {
          return fail((err as Error).message);
        }
        const missing = noPlatform("explore", ctx);
        if (missing) return missing;
        let ensured: EnsureResult;
        try {
          ensured = await ensureIndexed(ctx, { autoIndexEnabled, getHandle, build: buildIndex });
        } catch (err) {
          return fail(`indexing failed: ${(err as Error).message}`);
        }
        if ("needsIndex" in ensured) return noIndex(ctx);
        if (!ensured.autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
        const notReady = await platformNotReady("explore", ctx);
        if (notReady) return notReady;
        try {
          const t0 = performance.now();
          const { result, spend } = await runExploreAgent(
            ctx.hosted!,
            { question },
            { maxTurns: exploreMaxTurns(), maxWallSecs: exploreMaxWallSecs(), k: subagentK() },
          );
          let usage: string | undefined;
          if (receiptOn) {
            const entry = withPlatform(exploreEntry(result, spend), ctx);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok({
            ...result,
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`explore failed: ${(err as Error).message}`);
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  // The platform's host and its embedder, never the key. The table's
  // readiness is not probed here: a cold database can take a while to answer,
  // and the first platform tool call reports "no chunks table" itself.
  const platform = hosted ? `, ${TABLE} table also at ${hostedLabel(hosted)} (embedder there: ${platformEmbedderInfo()})` : "";
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}${platform}; tools accept an optional 'path' to target other repos)`,
  );
}
