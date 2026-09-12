// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Where a run's wall clock went, split three ways: model, retrieval, subagent.
//
// The split is the demo's whole claim, so it is computed here as pure functions
// over the tool spans `runLane` records, and tested against synthetic streams
// with no model in the loop.
//
// The three phases mean the same thing on both arms, which is what makes the
// two bars comparable:
//
//   RETRIEVAL  how the arm finds code. For the grep arm that is Grep, Glob, LS,
//              Bash and Read - hunting the working tree IS its retrieval, and
//              its cost is the whole reason the comparison exists. For the
//              infino arm it is find, search and sql against the index.
//   SUBAGENT   work handed to another loop: the caller's own Explore subagent
//              (the `Agent` tool) on the grep arm, our ask on the
//              infino arm. Whatever that loop does inside - its own thinking
//              and its own retrieval - is inside this span by construction.
//   MODEL      the caller model itself: wall clock minus every span above.
//              Not measured directly, and it is the largest share on both arms.
//
// Two rules the arithmetic must obey, both learned from the harness rather than
// assumed:
//
//   Union, never sum. Several tool_use blocks in one assistant message run
//   CONCURRENTLY (see the `batch` field in bench/lanes.mjs). Adding their
//   durations would push the segments past 100% of the wall clock on exactly
//   the fan-out questions this demo exists to show.
//
//   Top-level spans only. A subagent's own calls carry `inSubagent` and sit
//   INSIDE the parent Agent/ask span. Counting both double-counts.

/** Tools that are the arm hunting for code. `Read` counts: on the grep arm
 * pulling a file into context is the retrieval, and it is the single largest
 * line in that arm's tool tally. */
const RETRIEVAL_TOOLS = new Set(["Grep", "Glob", "LS", "Bash", "Read", "cx:find", "cx:search", "cx:sql"]);

/** Tools that hand the question to another loop. `Agent` is the caller's own
 * Explore subagent; `cx:ask` is ours. `cx:explore` was a second tool of ours
 * until 2026-09-12; it stays in the set so a recorded run from before then
 * still splits into the same three phases. */
const SUBAGENT_TOOLS = new Set(["Agent", "cx:ask", "cx:explore"]);

/** The three phases in the order they are stacked and coloured. */
export const PHASES = ["model", "retrieval", "subagent"];

/** Which phase a tool call belongs to; null for a tool that is neither (a
 * write, a notebook edit - nothing a read-only demo run should reach for, but
 * an unknown name must not be silently counted as retrieval). */
export function phaseOf(name) {
  if (SUBAGENT_TOOLS.has(name)) return "subagent";
  if (RETRIEVAL_TOOLS.has(name)) return "retrieval";
  return null;
}

/** Merge overlapping or touching [start, end] intervals and return the total
 * length covered. Input need not be sorted. */
export function unionMs(intervals) {
  const spans = intervals.filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let openFrom = null;
  let openTo = null;
  for (const [from, to] of spans) {
    if (openTo === null || from > openTo) {
      if (openTo !== null) total += openTo - openFrom;
      openFrom = from;
      openTo = to;
    } else if (to > openTo) {
      openTo = to;
    }
  }
  if (openTo !== null) total += openTo - openFrom;
  return total;
}

/** The top-level spans of one phase, as [startedAt, endedAt] pairs. A call
 * still in flight when the run ended has no `endedAt` and is closed at
 * `wallMs`, so an interrupted run still adds up. */
export function spansOf(toolDetails, phase, wallMs) {
  return (toolDetails ?? [])
    .filter((d) => !d.inSubagent && phaseOf(d.name) === phase && Number.isFinite(d.startedAt))
    .map((d) => [d.startedAt, Number.isFinite(d.endedAt) ? d.endedAt : wallMs]);
}

/** The run's wall clock split three ways, in milliseconds.
 *
 * `retrieval` and `subagent` are each a union of their own spans; a call of one
 * phase overlapping a call of another (the model fanning out across both in one
 * message) is counted under both, so the two can sum to more than the tool time
 * — `model` is computed from the union of ALL spans, never by subtracting the
 * two, so the three still sum to the wall clock. `overlapMs` reports how much
 * was double-attributed, and is zero on almost every run. */
export function phaseSplit({ wallMs, toolDetails }) {
  const wall = Number.isFinite(wallMs) ? wallMs : 0;
  const retrieval = unionMs(spansOf(toolDetails, "retrieval", wall));
  const subagent = unionMs(spansOf(toolDetails, "subagent", wall));
  const allSpans = [...spansOf(toolDetails, "retrieval", wall), ...spansOf(toolDetails, "subagent", wall)];
  const tool = unionMs(allSpans);
  const model = Math.max(0, wall - tool);
  return {
    wallMs: wall,
    modelMs: model,
    retrievalMs: retrieval,
    subagentMs: subagent,
    // What the union of both phases actually covered, and how much of it was
    // claimed by both at once.
    toolMs: tool,
    overlapMs: Math.max(0, retrieval + subagent - tool),
  };
}

/** The share of the wall clock each phase holds, as fractions summing to 1.
 * Drawn straight onto the bar. A zero-length run is all model, so the bar has
 * something to show rather than dividing by zero. */
export function phaseShares(split) {
  const wall = split.wallMs || 0;
  if (wall <= 0) return { model: 1, retrieval: 0, subagent: 0 };
  return {
    model: split.modelMs / wall,
    retrieval: split.retrievalMs / wall,
    subagent: split.subagentMs / wall,
  };
}

/** The phase a run is in RIGHT NOW, given the calls open at this moment: the
 * live bar's growing edge. Subagent wins over retrieval when both are open,
 * because a subagent span contains retrieval of its own and the outer label is
 * the true one. */
export function livePhase(openNames) {
  let sawRetrieval = false;
  for (const name of openNames) {
    const phase = phaseOf(name);
    if (phase === "subagent") return "subagent";
    if (phase === "retrieval") sawRetrieval = true;
  }
  return sawRetrieval ? "retrieval" : "model";
}
