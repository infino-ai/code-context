// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The side-by-side demo: one question, two arms, both bars drawn while they
// run.
//
//   Sonnet + grep      lane `stock-explore` - the stock file tools plus the
//                      caller's own Explore subagent. What a developer has
//                      today, with no index.
//   Sonnet + infino    lane `hosted-full-remote` - the same stock tools plus
//                      all five code-context tools, `search` reading the
//                      hosted index and `ask`/`explore` running our loop.
//
// Both arms run at once, because side by side is the point; runs are
// serialized against each other, which is not decoration. Two reasons: the
// worker admits four concurrent model calls per database and refuses the fifth
// outright rather than queueing it, and the client's usage ledger carries no
// run id, so two overlapping runs against one index dir cannot have their
// charge told apart afterwards (see charge.mjs).
//
//   node --experimental-strip-types demo/server.mjs      # not needed; plain JS
//   PORT=7777 node demo/server.mjs
//
// Bind stays on loopback and `tailscale serve` fronts it, so the page is
// reachable on the tailnet and nowhere else.
//
// SPENDING: every question is two full agent runs. On the recorded 36-question
// set that is about $0.32 and can take minutes. DEMO_MAX_RUNS caps how many a
// process will serve before it refuses; there is no way to make a click free.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkLaneEnv, runLane } from "../bench/lanes.mjs";
import { armCost, ledgerMark, ledgerSince, ratesFromEnv } from "./charge.mjs";
import { fixtureArm, isFixture } from "./fixture.mjs";
import { livePhase, phaseOf, phaseSplit } from "./phases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The two arms, in the order they are drawn. `id` reaches the browser; `lane`
 * is the harness lane that defines the tool surface. */
export const ARMS = [
  { id: "grep", label: "Sonnet + grep", lane: "stock-explore", hosted: false },
  { id: "infino", label: "Sonnet + infino", lane: "hosted-full-remote", hosted: true },
];

/** Longest question accepted. A question is a prompt to an agent holding Bash
 * on a real checkout, so the box is only as safe as the tailnet around it;
 * this cap is against accident, not against an attacker. */
const MAX_QUESTION_CHARS = 500;

const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.DEMO_HOST ?? "127.0.0.1";
const REPO_DIR = resolve(process.env.CX_BENCH_REPO ?? "/home/ubuntu/infino-ai/workspace/bench-repos/infino-ed4e020");
const INDEX_DIR = resolve(process.env.CX_INDEX_DIR ?? join(REPO_DIR, ".infino-hosted"));
const MAX_RUNS = Number(process.env.DEMO_MAX_RUNS ?? 25);

const SYSTEM =
  `You answer questions about the repository checked out at ${REPO_DIR}. ` +
  `Use the available tools to find the answer. Cite file paths (with line ranges when you have them). ` +
  `Be efficient: prefer few, well-chosen tool calls.`;

let runsServed = 0;
/** One run at a time, process-wide. A second request waits on this. */
let queue = Promise.resolve();

/** Run `job` once the run before it has finished, so the ledger delta and the
 * platform's model pool both belong to one question at a time. */
function serialize(job) {
  const next = queue.then(job, job);
  // A failed run must not poison the queue for the next one.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** One SSE frame. */
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Run one arm, streaming its tool transitions as they happen.
 *
 * `open` tracks the calls in flight so the bar knows what colour its growing
 * edge is right now - which is the whole difference between a bar that fills
 * live and one that appears at the end. */
async function runArm(arm, question, emit) {
  // The fixture path answers nothing and spends nothing; it exists so the page
  // can be worked on without a model. It returns a row of the same shape, and
  // the split below is computed by the same code, so what it exercises is the
  // real arithmetic over invented spans.
  if (isFixture()) {
    const row = await fixtureArm(arm, emit);
    return {
      arm: arm.id,
      label: arm.label,
      lane: arm.lane,
      fixture: true,
      error: null,
      answer: row.answer,
      wallMs: row.wallMs,
      split: phaseSplit(row),
      cost: armCost({ costUsd: row.costUsd, entries: row.entries, rates: ratesFromEnv() }),
      tokens: row.tokens,
      calls: row.calls,
      toolCalls: row.toolCalls,
      durationApiMs: null,
    };
  }

  const mark = arm.hosted ? ledgerMark(INDEX_DIR) : 0;
  const open = new Map();
  emit({ arm: arm.id, kind: "arm_start", label: arm.label, lane: arm.lane, at: 0 });

  const row = await runLane({
    lane: arm.lane,
    prompt: question,
    system: SYSTEM,
    repoDir: REPO_DIR,
    indexDir: INDEX_DIR,
    onEvent: (e) => {
      // A subagent's inner calls are inside its parent's span; they would
      // repaint the edge with their own colour, so the bar ignores them and
      // keeps the outer label.
      if (e.inSubagent) return;
      const key = `${e.name}#${e.batch}`;
      if (e.kind === "tool_start") open.set(key, (open.get(key) ?? 0) + 1);
      if (e.kind === "tool_end") {
        const n = (open.get(key) ?? 1) - 1;
        if (n > 0) open.set(key, n);
        else open.delete(key);
      }
      const openNames = [];
      for (const [k, n] of open) for (let i = 0; i < n; i += 1) openNames.push(k.split("#")[0]);
      emit({
        arm: arm.id,
        kind: e.kind,
        at: e.at,
        tool: e.name,
        phase: phaseOf(e.name) ?? "model",
        // What the bar should be growing in from this instant until the next
        // event: the outermost phase still open, or model when nothing is.
        nowIn: livePhase(openNames),
        openCalls: openNames.length,
      });
    },
  });

  const entries = arm.hosted ? ledgerSince(INDEX_DIR, mark) : [];
  const split = phaseSplit(row);
  const cost = armCost({ costUsd: row.costUsd, entries, rates: ratesFromEnv() });
  return {
    arm: arm.id,
    label: arm.label,
    lane: arm.lane,
    error: row.error ?? null,
    answer: row.answer ?? "",
    wallMs: row.wallMs,
    split,
    cost,
    tokens: row.tokens,
    calls: row.calls,
    toolCalls: row.toolCalls,
    // The SDK's own view of how much of the run was spent waiting on the model
    // API. An independent check on `split.modelMs`, shown so a reader can see
    // the two agree rather than taking the bar on trust.
    durationApiMs: row.durationApiMs ?? null,
  };
}

/** GET /run?q=... - the whole exchange, as server-sent events. */
async function handleRun(req, res, url) {
  const question = (url.searchParams.get("q") ?? "").trim();
  if (!question) return plain(res, 400, "ask a question: /run?q=...");
  if (question.length > MAX_QUESTION_CHARS) return plain(res, 413, `question over ${MAX_QUESTION_CHARS} characters`);
  if (runsServed >= MAX_RUNS) return plain(res, 429, `this demo has served its ${MAX_RUNS} runs; restart it to serve more`);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const emit = (data) => send(res, data.kind, data);
  let alive = true;
  req.on("close", () => {
    alive = false;
  });
  // The model keeps running if the reader leaves - the spend is already
  // committed - but nothing is written to a closed socket.
  const guarded = (data) => {
    if (alive) emit(data);
  };

  send(res, "queued", { arms: ARMS.map(({ id, label, lane }) => ({ id, label, lane })), question, fixture: isFixture() });

  try {
    await serialize(async () => {
      runsServed += 1;
      send(res, "started", { question, run: runsServed, of: MAX_RUNS });
      const results = await Promise.all(ARMS.map((arm) => runArm(arm, question, guarded)));
      if (alive) send(res, "done", { results });
    });
  } catch (err) {
    if (alive) send(res, "failed", { error: String(err?.message ?? err).slice(0, 400) });
  }
  res.end();
}

function plain(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${body}\n`);
}

/** What the two arms are actually looking at, read from the index's own
 * manifest and the checkout rather than written down here - a description that
 * drifts from the corpus is worse than none, because a reader would trust it
 * when choosing what to ask. */
function corpus() {
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(INDEX_DIR, "platform.json"), "utf8"));
  } catch {
    try {
      manifest = JSON.parse(readFileSync(join(INDEX_DIR, "codecontext.json"), "utf8"));
    } catch {
      /* no manifest: the page shows the repo name alone */
    }
  }
  let head = null;
  try {
    head = execFileSync("git", ["log", "-1", "--format=%h %cs %s"], { cwd: REPO_DIR, encoding: "utf8" }).trim();
  } catch {
    /* not a checkout, or no git */
  }
  let subsystems = [];
  try {
    subsystems = readdirSync(join(REPO_DIR, "src"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    /* no src/ */
  }
  return {
    repo: REPO_DIR.split("/").pop(),
    files: manifest.files ?? null,
    chunks: manifest.chunks ?? null,
    vectors: manifest.vectors ?? null,
    analyzer: manifest.analyzer ?? null,
    indexedAt: manifest.indexedAt ?? null,
    hosted: manifest.origin === "hosted",
    head,
    subsystems,
  };
}

/** Every path this server answers, with an optional mount prefix stripped.
 *
 * `tailscale serve --set-path /demo` puts the page under a prefix, and whether
 * it strips that prefix before proxying is not something the CLI's help says.
 * Rather than find out the hard way on someone else's browser, accept both
 * shapes: `/demo/run` and `/run` reach the same handler. DEMO_BASE_PATH names
 * the prefix; without it only the bare paths are served, which is what a
 * dedicated port gives. */
const BASE_PATH = (process.env.DEMO_BASE_PATH ?? "").replace(/\/+$/, "");

function route(pathname) {
  if (BASE_PATH && pathname === BASE_PATH) return "/";
  if (BASE_PATH && pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return pathname;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = route(url.pathname);
  if (path === "/run") return handleRun(req, res, url);
  if (path === "/health") return plain(res, 200, "ok");
  if (path === "/corpus") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(corpus()));
  }
  if (path === "/" || path === "/index.html") {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  return plain(res, 404, "not found");
});

// Fail before the page loads, not on the first click, if the hosted arm has no
// database or key - the same discipline `checkLaneEnv` gives the bench. The
// fixture reaches neither the platform nor a model, so it needs neither.
if (!isFixture()) for (const arm of ARMS) checkLaneEnv(arm.lane);

server.listen(PORT, HOST, () => {
  const rates = ratesFromEnv();
  console.log(`demo on http://${HOST}:${PORT}`);
  console.log(`  repo   ${REPO_DIR}`);
  console.log(`  index  ${INDEX_DIR}`);
  console.log(`  arms   ${ARMS.map((a) => `${a.id} (${a.lane})`).join("  vs  ")}`);
  console.log(`  budget ${MAX_RUNS} runs, one at a time`);
  if (isFixture()) console.log("  FIXTURE MODE - invented data, no model runs, nothing here is a result");
  console.log(
    rates.readTokenUsdPerMillion === null || rates.modelTokenUsdPerMillion === null
      ? "  rates  unset - our charge shows metered tokens, no dollars"
      : `  rates  read $${rates.readTokenUsdPerMillion}/M, inference $${rates.modelTokenUsdPerMillion}/M +${Math.round(rates.markup * 100)}%`,
  );
});
