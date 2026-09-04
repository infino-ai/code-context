// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: four tools over one code index.
//
//   find    - the grep door: every line containing an exact string, cited
//             path:line - complete and unranked
//   context - ranked code for a topic: exact terms AND meaning in one pass
//   sql     - the power door: relevance-ranked aggregation over the search
//             table functions (bm25_search / hybrid_search + GROUP BY)
//   reindex - sync from the working tree; replies the moment keyword
//             search is live and backfills vectors in-process
//
// Four tools, each a different question: where does this exact text occur,
// what is most relevant to this, how much of what is where, and stay fresh.
// No near-duplicate retrieval tools - those worsen the agent's tool
// selection - so find is unranked and complete where search is ranked and
// top-k, and hybrid search's keyword half already ranks exact identifiers.
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
} from "../core/config.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import type { IndexHandle } from "../core/context.js";
import { find, search, runSql, jsonify, partialIndex } from "../core/searcher.js";
import {
  newSession,
  receiptEnabled,
  findEntry,
  searchEntry,
  sqlEntry,
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

  let embedder: Embedder | null = null;
  const getEmbedder = () => (embedder ??= createEmbedder());

  // --- per-repo state ---------------------------------------------------------
  // One server serves every repo a session touches: the optional `path` tool
  // arg targets one, defaulting to the startup root. Each repo keeps its own
  // connection, auto-sync clock, and mutation lock, held in a small LRU so a
  // session that roams across many repos doesn't accumulate connections.
  const registry = new RepoRegistry(defaultRoot, { connect });
  const repoFor = (requested?: string): RepoCtx => registry.get(requested);

  // The manifest is re-read per call so staged vector readiness is noticed the
  // moment it lands.
  const getHandle = (ctx: RepoCtx): IndexHandle | null => {
    if (!existsSync(ctx.dir)) return null;
    const manifest = readManifest(ctx.dir);
    if (!manifest) return null;
    return { root: ctx.root, dir: ctx.dir, db: ctx.db, manifest };
  };

  // --- freshness: one index mutation at a time per repo, auto-sync on queries -
  // Queries are not queued behind syncs; they run against the current index and
  // the next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce
  // keeps the stat walk off the hot path (~20ms to ~2s depending on repo size).
  const autoSyncEnabled = !["0", "false", "no"].includes((process.env.CX_AUTO_SYNC ?? "").toLowerCase());
  const syncIntervalMs = Number(process.env.CX_SYNC_INTERVAL_SECS ?? 30) * 1000;
  // A search/sql on a never-indexed repo builds the index inline, then answers
  // on the same call (staged: keyword search live in seconds). Off restores the
  // strict "index it first" error.
  const autoIndexEnabled = !["0", "false", "no"].includes((process.env.CX_AUTO_INDEX ?? "").toLowerCase());

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
  const buildEmbedder = () => (process.env.CX_NO_EMBED ? undefined : createIndexingEmbedder());

  /** Let vectors backfill in-process (the manifest flips to "ready"), then
   * release the build's embedder. `completion` never rejects by contract, but
   * nothing on this chain may take that on faith - an unhandled rejection
   * here would kill the whole server. */
  const backfill = (run: StagedIndexRun, emb: Embedder | undefined) => {
    void run.completion
      .catch(() => undefined)
      .finally(() => void emb?.dispose?.()?.catch(() => undefined));
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight. */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async () => {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({
        root: ctx.root,
        db: ctx.db,
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
      db: ctx.db,
      indexDirPath: ctx.dir,
      embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
      caps: DEFAULT_CAPS,
    });
    if (outcome.action === "rebuild-required" && outcome.reason !== "vector backfill in progress") {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({
        root: ctx.root,
        db: ctx.db,
        indexDirPath: ctx.dir,
        embedder: emb,
        caps: DEFAULT_CAPS,
      });
      backfill(run, emb);
    }
    return outcome;
  };

  const maybeAutoSync = (ctx: RepoCtx) => {
    if (!autoSyncEnabled || performance.now() - ctx.lastSyncCheck < syncIntervalMs) return;
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
  const noIndex = (root: string) =>
    fail(`no index for ${root} yet - call the reindex tool once (keyword search is live in seconds).`);

  /** Marker attached to a query result when this call built the index. */
  const autoIndexNote = (stats: IndexStats) => ({
    files: stats.files,
    chunks: stats.chunks,
    note:
      "no index existed - built one on this call; keyword search is live now" +
      (stats.vectors === "building" ? " and vectors are backfilling in the background" : ""),
  });

  const timed = <T,>(fn: () => T): { value: T; tookMs: number } => {
    const t0 = performance.now();
    const value = fn();
    return { value, tookMs: Math.round((performance.now() - t0) * 1000) / 1000 };
  };

  const server = new McpServer(
    { name: "code-context", version: "0.1.2" },
    {
      instructions:
        "code-context is a local index of this repository. Which tool for which question:\n" +
        "- find - every line containing an exact string, where you would grep.\n" +
        "- context - how does X work, where is Y handled, code by meaning.\n" +
        "- sql - counts, rankings, and aggregates across the repo.\n" +
        "- reindex - after sweeping edits; the server auto-syncs otherwise.\n" +
        "Answer and cite from results (path:line); Read a file only for a hit marked truncated. " +
        "Every tool takes an optional 'path' (an absolute repo root) to target another repository. " +
        "A 'partial' marker means files over the index cap were left out, so a missing match is not " +
        "proof of absence.",
    },
  );

  server.registerTool(
    "context",
    {
      title: "Code context on a topic (exact terms + meaning)",
      description:
        "Ranked code context on a topic, fusing exact keyword matching with semantic similarity, so it works " +
        "whether or not you know the words. Use it for 'how does X work', 'where is Y handled', code " +
        "by meaning, context before a change, similar implementations. Each hit carries path, line " +
        "range, and the chunk content: answer and cite from the hits; Read a file only for one marked " +
        "truncated. For every occurrence of an exact string use find; for counts and rankings use " +
        "sql.",
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
      if ("needsIndex" in ensured) return noIndex(ctx.root);
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
        return fail(`context failed: ${(err as Error).message}`);
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
        "file you already know - Read that file. For meaning or 'how does X work' use context; for " +
        "rankings use sql.",
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
      if ("needsIndex" in ensured) return noIndex(ctx.root);
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const { value: result, tookMs } = timed(() => find(handle, query, { ignoreCase, limit }));
        let usage: string | undefined;
        if (receiptOn) {
          const entry = findEntry(result);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          ...result,
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: tookMs,
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
        `${TABLE}(path, start_line, end_line, lang, symbol, content[, embedding]) for counts, ` +
        "rankings, and GROUP BY across the whole repo. Search functions are table-valued: " +
        `bm25_search('${TABLE}','content','terms', k) needs no embedding; ` +
        `hybrid_search('${TABLE}','content','terms','embedding', {{q}}, k) and ` +
        `vector_search('${TABLE}','embedding', {{q}}, k) take a {{name}} placeholder filled from ` +
        "the embed map. Canonical: SELECT path, SUM(end_line - start_line + 1) AS lines FROM " +
        `bm25_search('${TABLE}','content','<terms>', 300) GROUP BY path ORDER BY lines DESC LIMIT 15.`,
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
      if ("needsIndex" in ensured) return noIndex(ctx.root);
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

  // Plan 101 variant V3: CX_HIDE_REINDEX takes the tool off the surface so the
  // ablation can measure its absence from the same build; auto-sync and
  // auto-index cover the job in-session and `cx index --full` on the CLI.
  const hideReindex = ["1", "true", "yes"].includes((process.env.CX_HIDE_REINDEX ?? "").toLowerCase());
  if (!hideReindex) {
  server.registerTool(
    "reindex",
    {
      title: "Sync the code index",
      description:
        "Sync the index with the working tree: incremental, or a full rebuild with full=true. The " +
        "server auto-syncs as queries arrive and builds the index on the first query of an unindexed " +
        "repo, so this is rarely needed.",
      inputSchema: {
        full: z.boolean().optional().describe("Force a full rebuild instead of an incremental sync."),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to index. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ full, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      try {
        const runFull = async () => {
          const emb = buildEmbedder();
          const run = await indexRepoStaged({
            root: ctx.root,
            db: ctx.db,
            indexDirPath: ctx.dir,
            embedder: emb,
            caps: DEFAULT_CAPS,
          });
          backfill(run, emb);
          return ok({ status: "rebuilt - keyword search live; vectors backfilling", ...run.text });
        };
        const result = exclusive(ctx, async () => {
          if (full) return runFull();
          const outcome = await syncRepo({
            root: ctx.root,
            db: ctx.db,
            indexDirPath: ctx.dir,
            embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
            caps: DEFAULT_CAPS,
          });
          if (outcome.action === "rebuild-required") {
            if (outcome.reason === "vector backfill in progress") {
              return ok({ status: "index build already in progress - search is available meanwhile" });
            }
            return runFull();
          }
          return ok({
            status: outcome.action === "noop" ? "index already up to date" : "synced",
            ...outcome,
          });
        });
        if (!result) return ok({ status: "a sync is already running - search is available meanwhile" });
        return await result;
      } catch (err) {
        return fail(`reindex failed: ${(err as Error).message}`);
      }
    },
  );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}; tools accept an optional 'path' to target other repos)`,
  );
}
