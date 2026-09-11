// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The side-by-side demo: one question, three arms, every bar drawn while it
// runs.
//
//   Sonnet + grep       lane `stock-explore` - the stock file tools plus the
//                       caller's own Explore subagent. What a developer has
//                       today, with no index.
//   Sonnet + index only lane `hosted-index` - the three retrieval tools the
//                       caller drives itself: `search` against the hosted
//                       index, `find` and `sql` local. No loop of ours.
//   ... + subagents     lane `hosted-full-remote` - the same three plus `ask`
//                       and `explore`, which hand a question to our loop.
//
// The three are the decision the tokenomics work is about, so the page shows
// all three rather than making a reader hold one in their head.
//
// All arms run at once, because side by side is the point. Runs are serialized
// against each other for one reason now, and it is spend rather than
// correctness: three agent runs at a time is enough, and a queue makes a click
// predictable.
//
// Two reasons used to be given here and both have since stopped applying, so
// they are written down rather than left as folklore:
//
//   The ledger. It carries no run id, so two writers against one index dir
//   could not be told apart. That is fixed: each hosted arm gets its own view
//   of the index with its own ledger (`armIndexDir`), and attribution is exact
//   whether or not runs overlap.
//
//   The model pool. The worker admits `ask.max_concurrent_model_calls`
//   sub-agent calls per database and refuses the next with a 429 rather than
//   queueing it; the compiled default is 4 (`shared/src/config.rs`). That is
//   slack today because the caller turns out to issue its sub-agent calls one
//   at a time - measured across 622 recorded runs, no assistant message ever
//   carried two tool calls. It becomes binding the moment the caller does fan
//   out, which is why the serialization stays.
//
//   PORT=7777 node demo/server.mjs
//
// Bind stays on loopback and `tailscale serve` fronts it, so the page is
// reachable on the tailnet and nowhere else.
//
// SPENDING: every question is THREE full agent runs. On the recorded
// 36-question set that is about $0.40 a click - grep $0.24, index-only $0.09,
// subagents $0.08 - and the grep arm alone can run five minutes. DEMO_MAX_RUNS
// caps how many a process will serve before it refuses; there is no way to
// make a click free.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JUDGE_MODEL } from "../bench/judge-core.mjs";
import { checkLaneEnv, runLane, systemPrompt } from "../bench/lanes.mjs";
import { armCost, ledgerMark, ledgerSince, ratesFromEnv } from "./charge.mjs";
import { fixtureArm, isFixture } from "./fixture.mjs";
import { judgeArms, judgeEnabled } from "./judge.mjs";
import { livePhase, phaseOf, phaseSplit } from "./phases.mjs";
import { sourceWindow } from "./source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The two arms, in the order they are drawn. `id` reaches the browser; `lane`
 * is the harness lane that defines the tool surface. */
export const ARMS = [
  { id: "grep", label: "Sonnet + grep", lane: "stock-explore", hosted: false },
  { id: "index", label: "Sonnet + index only", lane: "hosted-index", hosted: true },
  { id: "subagents", label: "Sonnet + index + subagents", lane: "hosted-full-remote", hosted: true },
];

/** The corpora the page can ask about.
 *
 * One is the engine repository the recorded comparison was measured on; the
 * other is an OpenSearch checkout thirty-eight times its file count, which is
 * the regime the recorded numbers do NOT cover — at 450 files a tree walk is
 * nearly free, and grep's cost is a tree walk.
 *
 * `table` is the hosted table each one lives in, because both share a
 * database: the client's table name is a constant that `CX_TABLE` overrides,
 * and a second database is not this key's to create.
 *
 * `ready` says whether the hosted arms can answer for this corpus at all. An
 * incomplete hosted table still answers — with a fraction of the corpus —
 * which is the one failure a demo must not have, so the page says so and the
 * server refuses the hosted arms rather than quietly under-answering.
 */
export const CORPORA = [
  {
    id: "infino",
    label: "infino — the engine, 450 files",
    repo: "/home/ubuntu/infino-ai/workspace/bench-repos/infino-ed4e020",
    index: "/home/ubuntu/infino-ai/workspace/bench-repos/infino-ed4e020/.infino-hosted",
    table: "chunks",
    ready: true,
    // Chosen by the measured gap on the recorded set, not by how they read:
    // 336s to 22s, 270s to 24s, 340s to 78s, 179s to 38s, and one that is
    // near enough even (0.75x on the clock, 1.9x on the bill) kept so the
    // starters are not only wins.
    examples: [
      "Which files have the most code about the full-text-search (FTS) index? Ranked list.",
      "Which files have the most code about the vector index? Ranked list with reasons.",
      "How does incremental indexing work end to end when a file changes?",
      "Where does an append become durable, and what is the last step before other readers can see the new rows?",
      "How does hybrid search combine BM25 and vector results into one ranked list?",
    ],
  },
  {
    id: "opensearch",
    label: "OpenSearch — 17,092 files, 38x",
    repo: "/home/ubuntu/infino-ai/workspace/bench-repos/opensearch-shallow",
    index: "/home/ubuntu/infino-ai/workspace/bench-repos/opensearch-shallow/.infino",
    table: "chunks_opensearch",
    // Loaded whole on 2026-09-11 by a hydrate job from nine NDJSON files
    // staged under the database root: 67,721 chunks across 16,230 files,
    // embedded on the GPU host, one commit per 8,192-row group, then
    // optimized. (Two earlier loads did not get here: one lost its
    // embedding host at 15,872 rows; one committed every row and then
    // dropped the table over a compaction race - see the platform's
    // hydrate and optimizer commits of the same night.)
    ready: true,
    // UNMEASURED. Nothing has been run against this corpus, so unlike the
    // infino starters these carry no recorded gap. They are the SHAPES that
    // separated there — "which files hold the most code about X", a
    // mechanism that spans layers, a write path — because the shape is what
    // makes an agent sweep the tree, and here the tree is 17,092 files.
    examples: [
      "Which files have the most code about query DSL parsing? Ranked list.",
      "Which files have the most code about shard allocation? Ranked list with reasons.",
      "How does a search request travel from the REST layer to the shards and back?",
      "Where does an index write become durable, and what is the last step before a search can see it?",
      "Where is the similarity scoring implemented, and which class computes the score?",
    ],
  },
];

/** The corpus a request names, or the first. */
function corpusFor(id) {
  return CORPORA.find((c) => c.id === id) ?? CORPORA[0];
}

/** Longest question accepted. A question is a prompt to an agent holding Bash
 * on a real checkout, so the box is only as safe as the tailnet around it;
 * this cap is against accident, not against an attacker. */
const MAX_QUESTION_CHARS = 500;

const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.DEMO_HOST ?? "127.0.0.1";
const REPO_DIR = resolve(process.env.CX_BENCH_REPO ?? "/home/ubuntu/infino-ai/workspace/bench-repos/infino-ed4e020");
const INDEX_DIR = resolve(process.env.CX_INDEX_DIR ?? join(REPO_DIR, ".infino-hosted"));
const MAX_RUNS = Number(process.env.DEMO_MAX_RUNS ?? 25);

// The bench's own prompt, imported rather than copied: the demo and the runner
// drive the same lanes, so two copies would be two experiments.
const SYSTEM = systemPrompt(REPO_DIR);

/** The client's ledger file name, the one file a per-arm index view must not
 * share. */
const LEDGER_NAME = "usage.jsonl";

/** A per-arm view of the index: the same data, its own usage ledger.
 *
 * Charge attribution reads the ledger's byte length before an arm runs and
 * parses what was appended after (charge.mjs). That is exact for one writer
 * and wrong for two, and there are now two hosted arms running side by side —
 * each would count the other's retrieval calls as its own. So every hosted arm
 * gets a directory of symlinks to the real index plus a `usage.jsonl` of its
 * own: the arms read the same bytes and meter separately.
 *
 * The links are reconciled on every call rather than created once, because a
 * reindex writes new superfile directories and a view built earlier would
 * quietly serve a stale subset of them.
 */
function armIndexDir(arm, corpus) {
  if (!arm.hosted) return corpus.index;
  const view = `${corpus.index}-${arm.id}`;
  mkdirSync(view, { recursive: true });
  const want = new Set(readdirSync(corpus.index).filter((e) => e !== LEDGER_NAME));
  for (const entry of readdirSync(view)) {
    // The arm's own ledger stays; a link to something no longer in the index
    // goes, so a removed superfile does not linger as a dangling read.
    if (entry === LEDGER_NAME || want.has(entry)) continue;
    unlinkSync(join(view, entry));
  }
  for (const entry of want) {
    const link = join(view, entry);
    try {
      lstatSync(link);
      continue;
    } catch {
      symlinkSync(join(corpus.index, entry), link);
    }
  }
  return view;
}

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

/** Caller tokens the way every published figure counts them: input, output and
 * both cache meters, summed over every model the run used.
 *
 * `row.tokens` is NOT this number. On the two hosted arms the two agree
 * exactly, but on the grep arm `tokens` came out 4.2x smaller across the
 * recorded 36 questions (1,849,999 against 7,799,953) because it misses what
 * the caller's own Explore subagent spent — and grep is the arm that
 * delegates. Printed live it understated one grep run by about a hundredfold:
 * $1.129 of model bill against 10,609 tokens, which would be $106 per million
 * where the arm actually measures $1.10. That flatters grep on the one axis
 * this comparison is about, so the demo sums the usage itself. */
function callerTokens(row) {
  const usage = row.modelUsage;
  if (!usage || typeof usage !== "object") return row.tokens ?? 0;
  let total = 0;
  for (const u of Object.values(usage)) {
    total +=
      (u?.inputTokens ?? 0) +
      (u?.outputTokens ?? 0) +
      (u?.cacheReadInputTokens ?? 0) +
      (u?.cacheCreationInputTokens ?? 0);
  }
  // A run that reported no usage at all keeps the harness's own figure rather
  // than showing a zero that looks like a free question.
  return total > 0 ? total : (row.tokens ?? 0);
}

/** Run one arm, streaming its tool transitions as they happen.
 *
 * `open` tracks the calls in flight so the bar knows what colour its growing
 * edge is right now - which is the whole difference between a bar that fills
 * live and one that appears at the end. */
async function runArm(arm, corpus, question, emit) {
  // The fixture path answers nothing and spends nothing; it exists so the page
  // can be worked on without a model. It returns a row of the same shape, and
  // the split below is computed by the same code, so what it exercises is the
  // real arithmetic over invented spans.
  if (isFixture()) {
    const row = await fixtureArm(arm, emit);
    return {
      row,
      result: {
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
        subagents: (row.entries ?? []).filter((e) => Number.isFinite(e?.agentTurns)).length,
        subagentTurns: (row.entries ?? []).reduce((n, e) => n + (e?.agentTurns ?? 0), 0),
        toolCalls: row.toolCalls,
        durationApiMs: null,
      },
    };
  }

  const indexDir = armIndexDir(arm, corpus);
  const mark = arm.hosted ? ledgerMark(indexDir) : 0;
  const open = new Map();
  emit({ arm: arm.id, kind: "arm_start", label: arm.label, lane: arm.lane, at: 0 });

  const row = await runLane({
    lane: arm.lane,
    prompt: question,
    system: systemPrompt(corpus.repo),
    repoDir: corpus.repo,
    indexDir,
    onEvent: (e) => {
      // A subagent's inner calls sit inside their parent's span, so they must
      // not repaint the bar's growing edge - it would flicker to their colour
      // and back. They are still the most interesting thing the page can show,
      // though: they are what our loop does that grep's does not. So they
      // travel with a flag and the client puts them in the call feed only,
      // never into the bar.
      if (e.inSubagent) {
        emit({ arm: arm.id, kind: e.kind, at: e.at, tool: e.name, inSubagent: true });
        return;
      }
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

  const entries = arm.hosted ? ledgerSince(indexDir, mark) : [];
  // A ledger line carrying `agentTurns` is a loop of ours that ran: one
  // `ask` or `explore`. Counted from the ledger rather than from the tool
  // names, because the ledger is what the platform actually served — and its
  // turn count is what makes a slow subagent legible rather than mysterious.
  const loops = entries.filter((e) => Number.isFinite(e?.agentTurns));
  const subagentTurns = loops.reduce((n, e) => n + e.agentTurns, 0);
  const split = phaseSplit(row);
  const cost = armCost({ costUsd: row.costUsd, entries, rates: ratesFromEnv() });
  // The harness row travels back beside the page's result: the judge needs
  // the queries the run recorded (`toolDetails`), which the page does not.
  return {
    row,
    result: {
      arm: arm.id,
      label: arm.label,
      lane: arm.lane,
      error: row.error ?? null,
      answer: row.answer ?? "",
      wallMs: row.wallMs,
      split,
      cost,
      tokens: callerTokens(row),
      calls: row.calls,
      subagents: loops.length,
      subagentTurns,
      toolCalls: row.toolCalls,
      // The SDK's own view of how much of the run was spent waiting on the
      // model API. An independent check on `split.modelMs`, shown so a reader
      // can see the two agree rather than taking the bar on trust.
      durationApiMs: row.durationApiMs ?? null,
    },
  };
}

/** GET /run?q=... - the whole exchange, as server-sent events. */
async function handleRun(req, res, url) {
  const question = (url.searchParams.get("q") ?? "").trim();
  if (!question) return plain(res, 400, "ask a question: /run?q=...");
  if (question.length > MAX_QUESTION_CHARS) return plain(res, 413, `question over ${MAX_QUESTION_CHARS} characters`);
  if (runsServed >= MAX_RUNS) return plain(res, 429, `this demo has served its ${MAX_RUNS} runs; restart it to serve more`);
  const corpus = corpusFor(url.searchParams.get("corpus"));
  // A corpus whose hosted table is incomplete runs the grep arm only. The
  // index arms would answer from a fraction of it and look like a fair
  // comparison, which is worse than not running them.
  const arms = corpus.ready ? ARMS : ARMS.filter((arm) => !arm.hosted);

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

  // The judge grades the answers once every arm is done: a stronger model,
  // blind to the arms, checking each claim against the repository. Off in
  // fixture mode (there is no model) and with DEMO_JUDGE=0.
  const judgeOn = judgeEnabled() && !isFixture();
  send(res, "queued", {
    arms: arms.map(({ id, label, lane }) => ({ id, label, lane })),
    question,
    corpus: { id: corpus.id, label: corpus.label, ready: corpus.ready, note: corpus.note ?? null },
    fixture: isFixture(),
    judge: judgeOn ? DEFAULT_JUDGE_MODEL : null,
  });

  let results = null;
  // The harness row behind each arm, for the judge: the recorded queries
  // live there and never reach the page.
  const rows = new Map();
  try {
    await serialize(async () => {
      runsServed += 1;
      send(res, "started", { question, run: runsServed, of: MAX_RUNS });
      // The corpus decides which hosted table the client reads. Set for the
      // whole run rather than per arm: the lanes spawn the client as a child
      // process and it takes the table from its environment.
      const previousTable = process.env.CX_TABLE;
      process.env.CX_TABLE = corpus.table;
      // Each arm reports the instant it finishes, in its own `arm_done` frame.
      // The claim of the page is that one arm gets there first, so holding the
      // faster arm's numbers back until the slower one lands hides the only
      // thing a reader came to see - and the bar keeps growing while it waits,
      // which makes the fast arm look exactly as slow as the slow one.
      results = await Promise.all(
        arms.map(async (arm) => {
          const { result, row } = await runArm(arm, corpus, question, guarded);
          rows.set(arm.id, row);
          guarded({ ...result, kind: "arm_done" });
          return result;
        }),
      ).finally(() => {
        if (previousTable === undefined) delete process.env.CX_TABLE;
        else process.env.CX_TABLE = previousTable;
      });
      // `done` no longer carries the rendering. It closes the run and carries
      // the comparison between the arms, which is the one thing that does need
      // both of them - and says whether a verdict is still to come.
      if (alive) send(res, "done", { results, judge: judgeOn ? DEFAULT_JUDGE_MODEL : null });
    });
    // Outside the queue: the judge reads the checkout and the LOCAL index and
    // spends no platform call, so the next question need not wait for it.
    if (judgeOn && alive && results) {
      send(res, "judging", { model: DEFAULT_JUDGE_MODEL });
      const verdict = await judgeArms({ repoDir: corpus.repo, indexDir: corpus.index, question, results, rows });
      if (alive) send(res, "judged", verdict);
    }
  } catch (err) {
    if (alive) send(res, "failed", { error: String(err?.message ?? err).slice(0, 400) });
  }
  res.end();
}

function plain(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${body}\n`);
}

/** GET /source?corpus=&path=&line=&end= - the cited stretch of a file in the
 * chosen corpus's checkout, for the page to show when a citation is clicked.
 * The reading stays inside the checkout (see source.mjs); a refusal comes
 * back as the status it deserves, in plain text. */
function handleSource(res, url) {
  const corpus = corpusFor(url.searchParams.get("corpus"));
  const window = sourceWindow({
    root: corpus.repo,
    rel: url.searchParams.get("path"),
    line: url.searchParams.get("line"),
    end: url.searchParams.get("end") ?? undefined,
  });
  if (!window.ok) return plain(res, window.status, window.error);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ corpus: corpus.id, ...window }));
}

/** What the arms are actually looking at, read from the chosen corpus's own
 * manifest and checkout rather than written down here - a description that
 * drifts from the corpus is worse than none, because a reader would trust it
 * when choosing what to ask. */
function corpus(chosen) {
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(chosen.index, "platform.json"), "utf8"));
  } catch {
    try {
      manifest = JSON.parse(readFileSync(join(chosen.index, "codecontext.json"), "utf8"));
    } catch {
      /* no manifest: the page shows the repo name alone */
    }
  }
  let head = null;
  try {
    head = execFileSync("git", ["log", "-1", "--format=%h %cs %s"], { cwd: chosen.repo, encoding: "utf8" }).trim();
  } catch {
    /* not a checkout, or no git */
  }
  let subsystems = [];
  try {
    subsystems = readdirSync(join(chosen.repo, "src"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    /* no src/ */
  }
  return {
    repo: chosen.repo.split("/").pop(),
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
  if (path === "/source") return handleSource(res, url);
  if (path === "/health") return plain(res, 200, "ok");
  if (path === "/corpus") {
    const chosen = corpusFor(url.searchParams.get("corpus"));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ...corpus(chosen),
        choices: CORPORA.map(({ id, label, ready, note }) => ({ id, label, ready, note: note ?? null })),
        chosen: chosen.id,
        ready: chosen.ready,
        note: chosen.note ?? null,
        // The starters belong to the corpus: infino's name its subsystems,
        // OpenSearch's name its own, and neither set means anything against
        // the other repository.
        examples: chosen.examples ?? [],
      }),
    );
  }
  if (path === "/" || path === "/index.html") {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8");
    // No validator and no directive let the browser cache the page on its own
    // heuristics, so an edit to the bar or the event handling reached a
    // reloading browser only after a hard reload - which is a bad surprise
    // during a demo rather than during development.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
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
