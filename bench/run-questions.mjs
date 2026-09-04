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
//   lanes         "files,combo" (default) - comma-separated lane names from the
//                 table in lanes.mjs (files|cx|combo|hosted|hosted-agent); the
//                 hosted lanes need CX_BENCH_DB_URL and CX_BENCH_KEY_FILE set
//                 and the repo loaded into that database first (load-hosted.mjs)
//   questionsFile path to a questions JSON (default questions/infino.json)
// Model is set in lanes.mjs (BENCH_MODEL, default claude-sonnet-4-6).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLane, record, checkLaneEnv, LANES, MODEL, BENCH } from "./lanes.mjs";

const [repoArg, lanesArg, questionsArg] = process.argv.slice(2);
const repoPath = repoArg ?? process.env.CX_BENCH_REPO;
if (!repoPath) {
  console.error("usage: node run-questions.mjs [repoPath] [lanes=files,combo] [questionsFile]");
  console.error("  index the repo first: cx index <repoPath>   (or set CX_BENCH_REPO)");
  console.error(`  lanes: ${Object.keys(LANES).join("|")}; hosted lanes need CX_BENCH_DB_URL + CX_BENCH_KEY_FILE`);
  console.error("  questionsFile defaults to questions/infino.json; see bench/questions/");
  process.exit(1);
}
const repoDir = resolve(repoPath);
const indexDir = process.env.CX_INDEX_DIR ?? join(repoDir, ".infino");
const lanes = (lanesArg ?? "files,combo").split(",").map((s) => s.trim());
// An unknown lane or a hosted lane without its credentials fails here, before
// the first paid model call, instead of on every question.
try {
  for (const lane of lanes) checkLaneEnv(lane);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
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
    results.push({ ...job, tokens: r.tokens, cost: r.costUsd ?? 0, calls: r.calls, wallMs: r.wallMs, cxTookMs: r.cxTookMs, error: r.error });
    done++;
    console.log(
      `(${done}/${jobs.length}) [${job.lane}] Q${job.i} ${job.cat} - ${r.tokens.toLocaleString()} tok, ${r.calls} calls, ` +
        `${(r.wallMs / 1000).toFixed(1)}s${r.cxTookMs ? ` (cx ${r.cxTookMs}ms)` : ""}${r.error ? " ERR" : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));

// Summary: per-category and blended, every other lane against the first lane
// given (the default order puts files first, so the default reads "combo vs
// files"; "combo,hosted" reads hosted against the local server), on three
// axes - tokens, tool calls (round-trips), and wall time. Fewer tool calls is
// the robust latency proxy; wall time is the direct measure but only
// meaningful run sequentially (CX_BENCH_CONCURRENCY=1), since a pool contends
// for CPU and the API and inflates each run's clock.
const byq = {};
for (const r of results) (byq[r.i] = byq[r.i] || { cat: r.cat })[r.lane] = r;
const bucket = (baseLane, candLane, pred) => {
  const acc = { fTok: 0, cTok: 0, fCall: 0, cCall: 0, fMs: 0, cMs: 0 };
  for (const q of Object.values(byq)) if (pred(q.cat) && q[baseLane] && q[candLane]) {
    acc.fTok += q[baseLane].tokens; acc.cTok += q[candLane].tokens;
    acc.fCall += q[baseLane].calls; acc.cCall += q[candLane].calls;
    acc.fMs += q[baseLane].wallMs; acc.cMs += q[candLane].wallMs;
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
const [baseLane, ...candLanes] = lanes;
for (const candLane of candLanes) {
  console.log(`\n=== summary: ${candLane} vs ${baseLane} ===`);
  console.log(line("aggregation", bucket(baseLane, candLane, (c) => c === "aggregation")));
  console.log(line("comprehension", bucket(baseLane, candLane, (c) => c === "comprehension")));
  console.log(line("blended", bucket(baseLane, candLane, () => true)));
}
if (candLanes.length && CONC > 1) console.log(`\n(time is indicative only: run with CX_BENCH_CONCURRENCY=1 for clean latency; tool-call count is the concurrency-independent latency proxy)`);
