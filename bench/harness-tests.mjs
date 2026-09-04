// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Tests for the harness's own logic - the lane table, the SDK tool-result
// parsing, the hosted warm-up loop and the build record - with no model, no
// network and no engine: fetch and spawn are injected. Node's built-in runner
// rather than vitest on purpose: these import lanes.mjs, which needs the
// agent SDK from bench/node_modules, and the root `npm test` (vitest, which
// would pick up any *.test.* file under bench/) runs without bench's deps.
//   cd bench && npm install && node --test harness-tests.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANES,
  laneDef,
  laneOptions,
  checkLaneEnv,
  dbHost,
  foldToolMessage,
  newToolAccounting,
  toolResultText,
  parseCxResult,
  cxTookMs,
} from "./lanes.mjs";
import { warmHosted, splitDbUrl, DEFAULT_RETRY_AFTER_SECS } from "./warm-hosted.mjs";
import { indexArgs, runIndexBuild, hostOf } from "./load-hosted.mjs";

const FAKE_URL = "https://api.example.test/bench-db";
const FAKE_KEY = "inf_secret_value_that_must_not_leak";

/** Run fn with the hosted env set, restoring whatever was there before. */
function withHostedEnv(fn, extra = {}) {
  const saved = {};
  const set = { CX_DB_URL: FAKE_URL, INFINO_API_KEY: FAKE_KEY, ...extra };
  for (const k of [...Object.keys(set), "CX_EMBED_PROVIDER"]) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- lane table ---------------------------------------------------------------

test("the lane table names exactly the five lanes and an unknown lane throws", () => {
  assert.deepEqual(Object.keys(LANES).sort(), ["combo", "cx", "files", "hosted", "hosted-agent"]);
  assert.throws(() => laneDef("cobmo"), /unknown lane "cobmo"/);
  assert.throws(() => laneOptions("cobmo", "/r", "/r/.infino"), /unknown lane/);
});

test("files has the stock tools and no server; cx has Read only", () => {
  const files = laneOptions("files", "/r", "/r/.infino");
  assert.deepEqual(files.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
  assert.equal(files.mcpServers, undefined);
  assert.equal(files.settingSources.length, 0);
  assert.equal(files.strictMcpConfig, true);
  const cx = laneOptions("cx", "/r", "/r/.infino");
  assert.deepEqual(cx.tools, ["Read"]);
  assert.equal(cx.mcpServers["code-context"].env.CX_AUTO_SYNC, "0");
  assert.equal(cx.mcpServers["code-context"].env.CX_ROOT, "/r");
  assert.equal(cx.mcpServers["code-context"].alwaysLoad, true);
});

test("combo and hosted share the built-in tools; hosted adds the platform env", () => {
  withHostedEnv(() => {
    const combo = laneOptions("combo", "/r", "/r/.infino");
    const hosted = laneOptions("hosted", "/r", "/r/.infino");
    assert.deepEqual(hosted.tools, combo.tools);
    const env = hosted.mcpServers["code-context"].env;
    assert.equal(env.CX_DB_URL, FAKE_URL);
    assert.equal(env.INFINO_API_KEY, FAKE_KEY);
    assert.equal(env.CX_AUTO_INDEX, "0");
    assert.equal(env.CX_AUTO_SYNC, "0");
    assert.equal(env.CX_EMBED_PROVIDER, "local");
    assert.equal(env.CX_RETRIEVAL_AGENT, undefined);
    assert.equal(combo.mcpServers["code-context"].env.CX_AUTO_INDEX, undefined);
  }, { CX_EMBED_PROVIDER: undefined });
});

test("CX_EMBED_PROVIDER passes through when set; hosted-agent adds CX_RETRIEVAL_AGENT", () => {
  withHostedEnv(() => {
    const env = laneOptions("hosted-agent", "/r", "/r/.infino").mcpServers["code-context"].env;
    assert.equal(env.CX_EMBED_PROVIDER, "openai");
    assert.equal(env.CX_RETRIEVAL_AGENT, "1");
    assert.equal(env.CX_DB_URL, FAKE_URL);
  }, { CX_EMBED_PROVIDER: "openai" });
});

test("a hosted lane without its env fails fast, naming the variables and never the key", () => {
  assert.throws(() => checkLaneEnv("hosted", {}), /needs CX_DB_URL and INFINO_API_KEY/);
  assert.throws(() => checkLaneEnv("hosted-agent", { CX_DB_URL: FAKE_URL }), /needs INFINO_API_KEY .*it is not set/);
  try {
    checkLaneEnv("hosted", { CX_DB_URL: FAKE_URL });
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.message.includes(FAKE_KEY), false);
  }
  assert.doesNotThrow(() => checkLaneEnv("hosted", { CX_DB_URL: FAKE_URL, INFINO_API_KEY: FAKE_KEY }));
  assert.doesNotThrow(() => checkLaneEnv("files", {}));
  withHostedEnv(() => assert.throws(() => laneOptions("hosted", "/r", "/r/.infino"), /INFINO_API_KEY/), { INFINO_API_KEY: undefined });
});

test("dbHost is the host only, and null for local lanes", () => {
  const env = { CX_DB_URL: FAKE_URL, INFINO_API_KEY: FAKE_KEY };
  assert.equal(dbHost("hosted", env), "api.example.test");
  assert.equal(dbHost("hosted-agent", env), "api.example.test");
  assert.equal(dbHost("combo", env), null);
  assert.equal(dbHost("hosted", {}), null);
  assert.equal(dbHost("hosted", { CX_DB_URL: "not a url" }), null);
});

// --- tool-result parsing ----------------------------------------------------

const cxResult = { hits: [], took_ms: 12.5, usage: "returned ~300 tokens | 2 chunks / 2 files | invoked 1x this session (~300 tokens total)" };
const assistantCall = (id, name) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const userResult = (id, content, toolUseResult, isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
});

test("toolResultText prefers the structured MCP output and falls back to the block", () => {
  const structured = { content: [{ type: "text", text: "A" }] };
  assert.equal(toolResultText({ content: "B" }, structured), "A");
  assert.equal(toolResultText({ content: "B" }, undefined), "B");
  assert.equal(toolResultText({ content: [{ type: "text", text: "C" }, { type: "text", text: "D" }] }, null), "C\nD");
  assert.equal(toolResultText({ content: [{ type: "image" }] }, undefined), null);
  assert.equal(toolResultText({}, undefined), null);
});

test("parseCxResult reads took_ms and the usage receipt and tolerates non-JSON", () => {
  assert.deepEqual(parseCxResult(JSON.stringify(cxResult)), { tookMs: 12.5, usage: cxResult.usage });
  assert.deepEqual(parseCxResult("search failed: no index"), { tookMs: null, usage: null });
  assert.deepEqual(parseCxResult(JSON.stringify({ rows: [] })), { tookMs: null, usage: null });
  assert.deepEqual(parseCxResult(null), { tookMs: null, usage: null });
});

test("foldToolMessage joins tool_use to tool_result by id and records cx telemetry only", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, assistantCall("t1", "mcp__code-context__search"));
  foldToolMessage(acc, assistantCall("t2", "Read"));
  foldToolMessage(acc, assistantCall("t3", "mcp__code-context__sql"));
  // t1 arrives with the structured output; t3 with only the block text; t2 is a built-in
  foldToolMessage(acc, userResult("t1", "ignored", { content: [{ type: "text", text: JSON.stringify(cxResult) }] }));
  foldToolMessage(acc, userResult("t2", "file contents"));
  foldToolMessage(acc, userResult("t3", JSON.stringify({ rows: [], took_ms: 7.5, usage: "returned ~10 tokens | 0 rows" })));
  assert.deepEqual(acc.toolCalls, ["cx:search", "Read", "cx:sql"]);
  assert.deepEqual(acc.toolDetails, [
    { name: "cx:search", tookMs: 12.5, usage: cxResult.usage },
    { name: "Read", tookMs: null, usage: null },
    { name: "cx:sql", tookMs: 7.5, usage: "returned ~10 tokens | 0 rows" },
  ]);
  assert.equal(cxTookMs(acc.toolDetails), 20);
  assert.equal(acc.pending.size, 0);
});

test("foldToolMessage marks errored results and ignores results with no matching call", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, assistantCall("t1", "mcp__code-context__find"));
  foldToolMessage(acc, userResult("t1", "find failed: no index", undefined, true));
  foldToolMessage(acc, userResult("orphan", "x"));
  foldToolMessage(acc, { type: "user", message: { content: "a plain prompt echo" } });
  foldToolMessage(acc, { type: "result", result: "done" });
  assert.deepEqual(acc.toolDetails, [{ name: "cx:find", tookMs: null, usage: null, isError: true }]);
  assert.equal(cxTookMs(acc.toolDetails), 0);
});

// --- warm-hosted --------------------------------------------------------------

const response = (status, { body = "[]", headers = {} } = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(body),
  text: async () => body,
});

test("splitDbUrl takes https://host/<database> apart and rejects other shapes", () => {
  assert.deepEqual(splitDbUrl(FAKE_URL), { base: "https://api.example.test", db: "bench-db" });
  assert.deepEqual(splitDbUrl("http://localhost:8080/db/"), { base: "http://localhost:8080", db: "db" });
  assert.throws(() => splitDbUrl("https://api.example.test"), /https:\/\/host\/<database>/);
  assert.throws(() => splitDbUrl("https://api.example.test/a/b"), /https:\/\/host\/<database>/);
});

test("warmHosted posts list_tables with the bearer key and reports a warm 200", async () => {
  const calls = [];
  const r = await warmHosted({
    base: "https://api.example.test",
    db: "bench-db",
    key: FAKE_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, { body: '["chunks"]', headers: { "x-infino-read-tokens": "3" } });
    },
    sleep: async () => assert.fail("no sleep on a warm database"),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/list_tables/bench-db");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(calls[0].init.body, "{}");
  assert.equal(r.coldStart, false);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.statuses, [200]);
  assert.deepEqual(r.tables, ["chunks"]);
  assert.equal(r.readTokens, 3);
  assert.equal(typeof r.rttMs, "number");
});

test("warmHosted honours Retry-After through 503/529/409 and flags the cold start", async () => {
  const answers = [
    response(503, { headers: { "retry-after": "5" } }),
    response(529, { headers: { "retry-after": "1" } }),
    response(409),
    response(200, { body: "[]" }),
  ];
  const sleeps = [];
  let clock = 0;
  const r = await warmHosted({
    base: "https://api.example.test",
    db: "bench-db",
    key: FAKE_KEY,
    fetchImpl: async () => {
      clock += 10;
      return answers.shift();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.deepEqual(sleeps, [5000, 1000, DEFAULT_RETRY_AFTER_SECS * 1000]);
  assert.equal(r.coldStart, true);
  assert.equal(r.attempts, 4);
  assert.deepEqual(r.statuses, [503, 529, 409, 200]);
  assert.equal(r.rttMs, 10);
  assert.equal(r.totalMs, 40 + 5000 + 1000 + DEFAULT_RETRY_AFTER_SECS * 1000);
  assert.equal(r.readTokens, null);
});

test("warmHosted gives up at the cap instead of waiting out a 529", async () => {
  let clock = 0;
  await assert.rejects(
    warmHosted({
      base: "https://api.example.test",
      db: "bench-db",
      key: FAKE_KEY,
      fetchImpl: async () => response(529, { headers: { "retry-after": "600" } }),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      capMs: 120_000,
    }),
    /not live after .*statuses 529.*Retry-After 600s exceeds the 120000ms cap/,
  );
});

test("warmHosted surfaces a non-retryable error's message without the key", async () => {
  try {
    await warmHosted({
      base: "https://api.example.test",
      db: "bench-db",
      key: FAKE_KEY,
      fetchImpl: async () => response(401, { body: JSON.stringify({ message: "invalid api key" }) }),
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /401: invalid api key/);
    assert.equal(err.message.includes(FAKE_KEY), false);
  }
});

// --- load-hosted --------------------------------------------------------------

test("indexArgs adds --db only on the hosted side and always asks for --json", () => {
  assert.deepEqual(indexArgs({ cli: "/x/cli.js", repo: "/r", side: "hosted", dbUrl: FAKE_URL }), ["/x/cli.js", "index", "--json", "--db", FAKE_URL, "/r"]);
  assert.deepEqual(indexArgs({ cli: "/x/cli.js", repo: "/r", side: "local" }), ["/x/cli.js", "index", "--json", "/r"]);
});

test("runIndexBuild times the CLI and keeps its --json stats", () => {
  let clock = 0;
  const stats = { files: 10, chunks: 40, vectors: "ready", indexMs: 1200, embedMs: 800 };
  const r = runIndexBuild({
    cli: "/x/cli.js",
    repo: "/r",
    side: "hosted",
    dbUrl: FAKE_URL,
    env: { INFINO_API_KEY: FAKE_KEY },
    now: () => (clock += 2500),
    spawn: (cmd, args, opts) => {
      assert.equal(cmd, "node");
      assert.deepEqual(args, ["/x/cli.js", "index", "--json", "--db", FAKE_URL, "/r"]);
      assert.equal(opts.env.INFINO_API_KEY, FAKE_KEY);
      return { status: 0, stdout: `progress line\n${JSON.stringify(stats, null, 2)}\n`, stderr: "" };
    },
  });
  assert.equal(r.wallMs, 2500);
  assert.equal(r.exitCode, 0);
  assert.equal(r.error, null);
  assert.deepEqual(r.stats, stats);
});

test("runIndexBuild records a CLI that does not know --db as a failure, verbatim", () => {
  const r = runIndexBuild({
    cli: "/x/cli.js",
    repo: "/r",
    side: "hosted",
    dbUrl: FAKE_URL,
    spawn: () => ({ status: 1, stdout: "", stderr: "error: unknown option '--db'\n" }),
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.stats, null);
  assert.equal(r.error, "error: unknown option '--db'");
  const spawnFailed = runIndexBuild({ cli: "/x/cli.js", repo: "/r", side: "local", spawn: () => ({ status: null, error: new Error("ENOENT") }) });
  assert.equal(spawnFailed.error, "ENOENT");
  assert.equal(spawnFailed.exitCode, null);
});

test("hostOf keeps the host and nothing else", () => {
  assert.equal(hostOf(FAKE_URL), "api.example.test");
  assert.equal(hostOf(undefined), null);
  assert.equal(hostOf("nope"), null);
});
