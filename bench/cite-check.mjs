// Mechanical citation check over the answers in a results file: every
// `path:line` or `path:start-end` an answer cites must name a file in the repo
// with the range inside it, and an identifier written beside the citation
// (in backticks, within the same sentence) must appear within a few lines of
// the cited range. Reports per build so variants can be compared.
//
// Usage: node cite-check.mjs <repoDir> [results=questions.jsonl] [builds]
//   builds  comma-separated build labels, or `since..until` windows for rows
//           without a label; default: every build in the file (plus `V0` for
//           unlabelled rows when CX_V0_WINDOW=since..until is set)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RESULTS } from "./lanes.mjs";

const [repoArg, resultsArg, buildsArg] = process.argv.slice(2);
if (!repoArg) {
  console.error("usage: node cite-check.mjs <repoDir> [results.jsonl] [builds]");
  process.exit(1);
}
const repoDir = resolve(repoArg);
const resultsFile = resultsArg ? resolve(resultsArg) : join(RESULTS, "questions.jsonl");

/** How far from the cited range an identifier may sit and still count as
 * anchored: a citation to a signature line often names the body's symbol. */
const ANCHOR_SLACK_LINES = 5;
/** Characters of answer text before a citation searched for its identifier. */
const CITATION_CONTEXT_CHARS = 160;

const CITATION = /(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,6}):(\d+)(?:\s*[-–]\s*(\d+))?/g;
const IDENTIFIER = /`([A-Za-z_][\w:.#]*[\w#])`/g;

const rows = readFileSync(resultsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.lane === "combo" && !r.error && r.answer);

function selector(spec) {
  const m = /^(\S+)\.\.(\S+)$/.exec(spec);
  if (m) return (r) => !r.build && r.ts >= m[1] && r.ts < m[2];
  return (r) => r.build === spec;
}
let builds;
if (buildsArg) builds = buildsArg.split(",");
else {
  builds = [...new Set(rows.map((r) => r.build).filter(Boolean))];
  if (process.env.CX_V0_WINDOW) builds.unshift(process.env.CX_V0_WINDOW);
}

const fileLines = new Map();
function linesOf(path) {
  if (!fileLines.has(path)) {
    const full = join(repoDir, path);
    fileLines.set(path, existsSync(full) ? readFileSync(full, "utf8").split("\n") : null);
  }
  return fileLines.get(path);
}

/** Every file in the repo by basename, for citations written as a bare file
 * name (`mod.rs:842` in a table whose full path stands nearby). Built once. */
const SKIP_DIRS = new Set([".git", ".infino", "target", "node_modules"]);
const byBasename = new Map();
(function walk(rel) {
  for (const entry of readdirSync(join(repoDir, rel), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel ? `${rel}/${entry.name}` : entry.name);
    } else {
      const list = byBasename.get(entry.name) ?? [];
      list.push(rel ? `${rel}/${entry.name}` : entry.name);
      byBasename.set(entry.name, list);
    }
  }
})("");

/** Resolve a cited path: as written when it has a directory; a bare basename
 * to the one repo file of that name, or to the full path the same answer
 * writes for it elsewhere; null when neither settles it. */
function resolveCited(path, answer) {
  const clean = path.replace(/^\.\//, "");
  if (existsSync(join(repoDir, clean))) return clean;
  // A short form: a bare basename, or a trailing part of the path
  // (`manifest/mod.rs`). Resolve against the repo's files of that basename.
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const candidates = (byBasename.get(base) ?? []).filter((c) => c === clean || c.endsWith(`/${clean}`));
  if (candidates.length === 1) return candidates[0];
  const inAnswer = candidates.filter((c) => answer.includes(c));
  return inAnswer.length === 1 ? inAnswer[0] : null;
}

function check(answer) {
  const out = { citations: 0, missingFile: 0, outOfBounds: 0, anchored: 0, anchoredOk: 0, examples: [] };
  for (const m of answer.matchAll(CITATION)) {
    const [, path, s, e] = m;
    const start = Number(s);
    const end = e ? Number(e) : start;
    out.citations++;
    const resolved = resolveCited(path, answer);
    const lines = resolved ? linesOf(resolved) : null;
    if (!lines) {
      out.missingFile++;
      // A name the repo has more than once with no full path nearby is
      // unresolved rather than absent; both count against the answer.
      const known = byBasename.has(path.slice(path.lastIndexOf("/") + 1));
      if (out.examples.length < 3) out.examples.push(`${known ? "unresolved" : "missing"} ${path}`);
      continue;
    }
    if (start < 1 || end > lines.length || end < start) {
      out.outOfBounds++;
      if (out.examples.length < 3) out.examples.push(`out of bounds ${path}:${s}${e ? "-" + e : ""} (${lines.length} lines)`);
      continue;
    }
    // The identifier named beside the citation: the nearest backticked name
    // in the preceding sentence fragment.
    const before = answer.slice(Math.max(0, m.index - CITATION_CONTEXT_CHARS), m.index);
    const frag = before.slice(Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n")) + 1);
    const ids = [...frag.matchAll(IDENTIFIER)].map((x) => x[1]).filter((id) => !id.includes("/") && !/\.[a-z]{1,6}$/.test(id));
    if (ids.length === 0) continue;
    const id = ids[ids.length - 1].split("::").pop().split(".").pop().replace(/[()#]/g, "");
    out.anchored++;
    const lo = Math.max(0, start - 1 - ANCHOR_SLACK_LINES);
    const hi = Math.min(lines.length, end + ANCHOR_SLACK_LINES);
    if (lines.slice(lo, hi).some((l) => l.includes(id))) out.anchoredOk++;
    else if (out.examples.length < 3) out.examples.push(`unanchored ${id} at ${path}:${s}`);
  }
  return out;
}

console.log("build           runs  citations  per answer  missing file  out of bounds  anchored ok / anchored");
for (const spec of builds) {
  const rs = rows.filter(selector(spec));
  const tot = { citations: 0, missingFile: 0, outOfBounds: 0, anchored: 0, anchoredOk: 0 };
  const examples = [];
  for (const r of rs) {
    const c = check(r.answer);
    for (const k of Object.keys(tot)) tot[k] += c[k];
    for (const ex of c.examples) if (examples.length < 6) examples.push(`${r.cat} Q${r.q}: ${ex}`);
  }
  const label = spec.includes("..") ? "V0" : spec;
  console.log(
    `${label.padEnd(15)} ${String(rs.length).padStart(4)}  ${String(tot.citations).padStart(9)}  ${(rs.length ? tot.citations / rs.length : 0).toFixed(1).padStart(10)}  ${String(tot.missingFile).padStart(12)}  ${String(tot.outOfBounds).padStart(13)}  ${`${tot.anchoredOk} / ${tot.anchored}`.padStart(22)}`,
  );
  for (const ex of examples) console.log(`    ${ex}`);
}
