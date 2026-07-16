// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over one code index.
//
//   search  - find code: exact terms AND meaning in one ranked pass
//   sql     - the power door: relevance-ranked aggregation over the search
//             table functions (bm25_search / hybrid_search + GROUP BY)
//   reindex - sync from the working tree; replies the moment keyword
//             search is live and backfills vectors in-process
//
// Three tools, deliberately: one way to find, one way to count, one way to
// stay fresh - every additional near-duplicate retrieval tool worsens the
// agent's tool selection. Results carry took_ms - server-side time for
// the call (query embedding included where one happens; no transport).

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "@infino-ai/infino";
import { indexDir, resolveRoot, TABLE, DEFAULT_CAPS, DEFAULT_SEARCH_K } from "../core/config.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import type { IndexHandle } from "../core/context.js";
import { search, runSql, jsonify, partialIndex } from "../core/searcher.js";
import { indexRepoStaged, syncRepo, type SyncOutcome, type IndexStats } from "../core/indexer.js";
import { createEmbedder, embedderInfo, type Embedder } from "../core/embedder.js";
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

  /** Run an index mutation on a repo exclusively; null if one is in flight. */
  const exclusive = <T,>(ctx: RepoCtx, fn: () => Promise<T>): Promise<T> | null => {
    if (ctx.mutation) return null;
    const p = fn().finally(() => {
      ctx.mutation = null;
    });
    ctx.mutation = p.catch(() => undefined); // guard must not reject
    return p;
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight. */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async () => {
      const run = await indexRepoStaged({
        root: ctx.root,
        db: ctx.db,
        indexDirPath: ctx.dir,
        embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
        caps: DEFAULT_CAPS,
      });
      void run.completion; // vectors backfill in-process; manifest flips to "ready"
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
      const run = await indexRepoStaged({
        root: ctx.root,
        db: ctx.db,
        indexDirPath: ctx.dir,
        embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
        caps: DEFAULT_CAPS,
      });
      void run.completion;
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
        "code-context is a local ranked index over this repository - semantic + keyword search and " +
        "SQL over the whole codebase. Reach for it whenever you need to understand or find code: " +
        "understanding how a subsystem works, finding code by meaning or by exact term, gathering " +
        "context before an edit, locating a bug or the code behind a behaviour, reviewing existing " +
        "patterns, planning a refactor, understanding the architecture for feature work, or spotting " +
        "similar/duplicate implementations. It is the primary tool for finding and understanding " +
        "code here, for almost any question about this codebase. Three tools:\n" +
        "- search - find code by meaning or terms across files and understand how something works, " +
        "in one ranked pass.\n" +
        "- sql - counts, rankings, and aggregates over the whole repo in one query, including " +
        "relevance-ranked aggregation ('which files have the most code about X') that file tools " +
        "cannot express at any budget.\n" +
        "- reindex - sync the index after the working tree changes.\n" +
        "Treat a hit's content as authoritative: when it answers the question, answer from it and " +
        "cite path plus line range - you don't need to re-confirm with grep or by opening the file. " +
        "Read a file only for a hit marked truncated (its cited range), or when the results genuinely " +
        "don't cover the question. When one search isn't enough, refine the query and search again - " +
        "the ranked hits are already the relevant regions.\n" +
        "Every tool takes an optional 'path' (an absolute repo root): omit it for the default repo, " +
        "or set it to target a specific one when you're working across more than one repo in a session.\n" +
        "If a result carries a 'partial' marker, the repo exceeded the index's file cap and some files " +
        "were left out: treat a missing match as possibly-unindexed, not proof it's absent.",
    },
  );

  server.registerTool(
    "search",
    {
      title: "Code search (exact terms + meaning)",
      description:
        "Semantic + keyword code search over the indexed repository - a strong default for finding " +
        "and understanding code. Use it to: understand how a subsystem or feature works, find code " +
        "by meaning when you don't know the exact name, locate the code behind a behaviour or bug, " +
        "gather context before making a change, review existing implementations and patterns, find " +
        "everything a refactor would touch, understand the architecture for feature work, or spot " +
        "similar/duplicate code. One pass fuses exact keyword matching (BM25: identifiers, error " +
        "strings, function names, stemmed and scored) with semantic similarity (renamed symbols, " +
        "paraphrases, 'where is X handled'), so it works whether or not you know the words. Each hit " +
        "carries path, line range, and the chunk content with a relevance score - treat it as " +
        "authoritative and answer directly from it, citing path plus line range; you don't need to " +
        "re-confirm a hit with grep or by opening the file. When one search isn't enough, refine the " +
        "query and search again - the index has already ranked the relevant regions. Read a file only " +
        "for a hit marked truncated (its cited start-end range via offset/limit), or when results " +
        "genuinely don't cover the question. (Until the index's vector stage finishes, results are " +
        "keyword-ranked and say so.)",
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
        return ok({
          ...result,
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
        });
      } catch (err) {
        return fail(`search failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "sql",
    {
      title: "SQL over the code index",
      description:
        "Whole-repo analytical questions that file tools cannot express at any budget: counts, " +
        "rankings, GROUP BY across the codebase in one query, " +
        `on table ${TABLE}(path, start_line, end_line, lang, content[, embedding]). ` +
        "Search functions are callable as table-valued relations, so one query can rank AND " +
        "aggregate: bm25_search('" + TABLE + "','content','terms', k) needs no embedding; " +
        "hybrid_search('" + TABLE + "','content','terms','embedding', {{q}}, k) and " +
        "vector_search('" + TABLE + "','embedding', {{q}}, k) take a {{name}} placeholder with an " +
        'embed map: {"q":"query text"}. The canonical move - "which files have the most code about ' +
        'X": SELECT path, SUM(end_line - start_line + 1) AS lines FROM ' +
        `bm25_search('${TABLE}','content','<terms>', 300) GROUP BY path ORDER BY lines DESC LIMIT 15. ` +
        "Build queries on bm25_search/hybrid_search so results are ranked by relevance to the topic, " +
        "not on a raw scan of the whole table. Read-only, single statement.",
      inputSchema: {
        query: z
          .string()
          .describe("A single read-only SELECT or WITH statement. May use search table functions and {{name}} vector placeholders."),
        embed: z
          .record(z.string())
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
        return ok({
          rows,
          ...(partial ? { partial } : {}),
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
        });
      } catch (err) {
        return fail(`sql failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "reindex",
    {
      title: "Sync the code index",
      description:
        "Bring the index up to date with the working tree. Incremental by default: only files that " +
        "changed since the last index are re-chunked and re-embedded, and an unchanged tree is a " +
        "fast no-op, so call this freely after edits. The server also auto-syncs in the background as " +
        "queries arrive. On a repo that has never been indexed this builds the index from scratch, " +
        "replying as soon as keyword search is live (seconds) while vectors backfill behind it. " +
        "Pass full=true to force a rebuild from scratch. Returns what changed plus index status.",
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
          const run = await indexRepoStaged({
            root: ctx.root,
            db: ctx.db,
            indexDirPath: ctx.dir,
            embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
            caps: DEFAULT_CAPS,
          });
          void run.completion; // backfills in-process; manifest flips to "ready"
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}; tools accept an optional 'path' to target other repos)`,
  );
}
