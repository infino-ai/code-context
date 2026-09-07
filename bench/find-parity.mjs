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
/** The standing contract this script exists to hold: what a caller asks to see
 * beside a line cannot change how many lines there are. The same literal is
 * run through each of these and every answer must be identical, because each
 * adds only columns to look at. Two windows over one file differ in `end_line`
 * by construction and usually in `symbol`, so a dedupe keyed on the projected
 * tuple rather than on the line's own place diverges here and nowhere else. */
const PROJECTIONS = [
  ["path"],
  ["path", "start_line"],
  ["path", "symbol"],
  ["path", "start_line", "symbol"],
  ["path", "start_line", "end_line", "symbol"],
];
/** The limit that asks for counts without lines. The per-file counts must
 * still arrive: "which files hold this literal, and how many lines each" is
 * the question a caller asks before deciding what to read. */
const COUNTS_ONLY_LIMIT = 0;
/** Terms whose answers are known to press a distinct rule of find:
 * identifier splitting under the analyzer, punctuation, the engine's query
 * grammar, letter case, a multi-token AND, and a term common enough that one
 * line lands in two overlapping chunks. */
const DEFAULT_TERMS = ["put_if_match", "env::var", "INFINO_", "TODO", '"chunks"', "write-ahead", "compaction", "Compaction", "pub fn", "RoaringBitmap", "fn main()"];
/** Files listed per disagreeing term when the referee is consulted. */
const REFEREE_FILES = 6;

/** One side's answer, in the shape the comparison needs: the repo-wide total
 * before any limit, the distinct files, the per-file counts, the set of
 * `path:line` the side returned, and whether the limit cut that set. */
const answer = (total, files, byFile, lines, truncated = false) => ({ total, files, byFile, lines, truncated });

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

/** Whether a set of answers to one literal, differing only in what they asked
 * to see, agree on how many lines there are and which files hold them.
 * `answers` is a list of {label, answer}; the first is the reference.
 *
 * The totals and the per-file counts must match always. The returned lines are
 * compared only when neither answer was cut by the limit: a cut answer holds
 * some 500 of the matches, and which 500 is a matter of ordering among equals
 * rather than of the contract. Pure, so the contract is testable without a
 * platform. */
export function projectionInvariance(answers) {
  const [reference, ...rest] = answers;
  const broken = [];
  for (const other of rest) {
    const diff = compareFind(reference.answer, other.answer);
    const cut = reference.answer.truncated || other.answer.truncated;
    const dimensions = [];
    if (diff.total) dimensions.push(`total ${diff.total.client} against ${diff.total.platform}`);
    if (diff.files) dimensions.push(`files ${diff.files.client} against ${diff.files.platform}`);
    if (diff.byFile.length) dimensions.push(`${diff.byFile.length} per-file counts`);
    if (!cut && (diff.onlyClient.length || diff.onlyPlatform.length)) {
      dimensions.push(`${diff.onlyClient.length + diff.onlyPlatform.length} lines`);
    }
    if (dimensions.length) broken.push({ label: other.label, against: reference.label, dimensions, diff });
  }
  return { same: broken.length === 0, broken };
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
    r.truncated === true,
  );
}

/** The platform's find over the same rows in the platform table. The route
 * returns `lines` as records carrying their projected columns and the line's
 * number in the file, and `groups` as one entry per file. `line_base` is
 * always passed: the route dedupes only when it knows which column places a
 * line, and the loop's own tool supplies it, so passing it is what makes this
 * comparison the one the inner model lives with. */
async function platformFind(dbUrl, key, literal, projection = PROJECTION, limit = LIMIT) {
  const base = dbUrl.replace(/\/[^/]+$/, "");
  const db = dbUrl.slice(dbUrl.lastIndexOf("/") + 1);
  const res = await fetch(`${base}/v1/find/${db}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      table_name: TABLE,
      field_name: CONTENT_COLUMN,
      literal,
      limit,
      group_by: "path",
      line_base: "start_line",
      projection,
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
    body.truncated === true,
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
  console.log("term             client tot/files  platform tot/files  parity   projections  counts-only");
  let disagreed = 0;
  for (const literal of wanted) {
    let client;
    let platform;
    let byProjection;
    let countsOnly;
    try {
      client = await clientFind(handle, literal);
      platform = await platformFind(dbUrl, key, literal);
      byProjection = [];
      for (const projection of PROJECTIONS) {
        byProjection.push({ label: projection.join(","), answer: await platformFind(dbUrl, key, literal, projection) });
      }
      countsOnly = await platformFind(dbUrl, key, literal, PROJECTION, COUNTS_ONLY_LIMIT);
    } catch (err) {
      console.log(`${literal.padEnd(15)}  error: ${err.message}`);
      disagreed++;
      continue;
    }
    const diff = compareFind(client, platform);
    const invariance = projectionInvariance(byProjection);
    // Counts without lines: the totals and the per-file counts must still be
    // the ones the full answer gives, so a caller can decide what to read
    // before paying for any of it.
    const countsDiff = compareFind({ ...client, lines: countsOnly.lines }, countsOnly);
    const countsOk = countsDiff.total === null && countsDiff.files === null && countsDiff.byFile.length === 0;
    console.log(
      `${literal.padEnd(15)}  ${String(client.total).padStart(5)}/${String(client.files).padEnd(5)}  ${String(platform.total).padStart(5)}/${String(platform.files).padEnd(5)}  ` +
        `${(diff.same ? "same" : "DIFFERS").padEnd(8)} ${(invariance.same ? "invariant" : "VARIES").padEnd(12)} ${countsOk ? `${countsOnly.total}/${countsOnly.files}` : "WRONG"}`,
    );
    if (!invariance.same) {
      disagreed++;
      for (const b of invariance.broken) {
        console.log(`    projection ${b.label} against ${b.against}: ${b.dimensions.join("; ")}`);
      }
    }
    if (!countsOk) {
      disagreed++;
      console.log(`    counts-only (limit ${COUNTS_ONLY_LIMIT}): total ${countsOnly.total}, files ${countsOnly.files}, groups ${countsOnly.byFile.size} - the full answer says ${client.total}/${client.files}`);
    }
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
