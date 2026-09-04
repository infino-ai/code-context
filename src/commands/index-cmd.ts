// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx index [path]` - bring the index up to date. Incremental when prior
// state exists (only touched files re-chunk/re-embed), full staged build
// otherwise or with --full. --watch keeps syncing on file changes. The
// staged story prints as it happens: keyword search goes live first,
// vectors follow.
//
// With --db <url> the chunks table is loaded into a platform database
// instead: the same walk and sidecar, one pass over the network, and
// the platform-side cost (append calls, write tokens) in the printed and JSON
// stats. This command is the only path that ever drops and reloads a hosted
// table - see the indexer's hosted loader.

import { watch } from "node:fs";
import { openForIndexingAsync } from "../core/context.js";
import { indexRepoStaged, syncRepo, type IndexOptions, type IndexStats, type SyncResult } from "../core/indexer.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo } from "../core/embedder.js";
import { DEFAULT_CAPS, INDEX_DIR_NAME, embedProvider, hostedAnalyzer } from "../core/config.js";
import { bold, dim, green, yellow, fmtMs, fmtCount, progressLine, progressDone } from "../core/output.js";

export interface IndexCmdOptions {
  /** commander's `--no-embed` lands here as `embed: false`. */
  embed?: boolean;
  full?: boolean;
  watch?: boolean;
  maxFiles?: string;
  json?: boolean;
}

const PHASES: Record<string, string> = {
  scan: "scanning files",
  chunk: "chunking",
  "commit-text": "committing keyword index",
  embed: "embedding chunks",
  "commit-vectors": "committing vector index",
  load: "loading the hosted table",
};

/** Debounce window for --watch: file events settle before a sync starts. */
const WATCH_DEBOUNCE_MS = 2000;

/** Languages listed in the summary line. */
const LANGUAGES_SHOWN = 8;

export async function indexCmd(path: string | undefined, opts: IndexCmdOptions): Promise<void> {
  const target = await openForIndexingAsync(path);
  const { root, dir, db, hosted } = target;
  // Null under --embed-provider platform (the platform embeds); undefined
  // with --no-embed (no vectors at all). The indexer's `embedProvider` tells
  // those two apart for a hosted load, so it is only set when vectors are on.
  const embedder = opts.embed === false ? undefined : createEmbedder();
  const provider = hosted && opts.embed !== false ? embedProvider() : undefined;
  const analyzer = hosted ? hostedAnalyzer() : undefined;
  const caps = {
    ...DEFAULT_CAPS,
    ...(opts.maxFiles ? { maxFiles: Number(opts.maxFiles) } : {}),
  };

  let phase = "scan";
  const baseOpts: IndexOptions = {
    root,
    db,
    hosted,
    indexDirPath: dir,
    embedder,
    embedProvider: provider,
    analyzer,
    caps,
    onPhase: (p) => {
      phase = p;
      if (!opts.json) progressLine(dim(`${PHASES[p]}…`));
    },
    onProgress: (done, total) => {
      if (!opts.json && total > 0) {
        progressLine(dim(`${PHASES[phase]}… ${Math.round((100 * done) / total)}% (${fmtCount(done)}/${fmtCount(total)})`));
      }
    },
  };

  if (!opts.json) {
    console.log(`${bold("code-context")} - indexing ${root}`);
    const embedding = opts.embed === false ? "off (--no-embed)" : embedderInfo();
    console.log(
      hosted
        ? dim(`table: ${target.target} · sidecar: ${dir} · analyzer: ${analyzer} · embedder: ${embedding}`)
        : dim(`index: ${dir} · embedder: ${embedding}`),
    );
  }

  const once = async (): Promise<void> => {
    if (!opts.full) {
      const outcome = await syncRepo(baseOpts);
      if (outcome.action !== "rebuild-required") {
        progressDone();
        printSync(outcome, opts.json);
        return;
      }
      if (!opts.json && outcome.reason !== "no prior index state") {
        console.log(dim(`full rebuild: ${outcome.reason}`));
      }
    }
    await full();
  };

  const full = async (): Promise<void> => {
    // Full builds embed in a child process (bulk arenas leave with it);
    // sync keeps the in-process embedder for its small warm batches.
    const buildEmb = opts.embed === false ? undefined : createIndexingEmbedder();
    const run = await indexRepoStaged({ ...baseOpts, embedder: buildEmb });
    if (!opts.json) {
      progressDone();
      const t = run.text;
      // A hosted load is one pass, so `text` is already the finished table;
      // a local build reports keyword-live here and vectors below.
      console.log(
        green("✓") +
          (hosted
            ? ` loaded ${fmtCount(t.chunks)} chunks from ${fmtCount(t.files)} files into ${target.target} in ${fmtMs(t.indexMs)}${hostedCost(t)}`
            : ` keyword search live - ${fmtCount(t.chunks)} chunks from ${fmtCount(t.files)} files in ${fmtMs(t.indexMs)}`),
      );
      if (t.truncatedFiles) {
        console.log(yellow(`! ${fmtCount(t.truncatedFiles)} files over the ${fmtCount(caps.maxFiles)}-file cap were skipped (raise with --max-files)`));
      }
    }
    const final = await run.completion;
    await buildEmb?.dispose?.()?.catch(() => undefined);
    if (opts.json) {
      console.log(JSON.stringify(final, null, 2));
      return;
    }
    progressDone();
    if (final.vectors === "ready") {
      console.log(
        green("✓") +
          (final.embedMs === undefined
            ? " semantic search ready - the platform embeds server-side"
            : ` semantic search ready - vectors built in ${fmtMs(final.embedMs)}`),
      );
    } else if (final.embedError) {
      console.log(yellow(`! vector stage failed (${final.embedError}) - keyword search stays live; re-run \`cx index\` to retry`));
    }
    const langs = Object.entries(final.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LANGUAGES_SHOWN)
      .map(([lang, n]) => `${lang} ${fmtCount(n)}`)
      .join(" · ");
    if (langs) console.log(dim(`chunks by language: ${langs}`));
  };

  await once();

  if (!opts.watch) return;

  // --- watch mode: debounce FS events into incremental syncs -----------------
  console.log(dim("watching for changes (ctrl-c to stop)…"));
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return kick(); // a sync is active - re-debounce
      running = true;
      try {
        const outcome = await syncRepo(baseOpts);
        progressDone();
        if (outcome.action === "synced") printSync(outcome, opts.json);
      } catch (err) {
        console.error(yellow(`sync failed: ${(err as Error).message}`));
      } finally {
        running = false;
      }
    }, WATCH_DEBOUNCE_MS);
  };
  watch(root, { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "");
    if (name.startsWith(INDEX_DIR_NAME) || name.startsWith(".git")) return;
    kick();
  });
  await new Promise(() => {}); // run until interrupted
}

/** ` (N appends, T write tokens)` for a hosted result, empty for a local one.
 * Tokens print only when the platform metered them. */
function hostedCost(stats: { hosted?: IndexStats["hosted"] }): string {
  const h = stats.hosted;
  if (!h) return "";
  const appends = `${fmtCount(h.appendCalls)} append${h.appendCalls === 1 ? "" : "s"}`;
  return dim(` (${appends}${h.writeTokens !== undefined ? `, ${h.writeTokens} write tokens` : ""})`);
}

function printSync(outcome: SyncResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (outcome.action === "noop") {
    console.log(green("✓") + ` index up to date - ${fmtCount(outcome.chunks)} chunks from ${fmtCount(outcome.files)} files ${dim(`(checked in ${fmtMs(outcome.tookMs)})`)}`);
    return;
  }
  const parts = [
    outcome.filesAdded ? `${fmtCount(outcome.filesAdded)} added` : "",
    outcome.filesChanged ? `${fmtCount(outcome.filesChanged)} changed` : "",
    outcome.filesDeleted ? `${fmtCount(outcome.filesDeleted)} deleted` : "",
  ].filter(Boolean);
  console.log(
    green("✓") +
      ` synced in ${fmtMs(outcome.tookMs)} - ${parts.join(", ")} ` +
      dim(`(+${fmtCount(outcome.chunksAdded)}/-${fmtCount(outcome.chunksRemoved)} chunks, ${fmtCount(outcome.chunks)} total${outcome.vectors === "ready" ? ", vectors current" : ""})`) +
      hostedCost(outcome),
  );
}
