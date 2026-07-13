// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over one code index.
//
//   search  - find code: exact terms AND meaning in one ranked pass
//   sql     - the power door (relevance-ranked aggregation, regexp_like)
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
import { connect, type Connection } from "@infino-ai/infino";
import { indexDir, resolveRoot, TABLE, DEFAULT_CAPS } from "../core/config.js";
import { readManifest, type Manifest } from "../core/manifest.js";
import type { IndexHandle } from "../core/context.js";
import { search, runSql, jsonify } from "../core/searcher.js";
import { indexRepoStaged, syncRepo, type SyncOutcome } from "../core/indexer.js";
import { createEmbedder, embedderInfo, type Embedder } from "../core/embedder.js";

export async function serveMcp(rootPath?: string): Promise<void> {
  const root = resolveRoot(rootPath);
  const dir = indexDir(root);

  // One connection for the server's lifetime; the manifest is re-read per
  // call so staged vector readiness is noticed the moment it lands.
  let db: Connection | null = null;
  const getDb = () => (db ??= connect(dir));
  const getHandle = (): IndexHandle | null => {
    if (!existsSync(dir)) return null;
    const manifest = readManifest(dir);
    if (!manifest) return null;
    return { root, dir, db: getDb(), manifest };
  };

  let embedder: Embedder | null = null;
  const getEmbedder = () => (embedder ??= createEmbedder());

  // --- freshness: one index mutation at a time, auto-sync on queries ----------
  // Queries are not queued behind syncs; they run against the current index and the
  // next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce keeps
  // the stat walk off the hot path (~20ms to ~2s depending on repo size).
  const autoSyncEnabled = !["0", "false", "no"].includes((process.env.CX_AUTO_SYNC ?? "").toLowerCase());
  const syncIntervalMs = Number(process.env.CX_SYNC_INTERVAL_SECS ?? 30) * 1000;
  let lastSyncCheck = 0;
  let mutation: Promise<unknown> | null = null;

  /** Run an index mutation exclusively; returns null if one is in flight. */
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> | null => {
    if (mutation) return null;
    const p = fn().finally(() => {
      mutation = null;
    });
    mutation = p.catch(() => undefined); // guard must not reject
    return p;
  };

  const doSync = async (): Promise<SyncOutcome> => {
    const outcome = await syncRepo({
      root,
      db: getDb(),
      indexDirPath: dir,
      embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
      caps: DEFAULT_CAPS,
    });
    if (outcome.action === "rebuild-required" && outcome.reason !== "vector backfill in progress") {
      const run = await indexRepoStaged({
        root,
        db: getDb(),
        indexDirPath: dir,
        embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
        caps: DEFAULT_CAPS,
      });
      void run.completion;
    }
    return outcome;
  };

  const maybeAutoSync = () => {
    if (!autoSyncEnabled || performance.now() - lastSyncCheck < syncIntervalMs) return;
    lastSyncCheck = performance.now();
    // Deferred so the triggering query's engine call runs first; the sync's
    // stat walk still shares the process, so on very large repos a
    // concurrent query can feel it. Queries are never queued behind syncs.
    setImmediate(() => {
      const p = exclusive(doSync);
      p?.catch((err) => console.error(`auto-sync failed: ${(err as Error).message}`));
    });
  };

  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: jsonify(value, true) }] });
  const fail = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });
  const noIndex = () =>
    fail(`no index for ${root} yet - call the reindex tool once (keyword search is live in seconds).`);

  const timed = <T,>(fn: () => T): { value: T; tookMs: number } => {
    const t0 = performance.now();
    const value = fn();
    return { value, tookMs: Math.round((performance.now() - t0) * 1000) / 1000 };
  };

  const server = new McpServer(
    { name: "code-context", version: "0.1.0" },
    {
      instructions:
        "code-context is a local search index over this repository - ranked retrieval instead of " +
        "crawling files into context. Three tools:\n" +
        "- search - find code: exact identifiers AND meaning in one ranked pass. Start here.\n" +
        "- sql - counts, rankings, and aggregates over the whole repo in one query, including " +
        "relevance-ranked aggregation ('which files have the most code about X').\n" +
        "- reindex - sync the index after the working tree changes.\n" +
        "Every result cites path plus line range; read the cited file region only when the chunk " +
        "content is not already enough.",
    },
  );

  server.registerTool(
    "search",
    {
      title: "Code search (exact terms + meaning)",
      description:
        "THE way to find code here - one ranked pass fuses exact keyword matching (BM25: " +
        "identifiers, error strings, function names - stemmed and scored) with semantic similarity " +
        "(renamed symbols, paraphrases, 'where is X handled'), so it works whether or not you know " +
        "the exact words. Each hit carries path, line range, and the chunk content with a relevance " +
        "score - usually enough to answer without opening the file; if a hit is marked truncated, " +
        "Read exactly its start-end range (offset/limit), not the whole file. Far cheaper than " +
        "crawling files. (Until the index's vector stage finishes, results are keyword-ranked and " +
        "say so.)",
      inputSchema: {
        query: z.string().describe("What you're looking for - terms, a phrase, or a description."),
        k: z.number().int().positive().max(50).default(6).describe("Maximum hits."),
      },
    },
    async ({ query, k }) => {
      const handle = getHandle();
      if (!handle) return noIndex();
      maybeAutoSync();
      try {
        const t0 = performance.now();
        const result = await search(handle, getEmbedder(), query, k);
        return ok({ ...result, took_ms: Math.round((performance.now() - t0) * 1000) / 1000 });
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
        "Analytical questions over the whole repo in one query - counts, rankings, GROUP BY - " +
        `on table ${TABLE}(path, start_line, end_line, lang, content[, embedding]). ` +
        "Search functions are callable as table-valued relations, so one query can rank AND " +
        "aggregate: bm25_search('" + TABLE + "','content','terms', k) needs no embedding; " +
        "hybrid_search('" + TABLE + "','content','terms','embedding', {{q}}, k) and " +
        "vector_search('" + TABLE + "','embedding', {{q}}, k) take a {{name}} placeholder with an " +
        'embed map: {"q":"query text"}. The canonical move - "which files have the most code about ' +
        'X": SELECT path, SUM(end_line - start_line + 1) AS lines FROM ' +
        `bm25_search('${TABLE}','content','<terms>', 300) GROUP BY path ORDER BY lines DESC LIMIT 15. ` +
        "regexp_like(content, 'pattern') works in WHERE. Read-only, single statement.",
      inputSchema: {
        query: z
          .string()
          .describe("A single read-only SELECT or WITH statement. May use search table functions and {{name}} vector placeholders."),
        embed: z
          .record(z.string())
          .optional()
          .describe('Map of placeholder name → query text, embedded server-side. E.g. {"q":"vector indexing"} fills {{q}}.'),
      },
    },
    async ({ query, embed }) => {
      const handle = getHandle();
      if (!handle) return noIndex();
      maybeAutoSync();
      try {
        const t0 = performance.now();
        const rows = await runSql(handle, getEmbedder(), query, embed as Record<string, string> | undefined);
        return ok({ rows, took_ms: Math.round((performance.now() - t0) * 1000) / 1000 });
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
      },
    },
    async ({ full }) => {
      try {
        const runFull = async () => {
          const run = await indexRepoStaged({
            root,
            db: getDb(),
            indexDirPath: dir,
            embedder: process.env.CX_NO_EMBED ? undefined : getEmbedder(),
            caps: DEFAULT_CAPS,
          });
          void run.completion; // backfills in-process; manifest flips to "ready"
          return ok({ status: "rebuilt - keyword search live; vectors backfilling", ...run.text });
        };
        const result = exclusive(async () => {
          if (full) return runFull();
          const outcome = await syncRepo({
            root,
            db: getDb(),
            indexDirPath: dir,
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
  const manifest: Manifest | undefined = readManifest(dir);
  console.error(
    `code-context MCP server ready on stdio (root: ${root}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()})`,
  );
}
