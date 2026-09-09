// Summarize the judge's verdicts (bench/.work/results/judge.jsonl) per
// baseline/candidate pair and category: pairs, wins each way, ties, the
// unsupported-claim totals, and the median confidence. A pair judged more than
// once (a smoke run before the full one) counts its latest verdict only.
// Usage: node judge-report.mjs [judge.jsonl]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RESULTS } from "./lanes.mjs";

const file = process.argv[2] ? resolve(process.argv[2]) : join(RESULTS, "judge.jsonl");
const latest = new Map();
for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  const v = JSON.parse(line);
  latest.set(`${v.baseline} ${v.candidate} ${v.cat} ${v.q} ${v.rep}`, v);
}
const verdicts = [...latest.values()];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const label = (spec) => (spec.includes("..") ? "V0" : spec);

const comparisons = [...new Set(verdicts.map((v) => `${v.baseline}\t${v.candidate}`))];
for (const cmp of comparisons) {
  const [baseline, candidate] = cmp.split("\t");
  const vs = verdicts.filter((v) => v.baseline === baseline && v.candidate === candidate);
  const failed = vs.filter((v) => !v.winner).length;
  console.log(`${label(baseline)} vs ${label(candidate)}  judge=${vs[0]?.judge}  pairs=${vs.length}${failed ? `  no verdict: ${failed}` : ""}  cost $${vs.reduce((a, v) => a + (v.costUsd ?? 0), 0).toFixed(2)}`);
  console.log(`category        pairs  ${label(baseline).padStart(8)}  ${label(candidate).padStart(9)}  ties  unsupported ${label(baseline)} / ${label(candidate)}  conf(med)`);
  const cats = [...new Set(vs.map((v) => v.cat))];
  for (const cat of [...cats, "all"]) {
    const rows = vs.filter((v) => (cat === "all" || v.cat === cat) && v.winner);
    const n = (w) => rows.filter((v) => v.winner === w).length;
    const sum = (f) => rows.reduce((a, v) => a + (f(v) ?? 0), 0);
    console.log(
      `${cat.padEnd(15)} ${String(rows.length).padStart(5)}  ${String(n("baseline")).padStart(8)}  ${String(n("candidate")).padStart(9)}  ${String(n("tie")).padStart(4)}  ${`${sum((v) => v.unsupportedBaseline)} / ${sum((v) => v.unsupportedCandidate)}`.padStart(22)}  ${median(rows.map((v) => v.confidence ?? 0)).toFixed(2).padStart(9)}`,
    );
  }
  console.log("");
}
