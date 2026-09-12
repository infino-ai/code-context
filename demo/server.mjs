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
// All arms run at once, because side by side is the point, and so do RUNS:
// nothing is queued. The page is a link several people hold at once, and a
// queue meant the second reader's question sat behind the first reader's grep
// arm, which can take five minutes - one reader's click made the demo look
// broken to everyone else (owner, 2026-09-12: "you might have several
// different users running the demo at the same time").
//
// What concurrency costs, and how each is paid:
//
//   The ledger. Charge attribution is a byte offset into one file, exact for
//   one writer and wrong for two. Every arm of every run now reads through its
//   own view of the index with its own ledger (`armIndexDir`, keyed by run as
//   well as arm), removed when the run ends.
//
//   The table. `CX_TABLE` names the hosted table the client reads and used to
//   be set on `process.env` for the length of a run - one variable, shared by
//   every run in flight, so two readers on different corpora would race and
//   the loser's agents would answer from the winner's table. It travels on the
//   run's own server environment now (`runLane`'s `serverEnv`).
//
//   The model pool. The worker admits `ask.max_concurrent_model_calls`
//   sub-agent calls per database and refuses the next with a 429 rather than
//   queueing it; the compiled default is 4 (`shared/src/config.rs`). One run
//   issues its sub-agent calls one at a time - measured across 622 recorded
//   runs, no assistant message ever carried two tool calls - so the ceiling is
//   four concurrent readers on the subagents arm, and the fifth sees a 429 in
//   that arm alone. Raising it is a platform config change, not a demo one.
//
//   The spend. Concurrent runs spend concurrently, and there is no cap.
//
//   PORT=7777 node demo/server.mjs
//
// Bind stays on loopback and `tailscale serve` fronts it, so the page is
// reachable on the tailnet and nowhere else.
//
// SPENDING: every question is THREE full agent runs. On the recorded
// 36-question set that is about $0.40 a click - grep $0.24, index-only $0.09,
// subagents $0.08 - and the grep arm alone can run five minutes. There is no
// run budget: the tailnet is the whole of the access control, so whoever holds
// the link spends, and nothing here makes a click free. A 25-run cap used to
// stand here; it refused the owner's own demo mid-session while reporting
// nothing a reader could act on, and he had it removed (2026-09-12).

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JUDGE_MODEL } from "../bench/judge-core.mjs";
import { checkLaneEnv, dataSystemPrompt, runLane, systemPrompt } from "../bench/lanes.mjs";
import { armCost, ledgerMark, ledgerSince, ratesFromEnv } from "./charge.mjs";
import { fixtureArm, isFixture } from "./fixture.mjs";
import { judgeArms, judgeEnabled } from "./judge.mjs";
import { livePhase, phaseOf, phaseSplit } from "./phases.mjs";
import { sourceWindow } from "./source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The arms, in the order they are drawn. `id` reaches the browser; `lane`
 * is the harness lane that defines the tool surface.
 *
 * The ids are the internal names and stay as they are - `grep` is the
 * baseline everything is read against, in the results, the fixture and the
 * page's own rules - while the LABELS are what a reader sees and name the
 * products rather than the mechanism. */
export const ARMS = [
  { id: "grep", label: "Sonnet + File Tools", lane: "stock-explore", hosted: false },
  { id: "index", label: "Sonnet + Infino", lane: "hosted-index", hosted: true },
  { id: "subagents", label: "Sonnet + Infino Subagents", lane: "hosted-full-remote", hosted: true },
];

/** The job-postings corpus on disk: the same rows the hosted table holds, as
 * NDJSON the file-tools arm can grep (see its CLAUDE.md for the layout). */
const JOBS_DIR = "/home/ubuntu/infino-ai/workspace/bench-repos/jobs-ndjson";

/** The corpora the page can ask about.
 *
 * One is the engine repository the recorded comparison was measured on; the
 * other is an OpenSearch checkout thirty-eight times its file count, which is
 * the regime the recorded numbers do NOT cover — at 450 files a tree walk is
 * nearly free, and grep's cost is a tree walk. The third is not code at all:
 * 878,682 job postings, a table whose questions are counts, rankings and "who
 * is hiring for X" — sweeps over rows rather than files.
 *
 * `table` is the hosted table each one lives in, because all share a
 * database: the client's table name is a constant that `CX_TABLE` overrides,
 * and a second database is not this key's to create.
 *
 * `ready` says whether the hosted arms can answer for this corpus at all. An
 * incomplete hosted table still answers — with a fraction of the corpus —
 * which is the one failure a demo must not have, so the page says so and the
 * server refuses the hosted arms rather than quietly under-answering.
 *
 * `kind` is "code" unless said otherwise; a "data" corpus gets its own system
 * prompt (`system`, records rather than a checkout), its own paragraph on the
 * page (`how`), a row count (`rows`) in place of a file count, and no judge
 * (`judge: false`): the judge verifies claims against a checkout with the
 * code-grain rules of bench/judge-core.mjs, which say nothing about a row.
 */
export const CORPORA = [
  {
    id: "infino",
    label: "infino — the engine, 450 files",
    name: "infino",
    blurb:
      "The engine repository: a retrieval engine that stores data on object storage and runs SQL, " +
      "full-text search and vector search over it. One file (a \"superfile\") is a valid Parquet file " +
      "with BM25 and vector indexes spliced in; the supertable layer composes many superfiles into a " +
      "queryable table with snapshot-isolated reads and an atomic-commit manifest.",
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
    name: "OpenSearch",
    blurb:
      "The search engine: a distributed search and analytics engine in Java. A REST layer takes a " +
      "query, the coordinating node fans it out to the shards that hold the data, each shard scores " +
      "its own segments with Lucene, and the results are merged back. Thirty-eight times the engine " +
      "repository's file count, which is the point - it is the size at which sweeping the tree stops " +
      "being free.",
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
  {
    id: "jobs",
    label: "job postings — 284,622 postings in 878,682 daily rows, Ashby · Greenhouse · Lever",
    name: "job postings",
    kind: "data",
    blurb:
      "284,622 job postings from three applicant-tracking systems — Ashby, Greenhouse and Lever — as daily " +
      "snapshots taken 8–11 September 2026 (the open-apply-jobs dataset): 878,682 rows, a posting appearing " +
      "once per day it was open. Every column is carried: the title, the whole description as HTML, employer, " +
      "department, locations, remote flag, posting dates, salary range and currency, and the apply link.",
    how:
      "Every arm sees the same 878,682 rows. The File Tools arm reads them off disk — one posting per line " +
      "as JSON, 250 lines per file, 6.4 GB — with Grep, Glob and Read; the others query an Infino table of " +
      "the same rows, full-text indexed on the title and the description and with a vector index over the " +
      "titles. A question that spans many postings — a count, a ranking, who is hiring for what — is where " +
      "they diverge; a question about one named posting usually comes out level.",
    repo: JOBS_DIR,
    index: join(JOBS_DIR, ".infino-hosted"),
    table: "chunks_jobs",
    rows: 878_682,
    // Measured on the loaded table (COUNT(DISTINCT id), 0.77 s): the daily
    // snapshots repeat an open posting, so a count that means postings has to
    // dedupe by id. The page says both numbers for that reason.
    postings: 284_622,
    // Loaded whole on 2026-09-11 by a hydrate job straight from the ten
    // parquet shards staged under the database root: every column, full-text
    // on title and description_html (inferred), the vector column from the
    // title alone — the full descriptions embed at 4.5 texts/s on the GPU
    // host, which is 54 hours for this many rows; titles take minutes.
    ready: true,
    judge: false,
    system: dataSystemPrompt(
      JOBS_DIR,
      "284,622 job postings from Ashby, Greenhouse and Lever, held as 878,682 rows of daily snapshots " +
        "(a posting repeats once per day it was open, so count postings by distinct id; columns: title, " +
        "description, employer, department, locations, salary, dates)",
    ),
    // UNMEASURED, like the OpenSearch starters. They are the shapes a
    // recruiting product asks - who is hiring for what, where, at what pay -
    // each a sweep over hundreds of thousands of rows, which is the regime the
    // comparison is about.
    examples: [
      "Which employers have the most open machine learning engineer roles, and where are they hiring? Ranked list.",
      "How many postings are remote, and which departments have the highest share of remote roles?",
      "What salary ranges do entry-level or new-grad software engineering postings list, and which employers pay the most?",
      "Which companies are hiring for GPU or CUDA experience, and what do those roles ask for?",
      "Which postings mention a security clearance, and which departments and locations do they cluster in?",
    ],
  },
];

/** The corpus a request names, or the first. */
function corpusFor(id) {
  return CORPORA.find((c) => c.id === id) ?? CORPORA[0];
}

/** The arms a corpus runs. A corpus whose hosted table is incomplete runs the
 * grep arm only: the index arms would answer from a fraction of it and look
 * like a fair comparison, which is worse than not running them. A corpus may
 * also name its arms (`arms`) and give an arm a different lane (`lanes`). */
function armsFor(corpus) {
  const ready = corpus.ready ? ARMS : ARMS.filter((arm) => !arm.hosted);
  return ready
    .filter((arm) => !corpus.arms || corpus.arms.includes(arm.id))
    .map((arm) => (corpus.lanes?.[arm.id] ? { ...arm, lane: corpus.lanes[arm.id] } : arm));
}

/** Longest question accepted. A question is a prompt to an agent holding Bash
 * on a real checkout, so the box is only as safe as the tailnet around it;
 * this cap is against accident, not against an attacker. */
const MAX_QUESTION_CHARS = 500;

const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.DEMO_HOST ?? "127.0.0.1";
const REPO_DIR = resolve(process.env.CX_BENCH_REPO ?? "/home/ubuntu/infino-ai/workspace/bench-repos/infino-ed4e020");
const INDEX_DIR = resolve(process.env.CX_INDEX_DIR ?? join(REPO_DIR, ".infino-hosted"));

// A demo run must never build an index. The client's first `find`/`sql`/`ask`
// on an index dir without a manifest builds one from the checkout — and with
// a platform database configured that build DROPS and recreates the hosted
// table named CX_TABLE (indexer `loadPlatform`). Every corpus here is indexed
// before the page is up, so auto-index has nothing legitimate to do and one
// missing manifest would otherwise cost a table. The lanes spread this env
// into the client they spawn.
process.env.CX_AUTO_INDEX = "0";

// The bench's own prompt, imported rather than copied: the demo and the runner
// drive the same lanes, so two copies would be two experiments.
const SYSTEM = systemPrompt(REPO_DIR);

/** The client's ledger file name, the one file a per-arm index view must not
 * share. */
const LEDGER_NAME = "usage.jsonl";

/** A per-arm, per-RUN view of the index: the same data, its own usage ledger.
 *
 * Charge attribution reads the ledger's byte length before an arm runs and
 * parses what was appended after (charge.mjs). That is exact for one writer
 * and wrong for two. Two hosted arms run side by side within a question, and
 * since runs stopped being serialized two readers can ask the same question
 * of the same corpus at once — so the view is per run as well as per arm, or
 * one reader's charge would carry the other's retrieval calls.
 *
 * The links are reconciled on every call rather than created once, because a
 * reindex writes new superfile directories and a view built earlier would
 * quietly serve a stale subset of them. `dropIndexView` removes the run's
 * directory afterwards; the links are the only thing in it besides the
 * ledger, and the ledger has been read by then.
 */
function armIndexDir(arm, corpus, runId) {
  if (!arm.hosted) return corpus.index;
  const view = `${corpus.index}-${arm.id}-r${runId}`;
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

/** Remove a run's index views. Best-effort: a view left behind is a few dead
 * symlinks and a spent ledger, which costs nothing but tidiness, and a run
 * must not fail on its own cleanup. */
function dropIndexViews(arms, corpus, runId) {
  for (const arm of arms) {
    if (!arm.hosted) continue;
    rmSync(`${corpus.index}-${arm.id}-r${runId}`, { recursive: true, force: true });
  }
}

/** Runs this process has served: the status line's number, and the id that
 * keeps concurrent runs' ledgers apart. */
let runsServed = 0;

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
async function runArm(arm, corpus, question, emit, runId) {
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

  const indexDir = armIndexDir(arm, corpus, runId);
  const mark = arm.hosted ? ledgerMark(indexDir) : 0;
  const open = new Map();
  emit({ arm: arm.id, kind: "arm_start", label: arm.label, lane: arm.lane, at: 0 });

  const row = await runLane({
    lane: arm.lane,
    prompt: question,
    // A data corpus carries its own prompt (records, not a checkout); a code
    // corpus gets the bench's, so its runs stay comparable with the runner's.
    system: corpus.system ?? systemPrompt(corpus.repo),
    repoDir: corpus.repo,
    indexDir,
    // The corpus decides which hosted table the client reads. It travels on
    // the run's own server environment rather than through `process.env`,
    // which is one variable shared by every run in flight: two readers asking
    // about different corpora at the same moment would each set it and the
    // loser's agents would answer from the winner's table - a wrong answer
    // that looks exactly like a right one.
    serverEnv: { CX_TABLE: corpus.table },
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
  // Refused as an SSE `failed` frame rather than a status code, because the
  // page reads this endpoint with an EventSource: a browser hands a non-200
  // to `onerror` with no status and no body, so the reason - the one thing
  // that says what to do about it - reached nobody and the page said
  // "Connection closed." for a server that was healthy and deliberate.
  if (!question) return refuse(res, "ask a question: /run?q=...");
  if (question.length > MAX_QUESTION_CHARS) return refuse(res, `question over ${MAX_QUESTION_CHARS} characters`);
  const corpus = corpusFor(url.searchParams.get("corpus"));
  const arms = armsFor(corpus);

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
  // fixture mode (there is no model), with DEMO_JUDGE=0, and for a corpus
  // that says so - a data corpus has no checkout for the code-grain rules to
  // verify against.
  const judgeOn = judgeEnabled() && !isFixture() && corpus.judge !== false;
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
  const runId = (runsServed += 1);
  try {
    send(res, "started", { question, run: runId });
    // Each arm reports the instant it finishes, in its own `arm_done` frame.
    // The claim of the page is that one arm gets there first, so holding the
    // faster arm's numbers back until the slower one lands hides the only
    // thing a reader came to see - and the bar keeps growing while it waits,
    // which makes the fast arm look exactly as slow as the slow one.
    results = await Promise.all(
      arms.map(async (arm) => {
        const { result, row } = await runArm(arm, corpus, question, guarded, runId);
        rows.set(arm.id, row);
        guarded({ ...result, kind: "arm_done" });
        return result;
      }),
    ).finally(() => dropIndexViews(arms, corpus, runId));
    // `done` no longer carries the rendering. It closes the run and carries
    // the comparison between the arms, which is the one thing that does need
    // both of them - and says whether a verdict is still to come.
    if (alive) send(res, "done", { results, judge: judgeOn ? DEFAULT_JUDGE_MODEL : null });
    // The judge reads the checkout and the LOCAL index and spends no platform
    // call, so it is outside everything the arms' numbers are drawn from.
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

/** Refuse a run with a reason the page can show: one SSE `failed` frame on a
 * 200, because a browser's EventSource reports a non-200 as an error with no
 * status and no body, and the page then says only "Connection closed.". */
function refuse(res, error) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
  send(res, "failed", { error });
  res.end();
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
/** The hosted database the arms query, from the same env the lanes read, for
 * the server's own read-only checks. `null` in fixture mode or a local-only
 * setup, where the checks are skipped and the local manifest stands. */
const HOSTED = (() => {
  const dbUrl = process.env.CX_BENCH_DB_URL;
  const keyFile = process.env.CX_BENCH_KEY_FILE;
  if (!dbUrl || !keyFile) return null;
  try {
    const key = readFileSync(keyFile, "utf8").trim();
    if (!key) return null;
    return { base: dbUrl.replace(/\/[^/]*$/, ""), database: dbUrl.slice(dbUrl.lastIndexOf("/") + 1), key };
  } catch {
    return null;
  }
})();

/** The hosted `table`'s schema - its fields as the platform reports them - or
 * null when it cannot be reached. Cached per table so the dropdown does not
 * re-ask the platform on every change; best-effort, because a corpus fact is
 * not worth failing the page over. */
const hostedSchemaCache = new Map();
async function hostedSchema(table) {
  if (!HOSTED || !table) return null;
  if (hostedSchemaCache.has(table)) return hostedSchemaCache.get(table);
  let fields = null;
  try {
    const r = await fetch(`${HOSTED.base}/v1/schema/${HOSTED.database}`, {
      method: "POST",
      headers: { authorization: `Bearer ${HOSTED.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ table_name: table }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const parsed = await r.json();
      if (Array.isArray(parsed)) fields = parsed;
    }
  } catch {
    /* platform slow or down: the local manifest's answer stands */
  }
  hostedSchemaCache.set(table, fields);
  return fields;
}

/** Whether the hosted `table` carries a vector column - the index the Infino
 * arm's `search` actually uses. "ready" / "none", or null when the schema
 * cannot be reached, in which case the caller keeps the local manifest's
 * answer. */
async function hostedVectors(table) {
  const fields = await hostedSchema(table);
  if (!fields) return null;
  return fields.some((f) => f?.type === "embedding") ? "ready" : "none";
}

/** The hosted `table`'s column names, the vector column left out - what a
 * reader of a data corpus needs in order to ask about it. Null when the
 * schema cannot be reached. */
async function hostedColumns(table) {
  const fields = await hostedSchema(table);
  if (!fields) return null;
  return fields.filter((f) => f?.type !== "embedding" && typeof f?.name === "string").map((f) => f.name);
}

async function corpus(chosen) {
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
  // For a hosted corpus the vectors that matter are the HOSTED table's - the
  // index the Infino arm searches - not the local build. A large corpus's
  // local index is built keyword-only (embedding tens of thousands of files
  // locally is not done), so it reported "none" while the hosted table,
  // embedded at hydrate, has them: OpenSearch showed "vectors none" though
  // its `search` runs over a vector index.
  const hostedVec = chosen.ready ? await hostedVectors(chosen.table) : null;
  const data = chosen.kind === "data";
  return {
    repo: chosen.repo.split("/").pop(),
    // The page used to carry one hard-coded paragraph about infino and show
    // it whatever corpus was chosen, so a reader asking about OpenSearch was
    // told they were asking about the engine.
    name: chosen.name ?? chosen.label,
    blurb: chosen.blurb ?? "",
    kind: chosen.kind ?? "code",
    // The corpus's own account of what each arm reads; absent, the page keeps
    // its paragraph about a checkout, which is true of every code corpus.
    how: chosen.how ?? null,
    // A data corpus is rows, not files: the file count here would be the
    // number of NDJSON shards the grep arm sweeps, which says nothing a
    // reader wants to know, and its "chunks" are its rows.
    files: data ? null : (manifest.files ?? null),
    chunks: data ? null : (manifest.chunks ?? null),
    rows: chosen.rows ?? null,
    postings: chosen.postings ?? null,
    columns: data && chosen.ready ? await hostedColumns(chosen.table) : null,
    vectors: hostedVec ?? manifest.vectors ?? null,
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
        ...(await corpus(chosen)),
        // `name` is what the selector shows: the line above it already says
        // what the corpus is and how big, so the option repeating that in
        // prose was two descriptions of one thing. `label` stays for callers
        // that want the long form.
        choices: CORPORA.map(({ id, name, label, ready, note }) => ({ id, name: name ?? label, label, ready, note: note ?? null })),
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
if (!isFixture()) {
  for (const arm of ARMS) checkLaneEnv(arm.lane);
  for (const c of CORPORA) for (const lane of Object.values(c.lanes ?? {})) checkLaneEnv(lane);
}

server.listen(PORT, HOST, () => {
  const rates = ratesFromEnv();
  console.log(`demo on http://${HOST}:${PORT}`);
  console.log(`  repo   ${REPO_DIR}`);
  console.log(`  index  ${INDEX_DIR}`);
  console.log(`  arms   ${ARMS.map((a) => `${a.id} (${a.lane})`).join("  vs  ")}`);
  console.log("  runs   unlimited, one at a time - every click spends");
  if (isFixture()) console.log("  FIXTURE MODE - invented data, no model runs, nothing here is a result");
  console.log(
    rates.readTokenUsdPerMillion === null || rates.modelTokenUsdPerMillion === null
      ? "  rates  unset - our charge shows metered tokens, no dollars"
      : `  rates  read $${rates.readTokenUsdPerMillion}/M, inference $${rates.modelTokenUsdPerMillion}/M +${Math.round(rates.markup * 100)}%`,
  );
});
