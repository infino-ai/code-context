// The token benchmark: aggregation + comprehension questions over an indexed
// repo, two lanes - stock file tools (files) vs the same agent with the
// code-context MCP added (combo, i.e. what installing the server produces).
// Measures total tokens per lane; the win is largest on a repo the model
// does not already know from training (a private codebase), where the file
// baseline has to explore rather than recall.
//
// Nothing here is hardcoded: point it at any repo and any question file, no
// code changes. Question sets live in bench/questions/*.json as an array of
// {cat, q} (cat splits the summary into aggregation vs comprehension). The
// default set targets the infino engine repo; questions/swe-qa-django.json
// holds the SWE-QA comprehension slice (needs django checked out at 14fc2e9).
//
// Usage: node run-questions.mjs [repoPath] [lanes] [questionsFile]
//   repoPath      the indexed repo (or $CX_BENCH_REPO); `cx index <repo>` first
//   lanes         "files,combo" (default) - comma-separated of files|combo|cx
//   questionsFile path to a questions JSON (default questions/infino.json)
// Model is set in lanes.mjs (BENCH_MODEL, default claude-sonnet-4-6).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLane, record, MODEL, BENCH } from "./lanes.mjs";

const [repoArg, lanesArg, questionsArg] = process.argv.slice(2);
const repoPath = repoArg ?? process.env.CX_BENCH_REPO;
if (!repoPath) {
  console.error("usage: node run-questions.mjs [repoPath] [lanes=files,combo] [questionsFile]");
  console.error("  index the repo first: cx index <repoPath>   (or set CX_BENCH_REPO)");
  console.error("  questionsFile defaults to questions/infino.json; see bench/questions/");
  process.exit(1);
}
const repoDir = resolve(repoPath);
const indexDir = process.env.CX_INDEX_DIR ?? join(repoDir, ".infino");
const lanes = (lanesArg ?? "files,combo").split(",").map((s) => s.trim());
const questionsFile = questionsArg ?? process.env.CX_BENCH_QUESTIONS ?? join(BENCH, "questions", "infino.json");
const questions = JSON.parse(readFileSync(questionsFile, "utf8"));

const system =
  `You answer questions about the repository checked out at ${repoDir}. ` +
  `Use the available tools to find the answer. Cite file paths (with line ranges when you have them). ` +
  `Be efficient: prefer few, well-chosen tool calls.`;

// Run every (question, lane) pair through a small concurrency pool.
const CONC = Number(process.env.CX_BENCH_CONCURRENCY ?? 5);
const jobs = [];
questions.forEach((item, i) => {
  const q = typeof item === "string" ? item : item.q;
  const cat = typeof item === "string" ? "uncategorized" : item.cat;
  for (const lane of lanes) jobs.push({ i: i + 1, cat, q, lane });
});

console.log(`model=${MODEL}  repo=${repoDir.split("/").pop()}  lanes=${lanes.join("+")}  questions=${questionsFile.split("/").pop()} (${questions.length})\n`);
const results = [];
let cursor = 0, done = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const r = await runLane({ lane: job.lane, prompt: job.q, system, repoDir, indexDir });
    record("questions.jsonl", { q: job.i, cat: job.cat, lane: job.lane, repo: repoDir, ...r, answer: r.answer.slice(0, 1500) });
    results.push({ ...job, tokens: r.tokens, cost: r.costUsd ?? 0, calls: r.calls, wallMs: r.wallMs, error: r.error });
    done++;
    console.log(`(${done}/${jobs.length}) [${job.lane}] Q${job.i} ${job.cat} - ${r.tokens.toLocaleString()} tok, ${r.calls} calls, ${(r.wallMs / 1000).toFixed(1)}s${r.error ? " ERR" : ""}`);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));

// Summary: per-category and blended, combo vs files, on three axes -
// tokens, tool calls (round-trips), and wall time. Fewer tool calls is the
// robust latency proxy; wall time is the direct measure but only meaningful
// run sequentially (CX_BENCH_CONCURRENCY=1), since a pool contends for CPU
// and the API and inflates each run's clock.
const byq = {};
for (const r of results) (byq[r.i] = byq[r.i] || { cat: r.cat })[r.lane] = r;
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
const bucket = (pred) => {
  const acc = { fTok: 0, cTok: 0, fCall: 0, cCall: 0, fMs: 0, cMs: 0 };
  for (const q of Object.values(byq)) if (pred(q.cat) && q.files && q.combo) {
    acc.fTok += q.files.tokens; acc.cTok += q.combo.tokens;
    acc.fCall += q.files.calls; acc.cCall += q.combo.calls;
    acc.fMs += q.files.wallMs; acc.cMs += q.combo.wallMs;
  }
  return acc;
};
const pct = (f, c) => (f ? ((f - c) / f) * 100 : 0);
const fmtPct = (f, c, unit) => {
  const p = pct(f, c);
  return `${p >= 0 ? "-" : "+"}${Math.abs(p).toFixed(0)}% ${p >= 0 ? "fewer" : "more"} ${unit}`;
};
const line = (label, b) =>
  `${label.padEnd(14)} tokens ${fmtPct(b.fTok, b.cTok, "tokens").padEnd(18)} | ` +
  `tool calls ${b.fCall}->${b.cCall} (${fmtPct(b.fCall, b.cCall, "calls")}) | ` +
  `time ${(b.fMs / 1000).toFixed(0)}s->${(b.cMs / 1000).toFixed(0)}s (${fmtPct(b.fMs, b.cMs, "time")})`;
if (lanes.includes("files") && lanes.includes("combo")) {
  console.log("\n=== summary: combo vs files ===");
  console.log(line("aggregation", bucket((c) => c === "aggregation")));
  console.log(line("comprehension", bucket((c) => c === "comprehension")));
  console.log(line("blended", bucket(() => true)));
  if (CONC > 1) console.log(`\n(time is indicative only: run with CX_BENCH_CONCURRENCY=1 for clean latency; tool-call count is the concurrency-independent latency proxy)`);
}
