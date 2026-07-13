// SWE-bench_Verified file-localization lanes, unsteered.
// Scoring: precision/recall/F1 of predicted file paths vs the gold patch
// files. Usage: node run-swebench.mjs <cx|files|both> [instanceId ...]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WORK, RESULTS, runLane, record } from "./lanes.mjs";

const MAX_TURNS = 12;
const OUT = "swebench.jsonl";
const instances = JSON.parse(readFileSync(join(WORK, "instances.json"), "utf8"));

const SYSTEM =
  "You are localizing a bug fix. Use the available tools to explore the repository and find " +
  "where the described issue must be fixed. Be efficient: few, well-chosen tool calls. " +
  'End your final message with a JSON array of the file paths (relative to the repo root) that ' +
  'must be modified, e.g. ["pkg/module/file.py", "pkg/other.py"]. Only the array on the last line.';

function extractPaths(answer) {
  const matches = [...answer.matchAll(/\[[^\[\]]*\]/gs)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr.map((p) => p.replace(/^\.\//, "").replace(/^\//, ""));
      }
    } catch {
      /* keep scanning */
    }
  }
  return [];
}

function score(predicted, gold) {
  const p = new Set(predicted);
  const g = new Set(gold);
  const tp = [...p].filter((x) => g.has(x)).length;
  const precision = p.size ? tp / p.size : 0;
  const recall = g.size ? tp / g.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp };
}

const lane = process.argv[2];
if (!["cx", "files", "both"].includes(lane)) {
  console.error("usage: node run-swebench.mjs <cx|files|both> [instanceId ...]");
  process.exit(1);
}
const ids = process.argv.slice(3);
const ready = (inst) => {
  try {
    return (
      JSON.parse(readFileSync(join(WORK, "instances", inst.id, "index", "codecontext.json"), "utf8"))
        .vectors === "ready"
    );
  } catch {
    return false;
  }
};
const outPath = join(RESULTS, OUT);
const done = new Set(
  existsSync(outPath)
    ? readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => {
        const r = JSON.parse(l);
        return r.error ? null : `${r.lane}:${r.id}`;
      })
    : [],
);

for (const inst of instances) {
  if (ids.length && !ids.includes(inst.id)) continue;
  if (!ids.length && !ready(inst)) continue;
  for (const l of lane === "both" ? ["cx", "files"] : [lane]) {
    if (done.has(`${l}:${inst.id}`)) continue;
    const repoDir = join(WORK, "instances", inst.id, "repo");
    const indexDir = join(WORK, "instances", inst.id, "index");
    const prompt = `Repository: ${inst.repo}\n\nIssue:\n${inst.problem}\n\nFind the file(s) that must be modified to fix this issue.`;
    const r = await runLane({ lane: l, prompt, system: SYSTEM, repoDir, indexDir, maxTurns: MAX_TURNS });
    const predicted = extractPaths(r.answer);
    const s = score(predicted, inst.gold);
    record(OUT, { id: inst.id, repo: inst.repo, ...s, predicted, gold: inst.gold, ...r, answer: undefined, answerTail: r.answer.slice(-400) });
    console.log(
      `[${l}] ${inst.id} - F1 ${s.f1.toFixed(2)} (${s.tp}/${inst.gold.length}) · ${r.tokens.toLocaleString()} tok · $${(r.costUsd ?? 0).toFixed(3)} · ${r.calls} calls${r.error ? " · ERROR " + r.error : ""}`,
    );
  }
}
console.log("lane runs complete →", outPath);
