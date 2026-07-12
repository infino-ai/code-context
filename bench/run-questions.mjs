// Aggregation + comprehension lanes over any indexed repo.
// Usage: node run-questions.mjs <cx|files|both> <repoPath> [questions.json]
// The repo must be indexed first (`cx index <repoPath>`); the cx lane reads
// the index from <repoPath>/.infino (or CX_INDEX_DIR).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLane, record } from "./lanes.mjs";

const DEFAULT_QUESTIONS = [
  "Which files have the most code?",
  "Break down the codebase by language.",
  "How many indexed chunks are there per language? Give the counts.",
  "What are the 10 largest source files by lines of code?",
  "Which files have the most code related to the project's core write path?",
  "Which files have the most code about search or indexing?",
  "How does the main write/append path work?",
  "How does scoring or ranking work in this codebase?",
  "Where is the most complex algorithm implemented, and how does it work?",
  "What happens on startup or recovery, and where is it implemented?",
];

const [lane, repoArg, questionsArg] = process.argv.slice(2);
if (!["cx", "files", "both"].includes(lane) || !repoArg) {
  console.error("usage: node run-questions.mjs <cx|files|both> <repoPath> [questions.json]");
  process.exit(1);
}
const repoDir = resolve(repoArg);
const indexDir = process.env.CX_INDEX_DIR ?? join(repoDir, ".infino");
const questions = questionsArg
  ? JSON.parse(readFileSync(questionsArg, "utf8"))
  : DEFAULT_QUESTIONS;

const system =
  `You answer questions about the repository checked out at ${repoDir}. ` +
  `Use the available tools to find the answer. Cite file paths (with line ranges when you have them). ` +
  `Be efficient: prefer few, well-chosen tool calls.`;

for (let i = 0; i < questions.length; i++) {
  for (const l of lane === "both" ? ["cx", "files"] : [lane]) {
    const r = await runLane({ lane: l, prompt: questions[i], system, repoDir, indexDir });
    record("questions.jsonl", { q: i + 1, question: questions[i], repo: repoDir, ...r, answer: r.answer.slice(0, 1500) });
    console.log(
      `[${l}] Q${i + 1} — ${r.tokens.toLocaleString()} tok · $${(r.costUsd ?? 0).toFixed(3)} · ${r.toolCalls.join(" → ")}${r.error ? " · ERR " + r.error : ""}`,
    );
  }
}
