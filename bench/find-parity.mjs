// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Check that the two find implementations answer identically over the same
// chunks. `find` exists twice: here in the client, over the local index, which
// is what the coding agent calls; and on the platform, as the retrieval loop's
// own tool over the same rows in the platform table. Both answer one question
// - every line containing an exact string - so any difference in the total, in
// the files, or in which lines come back is a bug in one of them, and a count
// an agent cannot reproduce is worse than no count.
//
// The working tree is the referee: for a term that disagrees, the matching
// lines are counted straight from the files, so "which side is right" is
// settled by the repository rather than by either tool.
//
// A real platform and a key are needed, so this is a script rather than a unit
// test; `compareFind` and `countInFile` are exported and tested without either.
//
// Usage: node find-parity.mjs <repoDir> [term ...]
//   indexDir  $CX_INDEX_DIR, else <repoDir>/.infino
//   platform  $CX_BENCH_DB_URL and $CX_BENCH_KEY_FILE, as the hosted lanes
//   terms     default: the set below, each pressing one of find's rules
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openIndex } from "../dist/core/context.js";
import { find } from "../dist/core/searcher.js";
import { INDEX_DIR_NAME, TABLE } from "../dist/core/config.js";
import { BENCH_DB_URL, BENCH_KEY_FILE } from "./lanes.mjs";

/** The indexed text column. Named here rather than imported because the
 * client's own copy is module-private to the search and index paths; both
 * sides of this comparison read the same column of the same table. */
const CONTENT_COLUMN = "content";

/** The limit both sides are asked for: the client's own ceiling, so neither
 * cuts before the other and the returned lines are comparable up to it. */
const LIMIT = 500;
/** The columns the platform's find is asked to project. The client's retrieval
 * tools ask for these, so this is the projection the loop's find actually runs
 * with - and a dedupe keyed on the projected tuple rather than on (path, line)
 * shows up here and not under a bare `path`. */
const PROJECTION = ["path", "start_line", "end_line", "symbol"];
/** Terms whose answers are known to press a distinct rule of find:
 * identifier splitting under the analyzer, punctuation, the engine's query
 * grammar, letter case, a multi-token AND, and a term common enough that one
 * line lands in two overlapping chunks. */
const DEFAULT_TERMS = ["put_if_match", "env::var", "INFINO_", "TODO", '"chunks"', "write-ahead", "compaction", "Compaction", "pub fn", "RoaringBitmap", "fn main()"];
/** Files listed per disagreeing term when the referee is consulted. */
const REFEREE_FILES = 6;

/** One side's answer, in the shape the comparison needs: the repo-wide total
 * before any limit, the distinct files, the per-file counts, and the set of
 * `path:line` the side returned. */
const answer = (total, files, byFile, lines) => ({ total, files, byFile, lines });

/** What differs between two find answers: the totals, the file counts, the
 * per-file counts, and the lines only one side returned. Pure, so the
 * comparison is testable without a platform. */
export function compareFind(client, platform) {
  const onlyClient = [...client.lines].filter((k) => !platform.lines.has(k)).sort();
  const onlyPlatform = [...platform.lines].filter((k) => !client.lines.has(k)).sort();
  const byFile = [];
  for (const [path, count] of client.byFile) {
    const theirs = platform.byFile.get(path);
    if (theirs !== count) byFile.push({ path, client: count, platform: theirs ?? null });
  }
  for (const [path, count] of platform.byFile) {
    if (!client.byFile.has(path)) byFile.push({ path, client: null, platform: count });
  }
  byFile.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    total: client.total === platform.total ? null : { client: client.total, platform: platform.total },
    files: client.files === platform.files ? null : { client: client.files, platform: platform.files },
    byFile,
    onlyClient,
    onlyPlatform,
    same: client.total === platform.total && client.files === platform.files && byFile.length === 0 && onlyClient.length === 0 && onlyPlatform.length === 0,
  };
}

/** The 1-based numbers of the lines of `text` that contain `literal`: the
 * referee's count, case-sensitive like find's default. */
export function countInFile(text, literal) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes(literal)) out.push(i + 1);
  });
  return out;
}

/** The client's find over the local index. */
async function clientFind(handle, literal) {
  const r = await find(handle, literal, { limit: LIMIT });
  return answer(
    r.total,
    r.files,
    new Map(r.byFile.map((f) => [f.path, f.count])),
    new Set(r.matches.map((m) => `${m.path}:${m.line}`)),
  );
}

/** The platform's find over the same rows in the platform table. The route
 * returns `lines` as records carrying their projected columns and the line's
 * number in the file, and `groups` as one entry per file. */
async function platformFind(dbUrl, key, literal) {
  const base = dbUrl.replace(/\/[^/]+$/, "");
  const db = dbUrl.slice(dbUrl.lastIndexOf("/") + 1);
  const res = await fetch(`${base}/v1/find/${db}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      table_name: TABLE,
      field_name: CONTENT_COLUMN,
      literal,
      limit: LIMIT,
      group_by: "path",
      line_base: "start_line",
      projection: PROJECTION,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`platform find ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  const body = JSON.parse(text);
  const lines = body.lines ?? [];
  return answer(
    body.total,
    body.groups_total,
    new Map((body.groups ?? []).map((g) => [g.value, g.lines])),
    new Set(lines.map((r) => `${r.columns.path}:${r.file_line}`)),
  );
}

async function main(argv) {
  const [repoArg, ...terms] = argv;
  if (!repoArg) {
    console.error("usage: node find-parity.mjs <repoDir> [term ...]");
    return 1;
  }
  const repo = resolve(repoArg);
  const indexDir = process.env.CX_INDEX_DIR ?? join(repo, INDEX_DIR_NAME);
  const dbUrl = process.env[BENCH_DB_URL];
  const keyFile = process.env[BENCH_KEY_FILE];
  if (!dbUrl || !keyFile) {
    console.error(`find-parity needs ${BENCH_DB_URL} and ${BENCH_KEY_FILE}: the platform copy is the other side of the comparison`);
    return 1;
  }
  const key = readFileSync(keyFile, "utf8").trim();
  const handle = openIndex(repo);
  const wanted = terms.length ? terms : DEFAULT_TERMS;

  console.log(`find parity: ${indexDir} against ${dbUrl.replace(/\/\/.*@/, "//")}, projection ${PROJECTION.join(",")}, limit ${LIMIT}`);
  console.log("term             client tot/files  platform tot/files  status");
  let disagreed = 0;
  for (const literal of wanted) {
    let client;
    let platform;
    try {
      client = await clientFind(handle, literal);
      platform = await platformFind(dbUrl, key, literal);
    } catch (err) {
      console.log(`${literal.padEnd(15)}  error: ${err.message}`);
      disagreed++;
      continue;
    }
    const diff = compareFind(client, platform);
    console.log(
      `${literal.padEnd(15)}  ${String(client.total).padStart(5)}/${String(client.files).padEnd(5)}  ${String(platform.total).padStart(5)}/${String(platform.files).padEnd(5)}  ${diff.same ? "same" : "DIFFERS"}`,
    );
    if (diff.same) continue;
    disagreed++;
    if (diff.total) console.log(`    total: client ${diff.total.client}, platform ${diff.total.platform}`);
    if (diff.onlyClient.length) console.log(`    lines only the client returned: ${diff.onlyClient.slice(0, 8).join("  ")}${diff.onlyClient.length > 8 ? ` (+${diff.onlyClient.length - 8})` : ""}`);
    if (diff.onlyPlatform.length) console.log(`    lines only the platform returned: ${diff.onlyPlatform.slice(0, 8).join("  ")}${diff.onlyPlatform.length > 8 ? ` (+${diff.onlyPlatform.length - 8})` : ""}`);
    // The referee: for each file whose count differs, what the file itself says.
    for (const d of diff.byFile.slice(0, REFEREE_FILES)) {
      let truth = "unreadable";
      try {
        truth = String(countInFile(readFileSync(join(repo, d.path), "utf8"), literal).length);
      } catch {
        // A path the index holds and the working tree no longer does: report it as such.
      }
      console.log(`    ${d.path}: file ${truth}, client ${d.client ?? "-"}, platform ${d.platform ?? "-"}`);
    }
    if (diff.byFile.length > REFEREE_FILES) console.log(`    (+${diff.byFile.length - REFEREE_FILES} more files differ)`);
  }
  console.log(`\n${wanted.length - disagreed} of ${wanted.length} terms agree`);
  return disagreed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
