// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Tests for the demo's phase arithmetic and for the harness hooks it leans on.
// Node's built-in runner, matching bench/harness-tests.mjs: these import
// ../bench/lanes.mjs, which needs the agent SDK from bench/node_modules, and
// the root `npm test` (vitest over src/) runs without it.
//
//   cd bench && npm install && cd ../demo && node --test demo-tests.mjs
//
// No model, no network, no index: every stream here is a literal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataSystemPrompt, foldToolMessage, newToolAccounting, systemPrompt } from "../bench/lanes.mjs";
import { ledgerMark, ledgerSince, meteredFrom, ourCharge } from "./charge.mjs";
import { livePhase, phaseOf, phaseShares, phaseSplit, spansOf, unionMs } from "./phases.mjs";

/** One assistant message carrying one tool_use block. */
const call = (id, name, input = {}, parent) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_use", id, name, input }] },
});

/** One assistant message whose blocks the model asked for concurrently. */
const batchCall = (pairs) => ({
  type: "assistant",
  message: { content: pairs.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })) },
});

/** The user message the CLI emits carrying a tool's result. */
const result = (id, text = "ok") => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

// --- classification ---------------------------------------------------------

test("a tool is classified by what it does for the arm, and both arms' retrieval counts as retrieval", () => {
  for (const name of ["Grep", "Glob", "LS", "Bash", "Read", "cx:find", "cx:search", "cx:sql"]) {
    assert.equal(phaseOf(name), "retrieval", name);
  }
  for (const name of ["Agent", "cx:ask", "cx:explore"]) {
    assert.equal(phaseOf(name), "subagent", name);
  }
  // An unknown tool is neither, so it lands in `model` rather than silently
  // inflating retrieval.
  assert.equal(phaseOf("Write"), null);
  assert.equal(phaseOf("mcp__other__thing"), null);
});

// --- the union rule ---------------------------------------------------------

test("overlapping spans are unioned, not summed, so a fan-out cannot exceed the wall clock", () => {
  assert.equal(unionMs([[0, 100]]), 100);
  assert.equal(unionMs([[0, 100], [200, 300]]), 200);
  // three concurrent calls in one batch, 0-100, 10-90, 20-140
  assert.equal(unionMs([[0, 100], [10, 90], [20, 140]]), 140);
  // touching spans merge rather than double-count the boundary
  assert.equal(unionMs([[0, 50], [50, 90]]), 90);
  // unordered input, and a zero-length span contributes nothing
  assert.equal(unionMs([[200, 300], [0, 100], [40, 40]]), 200);
  assert.equal(unionMs([]), 0);
});

test("a concurrent batch of four greps counts once, not four times", () => {
  const toolDetails = [
    { name: "Grep", batch: 0, startedAt: 1000, endedAt: 3000 },
    { name: "Grep", batch: 0, startedAt: 1000, endedAt: 2500 },
    { name: "Grep", batch: 0, startedAt: 1000, endedAt: 2900 },
    { name: "Read", batch: 0, startedAt: 1000, endedAt: 1800 },
  ];
  const split = phaseSplit({ wallMs: 10_000, toolDetails });
  // naive summing would give 8.2 s of retrieval inside a 10 s run
  assert.equal(split.retrievalMs, 2000);
  assert.equal(split.modelMs, 8000);
});

// --- nesting ----------------------------------------------------------------

test("a subagent's own calls are inside its span and are not counted again", () => {
  const toolDetails = [
    { name: "Agent", batch: 0, startedAt: 500, endedAt: 20_500 },
    { name: "Grep", batch: 1, inSubagent: true, startedAt: 1000, endedAt: 4000 },
    { name: "Read", batch: 2, inSubagent: true, startedAt: 4000, endedAt: 9000 },
  ];
  const split = phaseSplit({ wallMs: 25_000, toolDetails });
  assert.equal(split.subagentMs, 20_000);
  assert.equal(split.retrievalMs, 0, "the inner grep is inside the Agent span");
  assert.equal(split.modelMs, 5000);
  assert.equal(split.modelMs + split.retrievalMs + split.subagentMs, 25_000);
});

// --- the split adds up ------------------------------------------------------

test("the three phases sum to the wall clock on a plain sequential run", () => {
  const toolDetails = [
    { name: "cx:search", batch: 0, startedAt: 2000, endedAt: 2200 },
    { name: "cx:explore", batch: 1, startedAt: 5000, endedAt: 30_000 },
    { name: "Read", batch: 2, startedAt: 31_000, endedAt: 31_400 },
  ];
  const split = phaseSplit({ wallMs: 40_000, toolDetails });
  assert.equal(split.retrievalMs, 600);
  assert.equal(split.subagentMs, 25_000);
  assert.equal(split.modelMs, 14_400);
  assert.equal(split.modelMs + split.retrievalMs + split.subagentMs, split.wallMs);
  assert.equal(split.overlapMs, 0);

  const shares = phaseShares(split);
  assert.equal(Math.round((shares.model + shares.retrieval + shares.subagent) * 1000), 1000);
  assert.ok(shares.subagent > shares.retrieval);
});

test("a retrieval overlapping a subagent is reported under both, and model still closes the gap", () => {
  const toolDetails = [
    { name: "Agent", batch: 0, startedAt: 0, endedAt: 6000 },
    { name: "Grep", batch: 0, startedAt: 3000, endedAt: 9000 },
  ];
  const split = phaseSplit({ wallMs: 10_000, toolDetails });
  assert.equal(split.subagentMs, 6000);
  assert.equal(split.retrievalMs, 6000);
  assert.equal(split.toolMs, 9000, "the union of both phases");
  assert.equal(split.overlapMs, 3000);
  // model is wall minus the UNION, so the bar still ends at the wall clock
  assert.equal(split.modelMs, 1000);
});

test("a call still open when the run ends is closed at the wall clock", () => {
  const toolDetails = [{ name: "cx:explore", batch: 0, startedAt: 1000 }];
  assert.deepEqual(spansOf(toolDetails, "subagent", 60_000), [[1000, 60_000]]);
  const split = phaseSplit({ wallMs: 60_000, toolDetails });
  assert.equal(split.subagentMs, 59_000);
  assert.equal(split.modelMs, 1000);
});

test("a run with no tool calls is all model, and a zero-length run does not divide by zero", () => {
  const split = phaseSplit({ wallMs: 4000, toolDetails: [] });
  assert.deepEqual(phaseShares(split), { model: 1, retrieval: 0, subagent: 0 });
  assert.deepEqual(phaseShares(phaseSplit({ wallMs: 0, toolDetails: [] })), { model: 1, retrieval: 0, subagent: 0 });
});

// --- the live edge ----------------------------------------------------------

test("the growing edge of the bar is subagent over retrieval over model", () => {
  assert.equal(livePhase([]), "model");
  assert.equal(livePhase(["Read"]), "retrieval");
  assert.equal(livePhase(["Agent"]), "subagent");
  // a subagent's inner grep is open at the same moment as its Agent call; the
  // outer label is the true one
  assert.equal(livePhase(["Agent", "Grep"]), "subagent");
  assert.equal(livePhase(["Write"]), "model", "an unknown tool does not colour the bar");
});

// --- the harness hooks ------------------------------------------------------

test("foldToolMessage stamps a wall span on every call when a clock is passed, built-ins included", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, call("t1", "Grep", { pattern: "compaction" }), 1000);
  foldToolMessage(acc, result("t1", "src/a.rs:1:compaction"), 4000);
  foldToolMessage(acc, call("t2", "mcp__code-context__search", { query: "how merging works" }), 5000);
  foldToolMessage(acc, result("t2", JSON.stringify({ hits: [], took_ms: 180 })), 5300);

  const [grep, search] = acc.toolDetails;
  assert.deepEqual([grep.startedAt, grep.endedAt], [1000, 4000]);
  assert.equal(grep.tookMs, null, "a built-in has no server-side time - the span is all there is");
  assert.deepEqual([search.startedAt, search.endedAt], [5000, 5300]);
  assert.equal(search.tookMs, 180);

  const split = phaseSplit({ wallMs: 9000, toolDetails: acc.toolDetails });
  assert.equal(split.retrievalMs, 3300);
  assert.equal(split.modelMs, 5700);
});

test("without a clock the details are byte-for-byte what they were, so recorded rows do not move", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, call("t1", "Grep", { pattern: "x" }));
  foldToolMessage(acc, result("t1", "hit"));
  assert.deepEqual(acc.toolDetails, [{ name: "Grep", input: { pattern: "x" }, tookMs: null, usage: null, batch: 0 }]);
});

test("foldToolMessage returns the calls this message started and ended, in stream order", () => {
  const acc = newToolAccounting();
  const opened = foldToolMessage(acc, batchCall([["a", "Grep"], ["b", "Read"]]), 100);
  assert.deepEqual(opened.started.map((d) => d.name), ["Grep", "Read"]);
  assert.deepEqual(opened.ended, []);
  // both blocks came from one message, so they share a batch and ran together
  assert.deepEqual(opened.started.map((d) => d.batch), [0, 0]);

  const closed = foldToolMessage(acc, result("b"), 700);
  assert.deepEqual(closed.started, []);
  assert.deepEqual(closed.ended.map((d) => d.name), ["Read"]);

  // a result for an id nobody opened is ignored rather than invented
  assert.deepEqual(foldToolMessage(acc, result("nope"), 800).ended, []);
});

// --- the prompts ------------------------------------------------------------

test("the code prompt is byte-for-byte the recorded wording, and the data prompt shares its efficiency text", () => {
  // The text every figure since 2026-09-11 was measured under. A change here
  // makes the demo stop showing what the bench measured, so it is pinned.
  assert.equal(
    systemPrompt("/repo"),
    "You answer questions about the repository checked out at /repo. " +
      "Use the available tools to find the answer. Cite file paths (with line ranges when you have them). " +
      "Be efficient: prefer few, well-chosen tool calls, and hand a sweep across many files to a tool " +
      "built for it rather than searching by hand. When two or more calls do not depend on each other, " +
      "issue them in the SAME turn rather than one after another - the wait is then the slowest of them " +
      "instead of their sum.",
  );
  const data = dataSystemPrompt("/rows", "878,682 job postings");
  const efficiency = systemPrompt("/repo").slice(systemPrompt("/repo").indexOf("Be efficient:"));
  assert.ok(data.endsWith(efficiency), "a data run is measured under the same efficiency instructions");
  assert.ok(data.includes("878,682 job postings") && data.includes("/rows"));
  assert.ok(!data.includes("repository checked out"), "records, not a checkout");
});

// --- the charge -------------------------------------------------------------

test("the ledger delta is sliced by BYTE offset, so non-ASCII before the mark does not lose every entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-demo-ledger-"));
  // A prior run's line holding source code, which is where the non-ASCII comes
  // from in the real ledger: box drawing, arrows, accented identifiers.
  const before = JSON.stringify({ tool: "find", query: "let x = \"— ▸ café ✓\";" }) + "\n";
  writeFileSync(join(dir, "usage.jsonl"), before);
  const mark = ledgerMark(dir);
  assert.ok(mark > Buffer.byteLength(before) - 1);
  assert.ok(mark > before.length, "the byte length exceeds the character length, which is the trap");

  // The real entry this test was written from, fractional rtt and all.
  const mine = JSON.stringify({ tool: "explore", agentModelTokens: 155_615, platform: { rttMs: 39_936.724707, readTokens: 32 } }) + "\n";
  writeFileSync(join(dir, "usage.jsonl"), before + mine);

  const entries = ledgerSince(dir, mark);
  assert.equal(entries.length, 1, "slicing the decoded string instead would return nothing");
  assert.equal(entries[0].tool, "explore");
  const metered = meteredFrom(entries);
  assert.deepEqual(metered, { readTokens: 32, modelTokens: 155_615, platformCalls: 1, platformMs: 39_937 });
});

test("a missing ledger meters zero rather than throwing, and the grep arm has no ledger at all", () => {
  assert.equal(ledgerMark("/nonexistent/dir"), 0);
  assert.deepEqual(ledgerSince("/nonexistent/dir", 0), []);
  assert.deepEqual(meteredFrom([]), { readTokens: 0, modelTokens: 0, platformCalls: 0, platformMs: 0 });
});

test("our charge stays in tokens until both rates are given, and never half-prices a bill", () => {
  const metered = { readTokens: 32, modelTokens: 155_615, platformCalls: 1, platformMs: 39_937 };
  const none = ourCharge(metered, { readTokenUsdPerMillion: null, modelTokenUsdPerMillion: null, markup: 0 });
  assert.equal(none.totalUsd, null);
  assert.equal(none.priced, false);

  // One rate is not a bill: a total here would understate it silently.
  const half = ourCharge(metered, { readTokenUsdPerMillion: 50, modelTokenUsdPerMillion: null, markup: 0.3 });
  assert.equal(half.totalUsd, null);
  assert.equal(half.priced, false);

  const both = ourCharge(metered, { readTokenUsdPerMillion: 50, modelTokenUsdPerMillion: 0.2327, markup: 0.3 });
  assert.ok(Math.abs(both.retrievalUsd - 0.0016) < 1e-9);
  // 155,615 tokens at $0.2327/M is $0.03621, plus 30% is $0.04707
  assert.ok(Math.abs(both.inferenceUsd - 0.047073) < 1e-5);
  assert.equal(both.priced, true);
  assert.ok(Math.abs(both.totalUsd - (both.retrievalUsd + both.inferenceUsd)) < 1e-12);
});

test("an end-to-end grep-shaped stream splits the way the bar will draw it", () => {
  const acc = newToolAccounting();
  let at = 0;
  const fold = (m, t) => foldToolMessage(acc, m, (at = t));
  // the model thinks, fans out three greps at once, reads a file, then
  // delegates to its own Explore subagent, which greps inside its span
  fold(batchCall([["g1", "Grep"], ["g2", "Grep"], ["g3", "Glob"]]), 3_000);
  fold(result("g1"), 4_200);
  fold(result("g2"), 4_800);
  fold(result("g3"), 5_100);
  fold(call("r1", "Read"), 6_000);
  fold(result("r1"), 6_400);
  fold(call("a1", "Agent", { subagent_type: "Explore" }), 8_000);
  fold(call("ig", "Grep", {}, "a1"), 9_000);
  fold(result("ig"), 12_000);
  fold(result("a1"), 30_000);

  const split = phaseSplit({ wallMs: 34_000, toolDetails: acc.toolDetails });
  // three concurrent greps span 3.0-5.1 s, the read 6.0-6.4 s
  assert.equal(split.retrievalMs, 2500);
  assert.equal(split.subagentMs, 22_000);
  assert.equal(split.modelMs, 9500);
  assert.equal(split.modelMs + split.retrievalMs + split.subagentMs, 34_000);
  assert.equal(acc.subagentCalls, 1, "the inner grep is counted as a subagent call");
  assert.deepEqual(acc.subagents, ["Explore"]);
  assert.equal(at, 30_000);
});
