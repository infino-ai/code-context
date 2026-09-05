// Blind pairwise judge over two builds' answers in a results file: for every
// question and repeat, a stronger model sees both answers in random order,
// checks their claims against the repository, and returns a winner, a
// confidence, and how many claims each answer makes that the repository does
// not support. Verdicts append to bench/.work/results/judge.jsonl.
//
// The judge verifies each claim at the grain the answer states, with the tool
// that measures that grain: Read/Grep/Glob on the checkout for code, lines and
// occurrences; code-context's find and sql on the repository's own index (the
// same local index the lanes ran on, CX_INDEX_DIR or <repo>/.infino) for the
// hit and chunk counts an answer built on the index reports. A count that
// reproduces at its stated grain is supported whichever tool that takes; one
// that reproduces at no grain is not. Every verdict records the rule it was
// judged under (`rule`), so verdicts from before the index tools were given
// to the judge (no `rule`) never tally with these.
//
// Usage: node judge.mjs <repoDir> <baseline> <candidate> [results=questions.jsonl] [cats] [lane=combo]
//   baseline / candidate  build labels as recorded on the rows (`build`), or a
//                         `since..until` ISO window for rows written before the
//                         label existed (e.g. 2026-09-04T12:05:36Z..2026-09-04T12:30:00Z)
//   cats                  comma-separated categories to judge (default all;
//                         pass "" to keep the default and give a lane)
//   lane                  the lane whose rows are judged (default combo; a
//                         hosted run is judged with `hosted`), or two lanes as
//                         `baselineLane,candidateLane` when the builds ran in
//                         different lanes (e.g. `hosted,agent-only`)
// Model: JUDGE_MODEL (default claude-opus-5). Concurrency: CX_BENCH_CONCURRENCY.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RESULTS, record, laneDef, cxServer, mcpEnvBase, foldToolMessage, newToolAccounting } from "./lanes.mjs";

const [repoArg, baselineArg, candidateArg, resultsArg, catsArg, laneArg] = process.argv.slice(2);
if (!repoArg || !baselineArg || !candidateArg) {
  console.error("usage: node judge.mjs <repoDir> <baseline> <candidate> [results.jsonl] [cats] [lane=combo]");
  process.exit(1);
}
const repoDir = resolve(repoArg);
// The index the judge measures index-grain claims against: the one the lanes
// ran on, by the same rule run-questions.mjs uses to find it.
const indexDir = process.env.CX_INDEX_DIR ?? join(repoDir, ".infino");
/** The verification rule these verdicts are judged under, recorded on each:
 * "grain" - every claim checked at the grain the answer states, with the
 * checkout's tools or the index's. Verdicts without a rule predate it (the
 * judge then had the checkout's tools alone). */
const JUDGE_RULE = "grain";
const resultsFile = resultsArg ? resolve(resultsArg) : join(RESULTS, "questions.jsonl");
const cats = catsArg ? new Set(catsArg.split(",")) : null;
// One lane for both builds, or `baselineLane,candidateLane`.
const [baseLane, candLane = baseLane] = (laneArg || "combo").split(",");
const laneWanted = baseLane === candLane ? baseLane : `${baseLane},${candLane}`;
try {
  laneDef(baseLane); // an unknown lane is a usage error, not an empty judgment
  laneDef(candLane);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-opus-5";
const CONC = Number(process.env.CX_BENCH_CONCURRENCY ?? 4);

/** Rows of one build: by label, or by a `since..until` timestamp window. */
function selector(spec) {
  const m = /^(\S+)\.\.(\S+)$/.exec(spec);
  if (m) return (r) => !r.build && r.ts >= m[1] && r.ts < m[2];
  return (r) => r.build === spec;
}

const rows = readFileSync(resultsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => (r.lane === baseLane || r.lane === candLane) && !r.error && r.answer && (!cats || cats.has(r.cat)));

/** Runs of one build in one lane grouped by question, in the order they were
 * recorded. */
function byQuestion(pick, lane) {
  const out = new Map();
  for (const r of rows.filter((r) => r.lane === lane && pick(r))) {
    const key = `${r.cat} ${r.q}`;
    if (!out.has(key)) out.set(key, { cat: r.cat, q: r.q, text: r.question, runs: [] });
    out.get(key).runs.push(r);
  }
  return out;
}

const base = byQuestion(selector(baselineArg), baseLane);
const cand = byQuestion(selector(candidateArg), candLane);

// Question text comes from the question files; the result rows carry only the
// index. Load every shipped set once and look the text up by (cat, q).
const questionText = new Map();
for (const file of ["infino.json", "infino-pinpoint.json", "infino-known-file.json", "infino-by-meaning.json"]) {
  const items = JSON.parse(readFileSync(join(RESULTS, "..", "..", "questions", file), "utf8"));
  items.forEach((item, i) => questionText.set(`${item.cat} ${i + 1}`, item.q));
}

const pairs = [];
for (const [key, b] of base) {
  const c = cand.get(key);
  if (!c) continue;
  const n = Math.min(b.runs.length, c.runs.length);
  for (let i = 0; i < n; i++) {
    pairs.push({ cat: b.cat, q: b.q, rep: i + 1, question: questionText.get(key) ?? "", base: b.runs[i], cand: c.runs[i] });
  }
}
// JUDGE_LIMIT caps the pairs, for a smoke run before spending on the whole set.
if (process.env.JUDGE_LIMIT) pairs.length = Math.min(pairs.length, Number(process.env.JUDGE_LIMIT));
console.log(`judge=${JUDGE_MODEL}  rule=${JUDGE_RULE}  lane=${laneWanted}  baseline=${baselineArg}  candidate=${candidateArg}  pairs=${pairs.length}  index=${indexDir}`);

const system =
  `You are judging two answers to a question about the repository checked out at ${repoDir}. ` +
  `Verify what each answer claims (file paths, line numbers, identifiers, counts, rankings, behaviour) ` +
  `with the tool that measures the claim at the grain the answer states. Read, Grep and Glob on the ` +
  `checkout measure code, lines and occurrences. The code-context tools measure the repository's own ` +
  `index, which some answers report from: find gives every line containing a literal with its per-file ` +
  `line counts (byFile); sql gives chunk counts and rankings, e.g. SELECT path, COUNT(*) AS chunks FROM ` +
  `bm25_search('chunks','content','<terms>', k) GROUP BY path ORDER BY chunks DESC. A count is supported ` +
  `when it reproduces at its stated grain (lines, occurrences, hits, chunks), whichever tool that takes; ` +
  `a count that reproduces at no grain, a ranking its own measure does not give, an attribution the code ` +
  `contradicts, or a name the code does not have is unsupported. Judge correctness and how well each ` +
  `claim is supported; do not reward length or formatting. Finish with a single JSON object and nothing ` +
  `after it: {"winner":"A"|"B"|"tie","confidence":<0..1>,"unsupported_a":<int>,"unsupported_b":<int>,"reason":"<one sentence>"} ` +
  `where unsupported_* counts the claims in that answer the repository does not support.`;

function parseVerdict(text) {
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function judge(pair) {
  const swap = Math.random() < 0.5;
  const A = swap ? pair.cand : pair.base;
  const B = swap ? pair.base : pair.cand;
  const prompt =
    `Question:\n${pair.question}\n\n=== Answer A ===\n${A.answer}\n\n=== Answer B ===\n${B.answer}\n\n` +
    `Verify the claims against the repository, then give the JSON verdict.`;
  const t0 = performance.now();
  const acc = newToolAccounting();
  let text = "";
  let costUsd = null;
  let usage = null;
  let error = null;
  try {
    for await (const m of query({
      prompt,
      options: {
        model: JUDGE_MODEL,
        maxTurns: 30,
        systemPrompt: system,
        permissionMode: "bypassPermissions",
        env: { ...process.env, IS_SANDBOX: "1" },
        cwd: repoDir,
        settingSources: [],
        strictMcpConfig: true,
        tools: ["Read", "Grep", "Glob"],
        // The index's own measure, beside the checkout's: the local server
        // alone (no --db), so a verification never spends a platform call.
        mcpServers: cxServer(mcpEnvBase(repoDir, indexDir)),
      },
    })) {
      foldToolMessage(acc, m);
      if (m.type === "result") {
        usage = m.usage ?? null;
        costUsd = m.total_cost_usd ?? null;
        if (m.result) text = m.result;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  const v = parseVerdict(text);
  const toSide = (w) => (w === "tie" ? "tie" : (w === "A") === !swap ? "baseline" : "candidate");
  const u = usage ?? {};
  return {
    cat: pair.cat,
    q: pair.q,
    rep: pair.rep,
    lane: laneWanted,
    baseline: baselineArg,
    candidate: candidateArg,
    judge: JUDGE_MODEL,
    rule: JUDGE_RULE,
    // The tools the judge called to verify, in order (cx:find, cx:sql, Grep,
    // Read, ...): whether a verdict on an index-grain count was measured.
    tools: acc.toolCalls,
    // Calls whose result was an error - a tool outside the judge's list that
    // the model asked for anyway, or a query the index refused - so a name in
    // `tools` that never ran is told apart from one that did.
    toolErrors: acc.toolDetails.filter((d) => d.isError).map((d) => d.name),
    winner: v ? toSide(v.winner) : null,
    confidence: v?.confidence ?? null,
    unsupportedBaseline: v ? (swap ? v.unsupported_b : v.unsupported_a) : null,
    unsupportedCandidate: v ? (swap ? v.unsupported_a : v.unsupported_b) : null,
    reason: v?.reason ?? null,
    swapped: swap,
    costUsd,
    tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
    wallMs: Math.round(performance.now() - t0),
    error: error ?? (v ? null : `no verdict in: ${text.slice(-200)}`),
    ts: new Date().toISOString(),
  };
}

const verdicts = [];
let cursor = 0;
async function worker() {
  while (cursor < pairs.length) {
    const p = pairs[cursor++];
    const v = await judge(p);
    record("judge.jsonl", v);
    verdicts.push(v);
    console.log(
      `(${verdicts.length}/${pairs.length}) ${p.cat} Q${p.q} r${p.rep}: ${v.winner ?? "ERR"} ${v.confidence ?? ""} ` +
        `unsupported ${v.unsupportedBaseline ?? "?"}/${v.unsupportedCandidate ?? "?"} $${(v.costUsd ?? 0).toFixed(2)}${v.error ? " ERR " + v.error : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
console.log("\ncategory        pairs  baseline  candidate  ties  unsupported b/c  conf(med)  cost");
const catsSeen = [...new Set(verdicts.map((v) => v.cat))];
for (const cat of [...catsSeen, "all"]) {
  const vs = verdicts.filter((v) => (cat === "all" || v.cat === cat) && v.winner);
  const n = (w) => vs.filter((v) => v.winner === w).length;
  const sum = (f) => vs.reduce((a, v) => a + (f(v) ?? 0), 0);
  console.log(
    `${cat.padEnd(15)} ${String(vs.length).padStart(5)}  ${String(n("baseline")).padStart(8)}  ${String(n("candidate")).padStart(9)}  ${String(n("tie")).padStart(4)}  ${`${sum((v) => v.unsupportedBaseline)} / ${sum((v) => v.unsupportedCandidate)}`.padStart(15)}  ${median(vs.map((v) => v.confidence ?? 0)).toFixed(2).padStart(9)}  $${sum((v) => v.costUsd).toFixed(2)}`,
  );
}
