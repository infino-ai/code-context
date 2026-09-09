// Compare server builds recorded in one results file, the tool-surface
// report: per category and build, the sum over questions of the median (over
// repeats) tokens, cost and tool calls; how often a code-context tool was the
// first call and was used at all; and the first tool of every run by name.
//
// Usage: node compare-builds.mjs [results=questions.jsonl] [builds] [lane=combo]
//   builds  comma-separated build labels as recorded on the rows (`build`), or
//           `since..until` ISO windows for rows written before the label
//           existed (they print as the window). Default: every label in the
//           file, with CX_V0_WINDOW=since..until prepended when set.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RESULTS } from "./lanes.mjs";

const [resultsArg, buildsArg, laneWanted = "combo"] = process.argv.slice(2);
const resultsFile = resultsArg ? resolve(resultsArg) : join(RESULTS, "questions.jsonl");
const all = readFileSync(resultsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.lane === laneWanted);

function selector(spec) {
  const m = /^(\S+)\.\.(\S+)$/.exec(spec);
  if (m) return (r) => !r.build && r.ts >= m[1] && r.ts < m[2];
  return (r) => r.build === spec;
}
let builds;
if (buildsArg) builds = buildsArg.split(",");
else {
  builds = [...new Set(all.map((r) => r.build).filter(Boolean))];
  if (process.env.CX_V0_WINDOW) builds.unshift(process.env.CX_V0_WINDOW);
}
const label = (spec) => (spec.includes("..") ? "V0" : spec);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n)));

/** Per-category sums of per-question medians, plus selection counts. */
function summarize(rows) {
  const byQ = new Map();
  for (const r of rows) {
    const key = `${r.cat} ${r.q}`;
    if (!byQ.has(key)) byQ.set(key, { cat: r.cat, runs: [] });
    byQ.get(key).runs.push(r);
  }
  const cats = {};
  for (const g of byQ.values()) {
    const c = (cats[g.cat] ??= { tok: 0, cost: 0, calls: 0, runs: 0, cxFirst: 0, cxAny: 0, first: {}, errors: 0 });
    c.tok += median(g.runs.map((r) => r.tokens));
    c.cost += median(g.runs.map((r) => r.costUsd ?? 0));
    c.calls += median(g.runs.map((r) => r.calls));
    for (const r of g.runs) {
      c.runs++;
      if (r.error) c.errors++;
      const f = r.toolCalls?.[0] ?? "(none)";
      c.first[f] = (c.first[f] ?? 0) + 1;
      if (f.startsWith("cx:")) c.cxFirst++;
      if ((r.toolCalls ?? []).some((t) => t.startsWith("cx:"))) c.cxAny++;
      // Every call by tool name over the category's runs: where a build's
      // round-trips went (a tiered result that costs Reads shows up here).
      c.mix ??= {};
      for (const t of r.toolCalls ?? []) c.mix[t] = (c.mix[t] ?? 0) + 1;
    }
  }
  return cats;
}

const summaries = builds.map((spec) => ({ spec, cats: summarize(all.filter(selector(spec))) }));
const catOrder = [...new Set(summaries.flatMap((s) => Object.keys(s.cats)))];
const fmtFirst = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ");

console.log(`lane=${laneWanted}  builds: ${summaries.map((s) => `${label(s.spec)}=${all.filter(selector(s.spec)).length} runs`).join(", ")}`);
console.log("");
console.log("category        build  tokens   cost   calls  cx-first  cx-any  errors  first tool of each run");
for (const cat of catOrder) {
  for (const s of summaries) {
    const c = s.cats[cat];
    if (!c) continue;
    console.log(
      `${cat.padEnd(15)} ${label(s.spec).padEnd(5)} ${k(c.tok).padStart(7)}  ${("$" + c.cost.toFixed(2)).padStart(5)}  ${String(c.calls).padStart(5)}  ${`${c.cxFirst}/${c.runs}`.padStart(8)}  ${`${c.cxAny}/${c.runs}`.padStart(6)}  ${String(c.errors).padStart(6)}  ${fmtFirst(c.first)}`,
    );
  }
  console.log("");
}
console.log("build  tokens   cost   calls  cx-first  runs  errors");
for (const s of summaries) {
  const cs = Object.values(s.cats);
  const sum = (f) => cs.reduce((a, c) => a + f(c), 0);
  console.log(
    `${label(s.spec).padEnd(5)} ${k(sum((c) => c.tok)).padStart(7)}  ${("$" + sum((c) => c.cost).toFixed(2)).padStart(5)}  ${String(sum((c) => c.calls)).padStart(5)}  ${`${sum((c) => c.cxFirst)}/${sum((c) => c.runs)}`.padStart(8)}  ${String(sum((c) => c.runs)).padStart(4)}  ${String(sum((c) => c.errors)).padStart(6)}`,
  );
}

// CX_MD=1 prints the same summary as markdown tables for docs/benchmark.md:
// one per category with a row per build, plus the blended table. "Right
// first" counts runs whose first call was the tool the question shape is for.
const INTENDED = {
  aggregation: (t) => t === "cx:sql",
  comprehension: (t) => t === "cx:search" || t === "cx:context",
  "by-meaning": (t) => t === "cx:search" || t === "cx:context",
  pinpoint: (t) => t === "cx:find",
  "known-file": (t) => t === "Read",
};
if (process.env.CX_MD) {
  const rightFirst = (cat, first) =>
    Object.entries(first).reduce((n, [t, c]) => n + ((INTENDED[cat] ?? (() => false))(t) ? c : 0), 0);
  for (const cat of catOrder) {
    console.log(`\n**${cat}**\n`);
    console.log("| build | tokens | cost | calls | right first | first tool of each run |");
    console.log("|---|---|---|---|---|---|");
    for (const s of summaries) {
      const c = s.cats[cat];
      if (!c) continue;
      console.log(`| ${label(s.spec)} | ${k(c.tok)} | $${c.cost.toFixed(2)} | ${c.calls} | ${rightFirst(cat, c.first)}/${c.runs} | ${fmtFirst(c.first)} |`);
    }
  }
  console.log(`\n**blended**\n`);
  console.log("| build | tokens | cost | calls | right first |");
  console.log("|---|---|---|---|---|");
  for (const s of summaries) {
    const cs = Object.entries(s.cats);
    const sum = (f) => cs.reduce((a, [, c]) => a + f(c), 0);
    const right = cs.reduce((a, [cat, c]) => a + rightFirst(cat, c.first), 0);
    console.log(`| ${label(s.spec)} | ${k(sum((c) => c.tok))} | $${sum((c) => c.cost).toFixed(2)} | ${sum((c) => c.calls)} | ${right}/${sum((c) => c.runs)} |`);
  }
}

// CX_DETAIL=1 adds the per-question view: median tokens and calls per build,
// and the tool sequence of every run, so a category-level move can be traced
// to the questions that carry it.
if (process.env.CX_DETAIL) {
  const cx = (calls) => calls.filter((t) => t.startsWith("cx:")).map((t) => t.slice(3)).join("+") || "-";
  for (const cat of catOrder) {
    console.log(`\n=== ${cat} ===`);
    for (const s of summaries) {
      const c = s.cats[cat];
      if (c) console.log(`${label(s.spec).padEnd(8)} all calls: ${fmtFirst(c.mix ?? {})}`);
    }
    const qs = [...new Set(all.filter((r) => r.cat === cat).map((r) => r.q))].sort((a, b) => a - b);
    for (const q of qs) {
      for (const s of summaries) {
        const runs = all.filter(selector(s.spec)).filter((r) => r.cat === cat && r.q === q);
        if (runs.length === 0) continue;
        console.log(
          `Q${String(q).padEnd(2)} ${label(s.spec).padEnd(8)} ${k(median(runs.map((r) => r.tokens))).padStart(6)} tok ${String(median(runs.map((r) => r.calls))).padStart(4)} calls  first: ${runs.map((r) => r.toolCalls?.[0] ?? "(none)").join(", ").padEnd(36)} cx: ${runs.map((r) => cx(r.toolCalls ?? [])).join(" | ")}`,
        );
      }
    }
  }
}
