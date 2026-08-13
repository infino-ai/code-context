// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: two tools over one code index.
//
//   sql     - the only search surface: ranked retrieval via the search
//             table functions (hybrid_search / bm25_search) composed
//             freely with GROUP BY, regexp_like, and plain SQL
//   reindex - sync from the working tree; replies the moment keyword
//             search is live and backfills vectors in-process
//
// Two tools, deliberately: one way to query, one way to stay fresh -
// every additional near-duplicate retrieval tool worsens the agent's
// tool selection. Results carry took_ms - server-side time for the
// call (query embedding included where one happens; no transport).

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect } from "@infino-ai/infino";
import { indexDir, resolveRoot, TABLE, DEFAULT_CAPS } from "../core/config.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import type { IndexHandle } from "../core/context.js";
import { runSql, jsonify, partialIndex, vectorsNote } from "../core/searcher.js";
import { newSession, receiptEnabled, sqlEntry, formatReceipt, recordUsage } from "../core/usage.js";
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
  // A sql query on a never-indexed repo builds the index inline, then answers
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

  // Build the index up front rather than on the first query. The server
  // starts with the session, so kicking the staged build here means keyword
  // search is typically live (and vectors backfilling) before the agent asks
  // anything. Best-effort: queries still ensure the index inline.
  if (autoIndexEnabled) {
    setImmediate(() => {
      try {
        const ctx = repoFor(undefined);
        if (!getHandle(ctx)) void buildIndex(ctx)?.catch(() => undefined);
        else maybeAutoSync(ctx);
      } catch {
        // unresolvable root or similar - the first query will surface it
      }
    });
  }

  const server = new McpServer(
    { name: "code-context", version: "0.1.2" },
    {
      instructions:
        "code-context is a local ranked index over this repository. All code search goes through " +
        "the sql tool - ranked retrieval is a table-valued function inside your query, so finding, " +
        "understanding, counting, and ranking code are all one read-only SELECT. It is the primary " +
        "tool for almost any question about this codebase. Two tools:\n" +
        "- sql - THE search surface. Table: chunks(path, start_line, end_line, lang, symbol, " +
        "content[, embedding]). Find code: SELECT path, start_line, end_line, symbol, content FROM " +
        "hybrid_search('chunks','content','<terms>','embedding', {{q}}, 10) with the embed map " +
        '{"q":"<your question>"} - keyword + semantic fused in one ranked pass. ' +
        "bm25_search('chunks','content','<terms>', k) is the keyword arm (use it while vectors are " +
        "still backfilling). Rank and aggregate compose: SELECT path, SUM(end_line - start_line + 1) " +
        "AS lines FROM bm25_search(...) GROUP BY path ORDER BY lines DESC. regexp_like(content, " +
        "'pattern') filters in WHERE. vector_search('chunks','embedding', {{q}}, k) ranks by " +
        "meaning alone; prefer hybrid_search, which keeps the keyword arm too. Always rank with a " +
        "search TVF rather than scanning the table with LIKE.\n" +
        "- reindex - sync the index after the working tree changes (it also auto-syncs in the " +
        "background).\n" +
        "The index builds as the server starts, so it is typically ready before your first query; " +
        "if a result notes vectors are still backfilling, ranking is keyword-only for the moment.\n" +
        "Treat a returned chunk's content as authoritative: when it answers the question, answer " +
        "from it and cite path plus line range - you don't need to re-confirm with grep or by " +
        "opening the file. Read a file only for what the chunks don't show (the cited range via " +
        "offset/limit), never whole files.\n" +
        "Every tool takes an optional 'path' (an absolute repo root): omit it for the default repo, " +
        "or set it to target a specific one when you're working across more than one repo in a " +
        "session.\n" +
        "If a result carries a 'partial' marker, the repo exceeded the index's file cap and some " +
        "files were left out: treat a missing match as possibly-unindexed, not proof it's absent.\n" +
        "Each result carries a 'usage' receipt (tokens returned, rows, and a session running total) " +
        "- computed locally, nothing leaves the machine. Surface it to the user so they can see " +
        "how much context the results put into the conversation.",
    },
  );

  server.registerTool(
    "sql",
    {
      title: "SQL over the code index",
      description:
        "The way to search this codebase - ranked retrieval and whole-repo analytics in one " +
        `read-only SQL statement over ${TABLE}(path, start_line, end_line, lang, symbol, ` +
        "content[, embedding]). Search functions are table-valued relations. Find code: SELECT " +
        "path, start_line, end_line, symbol, content FROM hybrid_search('" + TABLE + "','content'," +
        "'<terms>','embedding', {{q}}, 10) with the embed map " +
        '{"q":"<your question>"} - keyword + semantic fused in one ranked pass; use ' +
        "bm25_search('" + TABLE + "','content','<terms>', k) while vectors are still backfilling. " +
        "Count/rank: SELECT path, SUM(end_line - start_line + 1) AS lines FROM bm25_search('" +
        TABLE + "','content','<terms>', 300) GROUP BY path ORDER BY lines DESC LIMIT 15. " +
        "regexp_like(content, 'pattern') works in WHERE. vector_search('" + TABLE + "','embedding', " +
        "{{q}}, k) ranks by meaning alone; prefer hybrid_search, which keeps the keyword arm too. " +
        "Always rank with a search TVF rather than scanning the table with LIKE. Read-only, single " +
        "statement. Treat returned chunk content " +
        "as authoritative - answer from it and cite path:start-end. The result includes a 'usage' " +
        "field - a one-line receipt (tokens returned, rows, session total). After you answer, end " +
        "your reply by showing that 'usage' line to the user verbatim.",
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
        const note = vectorsNote(handle.manifest);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = sqlEntry(query, rows);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          rows,
          ...(note ? { note } : {}),
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}; tools accept an optional 'path' to target other repos)`,
  );
}
