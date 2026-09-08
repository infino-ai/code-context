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
  /** commander's `--no-ignore` lands here as `ignore: false`. */
  ignore?: boolean;
  /** `--include <glob>`, repeatable: re-admit gitignored paths. */
  include?: string[];
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

/** The file cap's warning, worded in one place because both a build and a sync
 * have to say it and it has to say the same thing. A count alone reads as a
 * statistic; what the reader needs is that the index is now incomplete, that
 * searches over it will be too, and the one number to change. Printed on every
 * build and every sync while the tree is over the cap - it is not a
 * first-run notice, because the run that adds the file that crosses the cap
 * looks like any other sync. */
export function capWarning(truncatedFiles: number, maxFiles: number): string {
  // The suggested cap is the whole tree as it stands, not a round number: it
  // is the one value that indexes everything, and it is pasteable, which is
  // why it goes in unformatted (`--max-files 623,451` parses as NaN).
  const wholeTree = maxFiles + truncatedFiles;
  return [
    yellow(`! ${fmtCount(truncatedFiles)} files were NOT indexed - the tree is over the ${fmtCount(maxFiles)}-file cap`),
    yellow("  every search over this index is incomplete: a missing match is not proof it is absent"),
    yellow(`  raise the cap and re-index:  cx index --max-files ${wholeTree}   (or CX_MAX_FILES=${wholeTree})`),
  ].join("\n");
}

/** Entries listed by name in the ignore warning before it summarises. */
const IGNORED_DIRS_SHOWN = 6;

/** Siblings under one parent past which the warning names the parent and a
 * count instead of every child. Two is not a crowd; a run of them is. */
const COLLAPSE_SIBLINGS_AT = 3;

/** Collapse runs of ignored siblings into their parent.
 *
 * Measured need: a real workspace produced ~750 ignored directories, almost
 * all of them leftover test temp dirs like
 * `wt-write-tokens/optimizer/tmp/.tmpzWhPmW/acme/logs`, among which the two
 * that mattered - a gitignored sibling repository and the plans checkout -
 * were indistinguishable. A warning nobody can read is a warning that does
 * not work, which was the whole complaint it exists to answer. */
export function collapseIgnored(dirs: string[]): string[] {
  // Every proper ancestor of every entry, with how many entries it covers.
  const covered = new Map<string, number>();
  for (const dir of dirs) {
    const parts = dir.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      covered.set(ancestor, (covered.get(ancestor) ?? 0) + 1);
    }
  }

  // The DEEPEST ancestor covering enough entries, per entry. Deepest, not
  // shallowest, and that is the difference between a useful line and a useless
  // one: the real flood is `<worktree>/optimizer/tmp/.tmpXXXX/acme/logs`, where
  // every entry has its own immediate parent, so grouping by parent collapses
  // nothing - while collapsing to the shallowest ancestor would report
  // `<worktree>/` and hide which part of it was skipped. The deepest ancestor
  // that covers the group lands on `<worktree>/optimizer/tmp/`, which says
  // where they are, and leaves an unrelated sibling elsewhere under that
  // worktree listed on its own.
  const chosenFor = new Map<string, string>();
  const loose: string[] = [];
  for (const dir of dirs) {
    const parts = dir.split("/");
    let chosen: string | undefined;
    for (let i = parts.length - 1; i >= 1; i--) {
      const ancestor = parts.slice(0, i).join("/");
      if ((covered.get(ancestor) ?? 0) >= COLLAPSE_SIBLINGS_AT) {
        chosen = ancestor;
        break;
      }
    }
    if (chosen === undefined) loose.push(dir);
    else chosenFor.set(dir, chosen);
  }

  // Dissolve a group that turned out not to be one. An ancestor can cover
  // enough entries in total while a particular entry is the only one that
  // landed on it - a lone `wt-a/src/generated` beside forty `wt-a/optimizer/
  // tmp/...` entries picks `wt-a`, because nothing deeper covers it, and
  // reporting `wt-a/ (1 directory)` would hide the one path a reader needed.
  // A group is a group at the threshold or not at all.
  const members = new Map<string, string[]>();
  for (const [dir, ancestor] of chosenFor) {
    members.set(ancestor, [...(members.get(ancestor) ?? []), dir]);
  }
  const out = [...loose];
  for (const [ancestor, group] of members) {
    if (group.length >= COLLAPSE_SIBLINGS_AT) {
      out.push(`${ancestor}/ (${fmtCount(group.length)} directories)`);
    } else {
      out.push(...group);
    }
  }
  // Shallowest first: a top-level sibling repository is the entry worth
  // reading, and a deep cluster of temp directories is not.
  return out.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
}

/** What a failed parse costs, said out loud. A file chunked by fixed windows
 * instead of its syntax has boundaries that fall mid-function and carries no
 * symbol, so `find --defines`, the ranked searches and the embed header are
 * all worse over it - and the tree-sitter runtime's own account of the failure
 * is a bare `Aborted()` on stderr with no path and no count. The breaker
 * arm matters more than the count: it takes every later file down the same
 * path, so the degradation is not confined to the files that actually failed. */
export function parseWarning(parseFailures: number, breakerTripped: boolean): string {
  const lines = [
    yellow(
      `! ${fmtCount(parseFailures)} ${parseFailures === 1 ? "file" : "files"} could not be parsed and ` +
        `${parseFailures === 1 ? "was" : "were"} chunked as fixed line windows instead of at syntactic boundaries`,
    ),
    yellow("  those chunks carry no symbol and their boundaries fall wherever the window ends"),
  ];
  if (breakerTripped) {
    lines.push(
      yellow("  and the parser was switched off part-way: EVERY file after that point took the same path,"),
      yellow("  not only the ones that failed - re-index to get syntactic chunking back over them"),
    );
  }
  return lines.join("\n");
}

/** The `.gitignore` warning, for the same reason `capWarning` exists: a walk
 * that silently dropped a subtree makes every search over the index quietly
 * wrong, and the reader cannot tell. `.gitignore` means "do not
 * version-control" and not "do not search", so a gitignored sibling repo, a
 * generated docs tree or a vendored dependency somebody greps all disappear
 * from the index with nothing said. Printed on every build and every sync
 * while anything is being skipped, because a `.gitignore` edit that newly
 * hides a tree looks like any other sync. */
export function ignoreWarning(ignoredDirs: string[]): string {
  const collapsed = collapseIgnored(ignoredDirs);
  const shown = collapsed.slice(0, IGNORED_DIRS_SHOWN);
  const rest = collapsed.length - shown.length;
  const list = shown.join(", ") + (rest > 0 ? `, and ${fmtCount(rest)} more` : "");
  return [
    yellow(`! ${fmtCount(ignoredDirs.length)} ${ignoredDirs.length === 1 ? "directory was" : "directories were"} NOT indexed - .gitignore excludes ${ignoredDirs.length === 1 ? "it" : "them"}`),
    yellow(`  ${list}`),
    yellow("  nothing inside them is searchable: a missing match is not proof it is absent"),
    yellow("  index them too and re-index:  cx index --no-ignore   (or CX_NO_IGNORE=1)"),
  ].join("\n");
}

/** Whether this run honours `.gitignore`: `--no-ignore` decides when given,
 * otherwise `CX_NO_IGNORE` (set to anything, like `CX_NO_EMBED`).
 *
 * The environment variable is not a convenience. `cx mcp` serves and re-syncs
 * the same index and takes no such flag, so without it a tree indexed under
 * `--no-ignore` would be diffed away again by the server's next auto-sync -
 * the files read as deleted, because the walk stopped being able to see them. */
function respectGitignore(opts: IndexCmdOptions): boolean {
  if (opts.ignore === false) return false;
  return !process.env.CX_NO_IGNORE;
}

/** Patterns that re-admit gitignored paths: `--include`, repeatable, else
 * `CX_INCLUDE` as a comma-separated list.
 *
 * The env var exists for the same reason `CX_NO_IGNORE` does and not for
 * convenience: the server's auto-sync re-walks with whatever it can see, so a
 * tree admitted by a flag the server never receives is deleted again on the
 * next sync. `.cxignore` needs no equivalent - it is a file, so both the
 * command and the server read it. */
function includePatterns(opts: IndexCmdOptions): string[] {
  if (opts.include && opts.include.length > 0) return opts.include;
  const env = process.env.CX_INCLUDE ?? "";
  return env
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

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
    respectGitignore: respectGitignore(opts),
    include: includePatterns(opts),
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
        printSync(outcome, caps.maxFiles, opts.json);
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
    // Last, so it is what is still on screen when the run ends. Everything
    // above it is a ✓, and the cap is the part of this index that is not one.
    if (final.truncatedFiles) console.log(capWarning(final.truncatedFiles, final.maxFiles));
    if (final.ignoredDirs?.length) console.log(ignoreWarning(final.ignoredDirs));
    if (final.parseFailures) console.log(parseWarning(final.parseFailures, final.parseBreakerTripped ?? false));
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
        if (outcome.action === "synced") printSync(outcome, caps.maxFiles, opts.json);
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

function printSync(outcome: SyncResult, maxFiles: number, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (outcome.action === "noop") {
    console.log(green("✓") + ` index up to date - ${fmtCount(outcome.chunks)} chunks from ${fmtCount(outcome.files)} files ${dim(`(checked in ${fmtMs(outcome.tookMs)})`)}`);
  } else {
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
  // Last, for the same reason as on a build: a sync's ✓ reads as an index that
  // is up to date, and while the tree is over the cap it is up to date and
  // incomplete at the same time.
  if (outcome.truncatedFiles) console.log(capWarning(outcome.truncatedFiles, maxFiles));
  if (outcome.ignoredDirs?.length) console.log(ignoreWarning(outcome.ignoredDirs));
}
