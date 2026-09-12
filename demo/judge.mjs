// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The demo's judge: once every arm has answered, a stronger model grades each
// answer's ACCURACY against the repository - A, B, C or F - blind to which
// arm wrote it, with the same verification rules the bench's judge uses.
//
// Blind, because the arm labels ("Sonnet + grep") carry the very hypothesis
// being tested; the judge sees "Answer 1/2/3" in a shuffled order and the
// grades are mapped back here. Grounded, because a grade a reader cannot
// check is a second opinion, not a measurement: the judge reruns the queries
// each run recorded and reads the files each answer names.
//
// The judge's own cost is reported beside the grades and kept out of every
// arm's numbers; it is the price of the measurement, not of any arm.
import { DEFAULT_JUDGE_MODEL, judgeOnce, judgeRules, parseVerdict, queriesBlock } from "../bench/judge-core.mjs";

/** Turns the demo's judge may take. The bench's judge has 30 for two
 * answers; the demo grades three, about mechanisms that span layers, and on
 * 2026-09-11 the first live run reached 30 with no verdict written. 45 is
 * that, scaled to three answers, with the writing turns kept. Each turn is a
 * strong-model call, so this is also the ceiling on what a grade costs.
 * DEMO_JUDGE_MAX_TURNS overrides. */
export const DEFAULT_DEMO_JUDGE_MAX_TURNS = 45;
const JUDGE_MAX_TURNS_ENV = "DEMO_JUDGE_MAX_TURNS";

export function demoJudgeMaxTurns(env = process.env) {
  const raw = env[JUDGE_MAX_TURNS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_DEMO_JUDGE_MAX_TURNS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 3) throw new Error(`${JUDGE_MAX_TURNS_ENV} must be an integer of at least 3, got "${raw}"`);
  return n;
}

/** The grades, best first, and what each one means - shown to the judge as
 * the rubric and to the reader as the legend, so both read the same words. */
export const GRADES = ["A", "B", "C", "F"];
export const GRADE_MEANING = {
  A: "answers the question and every claim checks out against the repository",
  B: "answers the question; one minor claim is unsupported or imprecise",
  C: "partly right; significant claims are unsupported or wrong",
  F: "wrong, or does not answer the question",
};

/** Whether the demo judges at all: on unless DEMO_JUDGE=0. Each judged
 * question is one more strong-model call, tens of seconds and tens of
 * cents, after the arms are done. */
export const judgeEnabled = (env = process.env) => env.DEMO_JUDGE !== "0";

/** The arms in a random order under neutral labels "1".."n". `random` is
 * injectable so the shuffle can be tested. */
export function blind(results, random = Math.random) {
  const order = [...results];
  // Fisher-Yates: every permutation equally likely.
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((result, i) => ({ label: String(i + 1), result }));
}

/** The judge's instructions: the shared verification rules with the demo's
 * rubric and verdict shape around them. */
export function gradingSystem(repoDir, maxTurns = demoJudgeMaxTurns()) {
  const rubric = GRADES.map((g) => `${g}: ${GRADE_MEANING[g]}`).join("; ");
  return (
    `You are grading answers to one question about the repository checked out at ${repoDir}. ` +
    `${judgeRules(maxTurns)} Grade each answer on accuracy alone - ${rubric}. ` +
    `Finish with a single JSON object and nothing after it: ` +
    `{"grades":{"1":"A"|"B"|"C"|"F",...},"unsupported":{"1":<int>,...},"reasons":{"1":"<one sentence>",...}} ` +
    `keyed by each answer's bare label number, one entry per answer, where unsupported counts the ` +
    `claims in that answer the repository does not support.`
  );
}

/** A verdict map read by the bare label whatever the judge wrote as the key -
 * "1", "Answer 1", " answer 1 ". The first live verdict came keyed
 * "Answer 1" and was refused for it; the grading was right, the key was not
 * worth losing it over. */
function byLabel(map) {
  const out = new Map();
  if (map && typeof map === "object") {
    for (const [key, value] of Object.entries(map)) out.set(String(key).replace(/^\s*answer\s*/i, "").trim(), value);
  }
  return out;
}

/** The question and every answer under its label, each with the queries its
 * run recorded. `rows` maps an arm id to the harness row behind it (for the
 * recorded queries); an arm without one is verified with the judge's own. */
export function gradingPrompt(question, labelled, rows = new Map()) {
  const blocks = labelled.map(({ label, result }) => {
    const answer = result.error ? `(this run failed: ${result.error})` : result.answer || "(no answer)";
    return `=== Answer ${label} ===\n${answer}\n\n--- Queries behind Answer ${label} ---\n${queriesBlock(rows.get(result.arm))}`;
  });
  return `Question:\n${question}\n\n${blocks.join("\n\n")}\n\nVerify the claims against the repository, then give the JSON verdict.`;
}

/** The verdict mapped back onto the arms: one grade per arm, or null when
 * the text carries no verdict, a label is missing, or a grade is not one of
 * ours - a half-read verdict would show a grade the judge did not give. */
export function readGrades(text, labelled) {
  const v = parseVerdict(text);
  if (!v || typeof v.grades !== "object" || v.grades === null) return null;
  const graded = byLabel(v.grades);
  const unsupportedBy = byLabel(v.unsupported);
  const reasons = byLabel(v.reasons);
  const grades = [];
  for (const { label, result } of labelled) {
    const grade = graded.get(label);
    if (!GRADES.includes(grade)) return null;
    const unsupported = Number(unsupportedBy.get(label));
    const reason = reasons.get(label);
    grades.push({
      arm: result.arm,
      label: result.label,
      grade,
      unsupported: Number.isInteger(unsupported) && unsupported >= 0 ? unsupported : null,
      reason: typeof reason === "string" ? reason : null,
    });
  }
  return grades;
}

/** Grade every arm's answer to `question`. Returns the grades in the arms'
 * original order with the judge's cost beside them; on a failure the grades
 * are null and `error` says why, so the page can say "unjudged" rather than
 * invent a verdict. */
export async function judgeArms({
  repoDir,
  indexDir,
  question,
  results,
  rows = new Map(),
  model = DEFAULT_JUDGE_MODEL,
  maxTurns = demoJudgeMaxTurns(),
  random = Math.random,
  onEvent,
  serverArgs = [],
  serverEnv = {},
}) {
  const labelled = blind(results, random);
  const run = await judgeOnce({
    repoDir,
    indexDir,
    model,
    maxTurns,
    system: gradingSystem(repoDir, maxTurns),
    prompt: gradingPrompt(question, labelled, rows),
    // The arms' own server, so a recorded ranking reruns where it ran. A
    // hosted arm's `hybrid_search` carries a placeholder the platform
    // embeds; against a local index with no vectors it errors rather than
    // disagrees, and the judge reads that as a claim it cannot support.
    serverArgs,
    serverEnv,
    // Passed straight through: the page draws the checking as it happens,
    // because grading starts after every panel has settled and a page that
    // looks finished while a strong model works reads as a hung one.
    onEvent,
  });
  const byArm = run.error ? null : readGrades(run.text, labelled);
  const grades = byArm ? results.map((r) => byArm.find((g) => g.arm === r.arm)) : null;
  const noVerdict = run.hitTurnCap
    ? `the judge reached its ${maxTurns}-turn cap before writing a verdict`
    : `no verdict in: ${run.text.slice(-200)}`;
  return {
    model: run.model,
    grades,
    // A verdict written on the last turn still counts; the cap is reported
    // beside it so a reader knows the grading stopped where the budget did.
    hitTurnCap: run.hitTurnCap,
    turns: run.turns,
    costUsd: run.costUsd,
    tokens: run.tokens,
    wallMs: run.wallMs,
    toolCalls: run.toolCalls.length,
    toolErrors: run.toolErrors.length,
    error: run.error ?? (byArm ? null : noVerdict),
  };
}
