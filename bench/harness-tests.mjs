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
  hostedFlags,
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
const FAKE_KEY_FILE = "/keys/bench.key";

/** Run fn with the harness's hosted env set (and the server's own key
 * variable unset, so a developer's key cannot make a lane look configured),
 * restoring whatever was there before. */
function withHostedEnv(fn, extra = {}) {
  const saved = {};
  const set = { CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE, INFINO_API_KEY: undefined, ...extra };
  for (const k of [...Object.keys(set), "CX_BENCH_EMBED_PROVIDER", "CX_BENCH_AGENT_MAX_TURNS"]) saved[k] = process.env[k];
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

test("the lane table names exactly the ten lanes and an unknown lane throws", () => {
  assert.deepEqual(Object.keys(LANES).sort(), [
    "agent-only",
    "combo",
    "cx",
    "files",
    "find-subagent",
    "hosted",
    "hosted-agent",
    "index-explore",
    "platform-explore",
    "stock-explore",
  ]);
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

test("combo and hosted share the built-in tools; hosted configures the server by flags, never env", () => {
  withHostedEnv(() => {
    const combo = laneOptions("combo", "/r", "/r/.infino");
    const hosted = laneOptions("hosted", "/r", "/r/.infino");
    assert.deepEqual(hosted.tools, combo.tools);
    const server = hosted.mcpServers["code-context"];
    assert.deepEqual(server.args.slice(1), ["mcp", "--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE, "--embed-provider", "platform"]);
    assert.equal(server.env.CX_AUTO_SYNC, "0");
    assert.equal(server.env.CX_ROOT, "/r");
    // nothing hosted reaches the server through its environment - not the
    // URL, not the key, not a provider
    assert.equal(server.env.CX_DB_URL, undefined);
    assert.equal(server.env.INFINO_API_KEY, undefined);
    assert.equal(server.env.CX_EMBED_PROVIDER, undefined);
    assert.deepEqual(combo.mcpServers["code-context"].args.slice(1), ["mcp"]);
  }, { CX_BENCH_EMBED_PROVIDER: undefined });
});

test("CX_BENCH_EMBED_PROVIDER passes through as --embed-provider; hosted-agent adds --subagent", () => {
  withHostedEnv(() => {
    const args = laneOptions("hosted-agent", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.deepEqual(args.slice(1), ["mcp", "--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE, "--embed-provider", "local", "--subagent"]);
  }, { CX_BENCH_EMBED_PROVIDER: "local" });
});

test("agent-only keeps Read and subagent and hides the three retrieval tools", () => {
  withHostedEnv(() => {
    const opts = laneOptions("agent-only", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Read"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__find", "mcp__code-context__search", "mcp__code-context__sql"]);
    assert.equal(opts.mcpServers["code-context"].args.includes("--subagent"), true);
    assert.equal(laneOptions("hosted-agent", "/r", "/r/.infino").disallowedTools, undefined);
    assert.equal(laneOptions("combo", "/r", "/r/.infino").disallowedTools, undefined);
  });
});

test("find-subagent keeps the stock tools, find and subagent, and hides search and sql", () => {
  withHostedEnv(() => {
    const opts = laneOptions("find-subagent", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__search", "mcp__code-context__sql"]);
    assert.equal(opts.agents, undefined);
    const args = opts.mcpServers["code-context"].args;
    assert.equal(args.at(-1), "--subagent");
    assert.equal(args.includes("--db"), true);
  });
});

test("the explore lanes add the Agent tool and override Explore; stock keeps the built-in", () => {
  const stock = laneOptions("stock-explore", "/r", "/r/.infino");
  assert.deepEqual(stock.tools, ["Glob", "Grep", "Read", "LS", "Bash", "Agent"]);
  assert.equal(stock.agents, undefined);
  assert.equal(stock.mcpServers, undefined);

  const index = laneOptions("index-explore", "/r", "/r/.infino");
  assert.deepEqual(index.tools, stock.tools);
  assert.deepEqual(Object.keys(index.agents), ["Explore"]);
  assert.deepEqual(index.agents.Explore.tools, ["mcp__code-context__find", "mcp__code-context__search", "mcp__code-context__sql", "Read"]);
  assert.equal(index.agents.Explore.model, "haiku");
  assert.deepEqual(index.mcpServers["code-context"].args.slice(1), ["mcp"]);

  withHostedEnv(() => {
    const platform = laneOptions("platform-explore", "/r", "/r/.infino");
    assert.deepEqual(platform.agents.Explore.tools, ["mcp__code-context__subagent", "Read"]);
    assert.equal(platform.agents.Explore.description, index.agents.Explore.description);
    const args = platform.mcpServers["code-context"].args;
    assert.deepEqual(args.slice(-3), ["--subagent", "--subagent-max-turns", "4"]);
  }, { CX_BENCH_AGENT_MAX_TURNS: "4" });
  assert.equal(laneOptions("combo", "/r", "/r/.infino").agents, undefined);
});

test("foldToolMessage counts calls made inside subagents and records the subagent types spawned", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore", prompt: "how does compaction work" } }] } });
  foldToolMessage(acc, { type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "s1", name: "mcp__code-context__search", input: { query: "compaction" } }] } });
  foldToolMessage(acc, { type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "s2", name: "Read", input: {} }] } });
  foldToolMessage(acc, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "m1", name: "Read", input: {} }] } });
  assert.deepEqual(acc.toolCalls, ["Agent", "cx:search", "Read", "Read"]);
  assert.equal(acc.subagentCalls, 2);
  assert.deepEqual(acc.subagents, ["Explore"]);
  assert.equal(acc.toolDetails[1].inSubagent, true);
  assert.equal(acc.toolDetails[3].inSubagent, undefined);
});

test("CX_BENCH_AGENT_MAX_TURNS passes through as --subagent-max-turns on the agent lanes only", () => {
  withHostedEnv(() => {
    const only = laneOptions("agent-only", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.deepEqual(only.slice(-3), ["--subagent", "--subagent-max-turns", "4"]);
    const withAgent = laneOptions("hosted-agent", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.deepEqual(withAgent.slice(-3), ["--subagent", "--subagent-max-turns", "4"]);
    assert.equal(laneOptions("hosted", "/r", "/r/.infino").mcpServers["code-context"].args.includes("--subagent-max-turns"), false);
  }, { CX_BENCH_AGENT_MAX_TURNS: "4" });
  withHostedEnv(() => {
    const only = laneOptions("agent-only", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.equal(only.at(-1), "--subagent");
  }, { CX_BENCH_AGENT_MAX_TURNS: undefined });
});

test("hostedFlags is the one place the server's hosted command line is built", () => {
  const env = { CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE };
  assert.deepEqual(hostedFlags(env), ["--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE, "--embed-provider", "platform"]);
  assert.deepEqual(hostedFlags({ ...env, CX_BENCH_EMBED_PROVIDER: "local" }).slice(-2), ["--embed-provider", "local"]);
});

test("a hosted lane without its env fails fast, naming the variables", () => {
  assert.throws(() => checkLaneEnv("hosted", {}), /needs CX_BENCH_DB_URL and CX_BENCH_KEY_FILE/);
  assert.throws(() => checkLaneEnv("hosted-agent", { CX_BENCH_DB_URL: FAKE_URL }), /needs CX_BENCH_KEY_FILE .*it is not set/);
  assert.doesNotThrow(() => checkLaneEnv("hosted", { CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE }));
  assert.doesNotThrow(() => checkLaneEnv("files", {}));
  withHostedEnv(() => assert.throws(() => laneOptions("hosted", "/r", "/r/.infino"), /CX_BENCH_KEY_FILE/), { CX_BENCH_KEY_FILE: undefined });
});

test("dbHost is the host only, and null for local lanes", () => {
  const env = { CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE };
  assert.equal(dbHost("hosted", env), "api.example.test");
  assert.equal(dbHost("hosted-agent", env), "api.example.test");
  assert.equal(dbHost("combo", env), null);
  assert.equal(dbHost("hosted", {}), null);
  assert.equal(dbHost("hosted", { CX_BENCH_DB_URL: "not a url" }), null);
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

test("indexArgs carries the lane's hosted flags on the hosted side only and always asks for --json", () => {
  const flags = hostedFlags({ CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE });
  assert.deepEqual(indexArgs({ cli: "/x/cli.js", repo: "/r", side: "hosted", flags }), ["/x/cli.js", "index", "--json", ...flags, "/r"]);
  assert.deepEqual(indexArgs({ cli: "/x/cli.js", repo: "/r", side: "local", flags }), ["/x/cli.js", "index", "--json", "/r"]);
  assert.deepEqual(indexArgs({ cli: "/x/cli.js", repo: "/r", side: "local" }), ["/x/cli.js", "index", "--json", "/r"]);
});

test("runIndexBuild times the CLI and keeps its --json stats", () => {
  let clock = 0;
  const stats = { files: 10, chunks: 40, vectors: "ready", indexMs: 1200, embedMs: 800 };
  const flags = ["--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE];
  const r = runIndexBuild({
    cli: "/x/cli.js",
    repo: "/r",
    side: "hosted",
    flags,
    env: { PATH: "/bin" },
    now: () => (clock += 2500),
    spawn: (cmd, args, opts) => {
      assert.equal(cmd, "node");
      assert.deepEqual(args, ["/x/cli.js", "index", "--json", ...flags, "/r"]);
      assert.deepEqual(opts.env, { PATH: "/bin" }); // the key is a file path in argv, not an env value
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
    flags: ["--db", FAKE_URL],
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
