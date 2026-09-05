// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx index [path]` - bring the index up to date. Incremental when prior
// state exists (only touched files re-chunk/re-embed), full staged build
// otherwise or with --full. --watch keeps syncing on file changes. The
// staged story prints as it happens: keyword search goes live first,
// vectors follow.
//
// With --db <url> the same build or sync also writes the repository's chunks
// table on that platform database - the local index and the platform table
// are one index in two places - and the platform-side cost (append calls,
// write tokens) joins the printed and JSON stats.

import { watch } from "node:fs";
import { openForIndexing, platformLabel } from "../core/context.js";
import { indexRepoStaged, syncRepo, type IndexOptions, type IndexStats, type SyncResult } from "../core/indexer.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, platformEmbedderInfo } from "../core/embedder.js";
import { DEFAULT_CAPS, INDEX_DIR_NAME, embedProvider, hostedAnalyzer, type EmbedProvider } from "../core/config.js";
import { HOSTED_DEFAULT_ANALYZER, analyzerOf } from "../core/analyzer.js";
import { readPlatformManifest } from "../core/manifest.js";
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
  load: "loading the platform table",
};

/** Debounce window for --watch: file events settle before a sync starts. */
const WATCH_DEBOUNCE_MS = 2000;

/** Languages listed in the summary line. */
const LANGUAGES_SHOWN = 8;

export async function indexCmd(path: string | undefined, opts: IndexCmdOptions): Promise<void> {
  const target = openForIndexing(path);
  const { root, dir, db, hosted } = target;
  const embedder = opts.embed === false ? undefined : createEmbedder();
  // --no-embed means no vectors anywhere: with no local embedder, `local`
  // gives the platform table no embedding column either. Otherwise the
  // platform table's column is filled as --embed-provider says.
  const provider: EmbedProvider = opts.embed === false ? "local" : embedProvider();
  // The analyzer only when --analyzer named one: otherwise a build keeps the
  // table's own (the recorded one, or the default for a first load), and a
  // sync asks for nothing.
  const analyzer = hostedAnalyzer();
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
    console.log(dim(`index: ${dir} · embedder: ${embedding}`));
    if (hosted) {
      const platformEmbedding = opts.embed === false ? "off (--no-embed)" : platformEmbedderInfo();
      const recorded = readPlatformManifest(dir);
      const shown = analyzer ?? (recorded ? analyzerOf(recorded) : HOSTED_DEFAULT_ANALYZER);
      console.log(dim(`platform table: ${platformLabel(hosted)} · analyzer: ${shown} · embedder: ${platformEmbedding}`));
    }
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
      console.log(green("✓") + ` keyword search live - ${fmtCount(t.chunks)} chunks from ${fmtCount(t.files)} files in ${fmtMs(t.indexMs)}`);
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
      console.log(green("✓") + ` semantic search ready - vectors built in ${fmtMs(final.embedMs ?? 0)}`);
    } else if (final.embedError) {
      console.log(yellow(`! vector stage failed (${final.embedError}) - keyword search stays live; re-run \`cx index\` to retry`));
    }
    if (hosted) {
      if (final.hosted) {
        console.log(
          green("✓") +
            ` platform table loaded - ${fmtCount(final.chunks)} chunks into ${platformLabel(hosted)} in ${fmtMs(final.hosted.loadWallMs)}${hostedCost(final)}`,
        );
      } else if (final.hostedError) {
        console.log(yellow(`! platform load failed (${final.hostedError}) - the local index is complete; re-run \`cx index --full\` to retry`));
      }
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

/** ` (N appends, T write tokens)` when the platform table was written, empty
 * otherwise. Tokens print only when the platform metered them. */
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
      dim(`(+${fmtCount(outcome.chunksAdded)}/-${fmtCount(outcome.chunksRemoved)} chunks, ${fmtCount(outcome.chunks)} total${outcome.vectors === "ready" ? ", vectors current" : ""}${outcome.hosted ? ", platform table too" : ""})`) +
      hostedCost(outcome),
  );
}
