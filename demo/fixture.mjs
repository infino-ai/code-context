// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A scripted run, for developing the page without spending money on models.
//
// This is INVENTED DATA, not a recording. It is shaped like a real run - the
// grep arm fans out, reads a lot and delegates to its own Explore; the infino
// arm asks the index twice and hands one question to the platform's loop - and
// its proportions are taken from the recorded 36-question medians so the
// layout is exercised at realistic sizes. But no model ran and no question was
// answered, so nothing here may be quoted, screenshotted as a result, or shown
// to anyone outside a development session. `DEMO_FIXTURE=1` turns it on and
// the page says so in a banner; the default is off.
//
// It exists because the alternative - clicking a real question every time the
// bar's CSS changes - costs about thirty cents and two minutes a click.

import { livePhase, phaseOf } from "./phases.mjs";

/** Milliseconds of wall clock the scripted run compresses into. Real runs are
 * 20-160 s; a fixture that took that long would defeat its purpose, so the
 * script runs at FIXTURE_SPEED times life. */
const FIXTURE_SPEED = 12;

/** The grep arm: three concurrent greps, a burst of reads, then its own
 * Explore subagent doing the bulk of the work. Times in ms of run time. */
const GREP_SCRIPT = [
  { at: 1800, kind: "tool_start", name: "Grep", batch: 0 },
  { at: 1800, kind: "tool_start", name: "Grep", batch: 0 },
  { at: 1800, kind: "tool_start", name: "Glob", batch: 0 },
  { at: 3100, kind: "tool_end", name: "Glob", batch: 0 },
  { at: 3600, kind: "tool_end", name: "Grep", batch: 0 },
  { at: 4200, kind: "tool_end", name: "Grep", batch: 0 },
  { at: 6000, kind: "tool_start", name: "Read", batch: 1 },
  { at: 6000, kind: "tool_start", name: "Read", batch: 1 },
  { at: 7400, kind: "tool_end", name: "Read", batch: 1 },
  { at: 7900, kind: "tool_end", name: "Read", batch: 1 },
  { at: 10_500, kind: "tool_start", name: "Agent", batch: 2 },
  { at: 33_000, kind: "tool_end", name: "Agent", batch: 2 },
  { at: 36_500, kind: "tool_start", name: "Read", batch: 3 },
  { at: 37_200, kind: "tool_end", name: "Read", batch: 3 },
];

/** The index-only arm: the caller drives retrieval itself - a search, a SQL
 * aggregate, a find - and no loop of ours ever runs, so there is no subagent
 * span in this one at all. */
const INDEX_SCRIPT = [
  { at: 2100, kind: "tool_start", name: "cx:search", batch: 0 },
  { at: 2290, kind: "tool_end", name: "cx:search", batch: 0 },
  { at: 3900, kind: "tool_start", name: "cx:sql", batch: 1 },
  { at: 4480, kind: "tool_end", name: "cx:sql", batch: 1 },
  { at: 6200, kind: "tool_start", name: "cx:find", batch: 2 },
  { at: 6310, kind: "tool_end", name: "cx:find", batch: 2 },
  { at: 8000, kind: "tool_start", name: "Read", batch: 3 },
  { at: 8600, kind: "tool_end", name: "Read", batch: 3 },
];

/** The subagent arm: one search, one find, one explore - and, inside that
 * explore, the calls the subagent's own loop makes. Those carry `sub: true`:
 * they belong in the call feed, which is where the page shows what our loop
 * does that grep's does not, but never in the bar, whose growing edge stays
 * the parent's colour for the whole span. */
const SUBAGENT_SCRIPT = [
  { at: 2200, kind: "tool_start", name: "cx:search", batch: 0 },
  { at: 2380, kind: "tool_end", name: "cx:search", batch: 0 },
  { at: 4100, kind: "tool_start", name: "cx:find", batch: 1 },
  { at: 4210, kind: "tool_end", name: "cx:find", batch: 1 },
  { at: 6000, kind: "tool_start", name: "cx:explore", batch: 2 },
  { at: 7100, kind: "tool_start", name: "search", batch: 2, sub: true },
  { at: 7900, kind: "tool_end", name: "search", batch: 2, sub: true },
  { at: 9200, kind: "tool_start", name: "query_sql", batch: 2, sub: true },
  { at: 10_400, kind: "tool_end", name: "query_sql", batch: 2, sub: true },
  { at: 12_000, kind: "tool_start", name: "search", batch: 2, sub: true },
  { at: 13_100, kind: "tool_end", name: "search", batch: 2, sub: true },
  { at: 17_500, kind: "tool_end", name: "cx:explore", batch: 2 },
  { at: 19_000, kind: "tool_start", name: "Read", batch: 3 },
  { at: 19_600, kind: "tool_end", name: "Read", batch: 3 },
];

const SCRIPTS = {
  grep: {
    script: GREP_SCRIPT,
    wallMs: 41_000,
    costUsd: 0.239,
    tokens: 216_665,
    entries: [],
    answer:
      "FIXTURE - no model ran. In a real run this pane holds the File Tools arm's answer, " +
      "which on the recorded set was about the same quality as the Infino arm's and cost three times as much.",
  },
  index: {
    script: INDEX_SCRIPT,
    wallMs: 22_000,
    costUsd: 0.0861,
    tokens: 43_206,
    // No agentModelTokens on any line: the index-only arm runs no loop of
    // ours, so read tokens are the whole of what it meters.
    entries: [
      { tool: "search", platform: { rttMs: 118, readTokens: 12 } },
      { tool: "sql", platform: { rttMs: 0, readTokens: 0 } },
      { tool: "find", platform: { rttMs: 0, readTokens: 0 } },
    ],
    answer:
      "FIXTURE - no model ran. In a real run this pane holds the index-only arm's answer, " +
      "which the caller reached by querying the index itself.",
  },
  subagents: {
    script: SUBAGENT_SCRIPT,
    wallMs: 22_000,
    costUsd: 0.0795,
    tokens: 39_036,
    // Shaped like the ledger lines a real hosted run appends.
    entries: [
      { tool: "search", platform: { rttMs: 111, readTokens: 12 } },
      { tool: "find", platform: { rttMs: 96, readTokens: 9 } },
      { tool: "explore", agentTurns: 14, agentModelTokens: 211_300, platform: { rttMs: 11_302, readTokens: 37 } },
    ],
    answer:
      "FIXTURE - no model ran. In a real run this pane holds the subagent arm's answer, " +
      "reached by handing the search to our loop.",
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replay one arm's script, emitting the same events `runLane` would and
 * returning a row of the same shape, with `startedAt`/`endedAt` filled from
 * the script so the phase split is computed by the real code rather than
 * hardcoded. */
export async function fixtureArm(arm, emit) {
  const { script, wallMs, costUsd, tokens, entries, answer } = SCRIPTS[arm.id];
  emit({ arm: arm.id, kind: "arm_start", label: arm.label, lane: arm.lane, at: 0 });

  const toolDetails = [];
  const openByKey = new Map();
  const open = new Map();
  let elapsed = 0;
  for (const step of script) {
    await sleep(Math.max(0, (step.at - elapsed) / FIXTURE_SPEED));
    elapsed = step.at;
    // A subagent's inner call is counted like any other - `calls` on a real
    // row includes them - but it never touches `open`, so the bar's phase does
    // not flicker inside its parent's span. The same split the server makes.
    if (step.sub) {
      if (step.kind === "tool_start") {
        toolDetails.push({ name: step.name, input: {}, tookMs: null, usage: null, batch: step.batch, inSubagent: true, startedAt: step.at });
      }
      emit({ arm: arm.id, kind: step.kind, at: step.at, tool: step.name, inSubagent: true });
      continue;
    }
    const key = `${step.name}#${step.batch}`;
    if (step.kind === "tool_start") {
      const detail = { name: step.name, input: {}, tookMs: null, usage: null, batch: step.batch, startedAt: step.at };
      toolDetails.push(detail);
      if (!openByKey.has(key)) openByKey.set(key, []);
      openByKey.get(key).push(detail);
      open.set(key, (open.get(key) ?? 0) + 1);
    } else {
      const waiting = openByKey.get(key) ?? [];
      const detail = waiting.shift();
      if (detail) detail.endedAt = step.at;
      const n = (open.get(key) ?? 1) - 1;
      if (n > 0) open.set(key, n);
      else open.delete(key);
    }
    const names = [];
    for (const [k, n] of open) for (let i = 0; i < n; i += 1) names.push(k.split("#")[0]);
    emit({
      arm: arm.id,
      kind: step.kind,
      at: step.at,
      tool: step.name,
      phase: phaseOf(step.name) ?? "model",
      nowIn: livePhase(names),
      openCalls: names.length,
    });
  }
  await sleep(Math.max(0, (wallMs - elapsed) / FIXTURE_SPEED));
  return { toolDetails, wallMs, costUsd, tokens, entries, answer, error: null, calls: toolDetails.length, toolCalls: toolDetails.map((d) => d.name), durationApiMs: null };
}

export const isFixture = (env = process.env) => env.DEMO_FIXTURE === "1";
