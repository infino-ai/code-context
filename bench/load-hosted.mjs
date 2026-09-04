// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// One-shot index build for a bench repo, timed and recorded, so the cost of
// getting the index in place is a number in the report next to the query
// numbers. The hosted side runs the server build's own CLI against the
// platform database (`cx index --db <url>`); the local side runs the same
// CLI against .infino/ for the comparison row. Either way the CLI's --json
// stats land on the record verbatim.
//
// Usage: node load-hosted.mjs [repoPath] [side=hosted]
//   repoPath  the repo to index (or $CX_BENCH_REPO)
//   side      hosted (default; needs CX_DB_URL + INFINO_API_KEY) or local
// Appends to bench/.work/results/index-build.jsonl:
//   { side, repo, dbHost, cli, build, wallMs, exitCode, error, ts, ...<cx index --json> }
// dbHost is the host of CX_DB_URL only; the key is passed to the child by
// environment and never written anywhere.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CX, BUILD, record } from "./lanes.mjs";

export const INDEX_BUILD_FILE = "index-build.jsonl";
/** How much of the CLI's stderr to keep on a failed record - enough for the
 * error line, not the progress spam. */
const STDERR_TAIL_CHARS = 500;
/** A build of a large repo embeds every chunk; give it an hour before spawn
 * gives up, so a slow embedder shows up as a number and not a timeout. */
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
/** Room for the CLI's stdout/stderr (progress lines plus the stats object);
 * spawnSync kills the child when its output exceeds this. */
const OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;

/** The command a side runs. The `--db` flag is the hosted-mode entry the CLI
 * grows for this: `cx index --db https://host/<database> <repo>` indexes the
 * repo into that platform database instead of .infino/. */
export function indexArgs({ cli, repo, side, dbUrl }) {
  const args = [cli, "index", "--json"];
  if (side === "hosted") args.push("--db", dbUrl);
  args.push(repo);
  return args;
}

/** Run the build and shape the record. `spawn` is spawnSync-compatible and
 * injectable so the shaping is testable without a CLI. When the build exits
 * non-zero the JSON stats are absent and `error` carries the stderr tail -
 * a CLI that does not know `--db` yet fails here with commander's
 * "unknown option" message, which the record keeps verbatim rather than
 * pretending a hosted build happened. */
export function runIndexBuild({ cli, repo, side, dbUrl, env = process.env, spawn = spawnSync, now = () => performance.now() }) {
  const args = indexArgs({ cli, repo, side, dbUrl });
  const t0 = now();
  const res = spawn("node", args, { encoding: "utf8", env, timeout: BUILD_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES });
  const wallMs = Math.round(now() - t0);
  let stats = null;
  if (res.status === 0) {
    // --json prints one object (the full-build stats, or the sync outcome);
    // anything before it on stdout is progress the CLI did not silence.
    const text = res.stdout ?? "";
    const start = text.indexOf("{");
    try {
      stats = start >= 0 ? JSON.parse(text.slice(start)) : null;
    } catch {
      stats = null;
    }
  }
  const stderrTail = (res.stderr ?? "").trim().slice(-STDERR_TAIL_CHARS);
  const error = res.error ? String(res.error.message) : res.status === 0 ? null : stderrTail || `exit ${res.status}`;
  return { wallMs, exitCode: res.status ?? null, error, stats };
}

/** Host of the database URL, or null; never the key, never the path. */
export const hostOf = (url) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

async function main() {
  const [repoArg, sideArg = "hosted"] = process.argv.slice(2);
  const repoPath = repoArg ?? process.env.CX_BENCH_REPO;
  if (!repoPath || !["hosted", "local"].includes(sideArg)) {
    console.error("usage: node load-hosted.mjs [repoPath] [side=hosted|local]   (or set CX_BENCH_REPO)");
    process.exit(1);
  }
  const { CX_DB_URL, INFINO_API_KEY } = process.env;
  if (sideArg === "hosted" && (!CX_DB_URL || !INFINO_API_KEY)) {
    console.error("the hosted side needs CX_DB_URL (https://host/<database>) and INFINO_API_KEY in the environment");
    process.exit(1);
  }
  const repo = resolve(repoPath);
  const cmd = indexArgs({ cli: CX, repo, side: sideArg, dbUrl: CX_DB_URL });
  console.log(`node ${cmd.join(" ")}`);
  const r = runIndexBuild({ cli: CX, repo, side: sideArg, dbUrl: CX_DB_URL });
  const row = {
    ...(r.stats ?? {}),
    side: sideArg,
    repo,
    dbHost: sideArg === "hosted" ? hostOf(CX_DB_URL) : null,
    cli: CX,
    build: BUILD,
    wallMs: r.wallMs,
    exitCode: r.exitCode,
    error: r.error,
    ts: new Date().toISOString(),
  };
  record(INDEX_BUILD_FILE, row);
  if (r.error) {
    console.error(`${sideArg} build failed after ${r.wallMs}ms: ${r.error}`);
    process.exit(1);
  }
  const s = r.stats ?? {};
  console.log(
    `${sideArg} build of ${repo.split("/").pop()}: ${r.wallMs}ms wall` +
      (s.files !== undefined ? `, ${s.files} files, ${s.chunks} chunks` : "") +
      (s.vectors !== undefined ? `, vectors ${s.vectors}` : "") +
      ` -> .work/results/${INDEX_BUILD_FILE}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
