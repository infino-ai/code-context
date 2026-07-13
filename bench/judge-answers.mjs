// Blind pairwise answer-quality judge for the question suite: for each
// question, both lanes' answers go to the judge anonymized (A/B, order
// randomized by question+run) and it must pick A, B, or EQUIVALENT.
// The judge cannot see the repo, so this measures completeness and
// internal consistency, not ground truth.
// Usage: ANTHROPIC_API_KEY=... node judge-answers.mjs [results.jsonl]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS } from "./lanes.mjs";

const file = process.argv[2] ?? join(RESULTS, "questions.jsonl");
const rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const byQ = {};
for (const r of rows) {
  if (r.error || !["cx", "files"].includes(r.lane)) continue;
  ((byQ[r.q] ??= {})[r.lane] ??= []).push(r);
}

const results = [];
for (const q of Object.keys(byQ).sort((a, b) => a - b)) {
  const runs = Math.min(byQ[q].cx?.length ?? 0, byQ[q].files?.length ?? 0);
  for (let run = 0; run < runs; run++) {
    const cx = byQ[q].cx[run].answer;
    const fi = byQ[q].files[run].answer;
    const flip = (Number(q) + run) % 2 === 1;
    const [A, B] = flip ? [fi, cx] : [cx, fi];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            `Two AI agents answered the same question about a codebase. Judge which answer is better ` +
            `on correctness-consistency, completeness, and usefulness (specific files, numbers, clear ` +
            `explanation). You cannot see the repo; judge the answers on their own merits and internal ` +
            `consistency.\n\nQUESTION: ${byQ[q].cx[run].question}\n\nANSWER A:\n${A.slice(0, 4000)}\n\n` +
            `ANSWER B:\n${B.slice(0, 4000)}\n\nReply with exactly one line: "A", "B", or "EQUIVALENT", ` +
            `then one sentence why.`,
        }],
      }),
    });
    const j = await res.json();
    const text = j.content?.[0]?.text ?? "ERR";
    const raw = text.trim().split(/\s|\n/)[0].replace(/[^A-Z]/gi, "").toUpperCase();
    const verdict =
      raw === "EQUIVALENT" ? "equivalent"
      : raw === "A" ? (flip ? "files" : "cx")
      : raw === "B" ? (flip ? "cx" : "files")
      : "unparsed";
    results.push({ q: Number(q), run, verdict, note: text.slice(0, 200) });
    console.log(`Q${q} run${run}: ${verdict}`);
  }
}
const tally = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
console.log("TALLY:", JSON.stringify(tally));
writeFileSync(join(RESULTS, "judge.json"), JSON.stringify(results, null, 1));
