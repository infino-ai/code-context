// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx index [path]` - bring the index up to date. Incremental when prior
// state exists (only touched files re-chunk/re-embed), full staged build
// otherwise or with --full. --watch keeps syncing on file changes. The
// staged story prints as it happens: keyword search goes live first,
// vectors follow.

import { watch } from "node:fs";
import { openForIndexing } from "../core/context.js";
import { indexRepoStaged, syncRepo, type IndexOptions, type SyncResult } from "../core/indexer.js";
import { createEmbedder, embedderInfo } from "../core/embedder.js";
import { DEFAULT_CAPS, INDEX_DIR_NAME } from "../core/config.js";
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
};

export async function indexCmd(path: string | undefined, opts: IndexCmdOptions): Promise<void> {
  const { root, dir, db } = openForIndexing(path);
  const embedder = opts.embed === false ? undefined : createEmbedder();
  const caps = {
    ...DEFAULT_CAPS,
    ...(opts.maxFiles ? { maxFiles: Number(opts.maxFiles) } : {}),
  };

  let phase = "scan";
  const baseOpts: IndexOptions = {
    root,
    db,
    indexDirPath: dir,
    embedder,
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
    console.log(dim(`index: ${dir} · embedder: ${embedder ? embedderInfo() : "off (--no-embed)"}`));
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
    const run = await indexRepoStaged(baseOpts);
    if (!opts.json) {
      progressDone();
      const t = run.text;
      console.log(
        green("✓") +
          ` keyword search live - ${fmtCount(t.chunks)} chunks from ${fmtCount(t.files)} files in ${fmtMs(t.indexMs)}`,
      );
      if (t.truncatedFiles) {
        console.log(yellow(`! ${fmtCount(t.truncatedFiles)} files over the ${fmtCount(caps.maxFiles)}-file cap were skipped (raise with --max-files)`));
      }
    }
    const final = await run.completion;
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
    const langs = Object.entries(final.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
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
    }, 2000);
  };
  watch(root, { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "");
    if (name.startsWith(INDEX_DIR_NAME) || name.startsWith(".git")) return;
    kick();
  });
  await new Promise(() => {}); // run until interrupted
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
      dim(`(+${fmtCount(outcome.chunksAdded)}/-${fmtCount(outcome.chunksRemoved)} chunks, ${fmtCount(outcome.chunks)} total${outcome.vectors === "ready" ? ", vectors current" : ""})`),
  );
}
