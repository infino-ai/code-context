// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Tests for the harness's own logic - the lane table, the SDK tool-result
// parsing, the hosted warm-up loop, the build record, and the Snowflake arm's
// plumbing (the lane's env mapping, the REST client's settings, the server's
// statement shapes and read-only guard) - with no model, no network, no engine
// and no Snowflake: fetch and spawn are injected, statements are inspected as
// text. Node's built-in runner rather than vitest on purpose: these import
// lanes.mjs, which needs the agent SDK from bench/node_modules, and the root
// `npm test` (vitest, which would pick up any *.test.* file under bench/) runs
// without bench's deps.
//   cd bench && npm install && node --test harness-tests.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANES,
  laneDef,
  laneOptions,
  cxServer,
  mcpEnvBase,
  checkLaneEnv,
  dbHost,
  hostedFlags,
  snowflakeServer,
  snowflakeServerEnv,
  foldToolMessage,
  newToolAccounting,
  toolResultText,
  parseCxResult,
  shortToolName,
  isCxTool,
  isSfTool,
  cxTookMs,
  sfTookMs,
  keepInput,
  recordedQueries,
  innerMaxTurns,
} from "./lanes.mjs";
import { compareFind, countInFile, declaredNarrows, projectionInvariance, fileOrder } from "./find-parity.mjs";
import { warmHosted, splitDbUrl, DEFAULT_RETRY_AFTER_SECS } from "./warm-hosted.mjs";
import { indexArgs, runIndexBuild, hostOf } from "./load-hosted.mjs";
import { snowflakeSettings, CHUNK_COLUMNS } from "./snowflake-rest.mjs";
import { readOnlyError, findSql, searchSql, splitTerms, tableName } from "./snowflake-mcp.mjs";

const FAKE_URL = "https://api.example.test/bench-db";
const FAKE_KEY = "inf_secret_value_that_must_not_leak";
const FAKE_KEY_FILE = "/keys/bench.key";
/** The path the Snowflake lane hands its server as the token file. It does
 * not exist, so anything that tried to read the token would throw. */
const FAKE_SF_TOKEN_FILE = "/keys/sf.token";
const FAKE_SF_ACCOUNT = "ACCT-ID";
const FAKE_SF_USER = "BENCH";
/** The Snowflake server's own variables, unset around a Snowflake-lane test
 * so a developer's shell cannot configure the server behind the harness's
 * back, and so what the lane does not pass can be asserted absent. */
const SF_SERVER_VARS = ["SF_ACCOUNT", "SF_USER", "SF_ROLE", "SF_WAREHOUSE", "SF_DATABASE", "SF_SCHEMA", "SF_TABLE", "SF_TOKEN", "SF_TOKEN_FILE"];
/** The harness's optional Snowflake variables, unset likewise. */
const SF_BENCH_OPTIONAL = ["CX_BENCH_SF_ROLE", "CX_BENCH_SF_WAREHOUSE", "CX_BENCH_SF_DATABASE", "CX_BENCH_SF_SCHEMA", "CX_BENCH_SF_TABLE"];
const unset = (names) => Object.fromEntries(names.map((k) => [k, undefined]));

/** Run fn with the given variables set (undefined unsets one), restoring
 * whatever was there before. */
function withEnv(set, fn) {
  const saved = {};
  for (const k of Object.keys(set)) saved[k] = process.env[k];
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

/** Run fn with the harness's hosted env set (and the server's own key
 * variable unset, so a developer's key cannot make a lane look configured). */
function withHostedEnv(fn, extra = {}) {
  return withEnv({ CX_BENCH_DB_URL: FAKE_URL, CX_BENCH_KEY_FILE: FAKE_KEY_FILE, INFINO_API_KEY: undefined, ...extra }, fn);
}

/** Run fn with the harness's Snowflake env set - the account, the user and
 * the path of the token file - and every SF_* the server reads unset. */
function withSnowflakeEnv(fn, extra = {}) {
  return withEnv(
    {
      CX_BENCH_SF_ACCOUNT: FAKE_SF_ACCOUNT,
      CX_BENCH_SF_USER: FAKE_SF_USER,
      CX_BENCH_SF_TOKEN_FILE: FAKE_SF_TOKEN_FILE,
      ...unset(SF_SERVER_VARS),
      ...unset(SF_BENCH_OPTIONAL),
      ...extra,
    },
    fn,
  );
}

// --- lane table ---------------------------------------------------------------

test("the lane table names exactly the sixteen lanes and an unknown lane throws", () => {
  assert.deepEqual(Object.keys(LANES).sort(), [
    "agent-only",
    "combo",
    "cx",
    "delegated",
    "delegated-forced",
    "delegated-relay",
    "files",
    "find-explore",
    "find-subagent",
    "hosted",
    "hosted-agent",
    "hosted-full",
    "index-explore",
    "platform-explore",
    "snowflake",
    "stock-explore",
  ]);
  assert.throws(() => laneDef("cobmo"), /unknown lane "cobmo"/);
  assert.throws(() => laneOptions("cobmo", "/r", "/r/.infino"), /unknown lane/);
});

test("cxServer is the one server block: the judge's local server is the combo lane's, with no --db", () => {
  const judge = cxServer(mcpEnvBase("/r", "/r/.infino-hosted"));
  const server = judge["code-context"];
  assert.deepEqual(server.args.slice(1), ["mcp"]);
  assert.equal(server.args.includes("--db"), false);
  assert.equal(server.alwaysLoad, true);
  assert.equal(server.env.CX_ROOT, "/r");
  assert.equal(server.env.CX_INDEX_DIR, "/r/.infino-hosted");
  assert.equal(server.env.CX_AUTO_SYNC, "0");
  assert.deepEqual(laneOptions("combo", "/r", "/r/.infino-hosted").mcpServers, judge);
  const flagged = cxServer(mcpEnvBase("/r", "/r/.infino"), ["--db", FAKE_URL])["code-context"];
  assert.deepEqual(flagged.args.slice(1), ["mcp", "--db", FAKE_URL]);
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

test("combo and hosted share the built-in tools; hosted configures the server by flags, never env, and hides the platform tools", () => {
  withHostedEnv(() => {
    const combo = laneOptions("combo", "/r", "/r/.infino");
    const hosted = laneOptions("hosted", "/r", "/r/.infino");
    assert.deepEqual(hosted.tools, combo.tools);
    const server = hosted.mcpServers["code-context"];
    assert.deepEqual(server.args.slice(1), ["mcp", "--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE, "--embed-provider", "platform"]);
    assert.equal(server.env.CX_AUTO_SYNC, "0");
    assert.equal(server.env.CX_ROOT, "/r");
    // nothing about the platform reaches the server through its environment -
    // not the URL, not the key, not a provider
    assert.equal(server.env.CX_DB_URL, undefined);
    assert.equal(server.env.INFINO_API_KEY, undefined);
    assert.equal(server.env.CX_EMBED_PROVIDER, undefined);
    // --db brings ask and explore; the control lane hides both
    assert.deepEqual(hosted.disallowedTools, ["mcp__code-context__ask", "mcp__code-context__explore"]);
    assert.deepEqual(combo.mcpServers["code-context"].args.slice(1), ["mcp"]);
    assert.equal(combo.disallowedTools, undefined);
  }, { CX_BENCH_EMBED_PROVIDER: undefined });
});

test("CX_BENCH_EMBED_PROVIDER passes through as --embed-provider; hosted-agent keeps ask and hides explore", () => {
  withHostedEnv(() => {
    const opts = laneOptions("hosted-agent", "/r", "/r/.infino");
    assert.deepEqual(opts.mcpServers["code-context"].args.slice(1), ["mcp", "--db", FAKE_URL, "--api-key-file", FAKE_KEY_FILE, "--embed-provider", "local"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__explore"]);
  }, { CX_BENCH_EMBED_PROVIDER: "local" });
});

test("agent-only keeps Read and ask and hides the three retrieval tools and explore", () => {
  withHostedEnv(() => {
    const opts = laneOptions("agent-only", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Read"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__find", "mcp__code-context__search", "mcp__code-context__sql", "mcp__code-context__explore"]);
    assert.equal(opts.mcpServers["code-context"].args.includes("--db"), true);
  });
});

test("find-subagent keeps the stock tools, find and ask, and hides search, sql and explore", () => {
  withHostedEnv(() => {
    const opts = laneOptions("find-subagent", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__search", "mcp__code-context__sql", "mcp__code-context__explore"]);
    assert.equal(opts.agents, undefined);
    const args = opts.mcpServers["code-context"].args;
    assert.equal(args.includes("--db"), true);
    assert.equal(args.includes("--subagent"), false); // the tools come with --db, there is no switch
  });
});

test("hosted-full hides nothing: all five code-context tools stay in the model's context", () => {
  withHostedEnv(() => {
    const opts = laneOptions("hosted-full", "/r", "/r/.infino");
    assert.equal(opts.disallowedTools, undefined);
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
    assert.equal(opts.mcpServers["code-context"].args.includes("--db"), true);
    assert.equal(laneDef("hosted-full").kind, "hosted");
  });
});

test("delegated offers rather than blocks: the outer model keeps every tool and gains the subagent", () => {
  withHostedEnv(() => {
    const opts = laneOptions("delegated", "/r", "/r/.infino");
    // the whole stock surface plus the Agent tool
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash", "Agent"]);
    // nothing hidden: what the offer draws is the measurement, and hiding the
    // tools would remove it. Where the outer model must be left without them,
    // the lane below scopes the server to the subagent instead of denying it
    // to the session.
    assert.equal(opts.disallowedTools, undefined);
    // the subagent holds the whole surface, and a different model runs it
    const explore = opts.agents.Explore;
    assert.deepEqual(explore.tools, [
      "mcp__code-context__find",
      "mcp__code-context__search",
      "mcp__code-context__sql",
      "mcp__code-context__explore",
      "mcp__code-context__ask",
      "Read",
    ]);
    assert.equal(explore.model, "sonnet");
    assert.match(explore.prompt, /path:line citation/);
    // the offer has to name the instruments, since nothing forces the choice
    assert.match(explore.description, /runs find and explore/);
    assert.equal(opts.mcpServers["code-context"].args.includes("--db"), true);
    assert.equal(laneDef("delegated").kind, "hosted");
  });
});

test("delegated-forced puts the server on the subagent, not in the session", () => {
  withHostedEnv(() => {
    const opts = laneOptions("delegated-forced", "/r", "/r/.infino");
    // the outer model can spawn the subagent and do nothing else
    assert.deepEqual(opts.tools, ["Agent"]);
    // no session-level server at all, and so nothing to deny
    assert.equal(opts.mcpServers, undefined);
    assert.equal(opts.disallowedTools, undefined);
    // the subagent carries its own copy of the server, pointed at the platform
    const explore = opts.agents.Explore;
    const server = explore.mcpServers[0]["code-context"];
    assert.equal(server.args.includes("--db"), true);
    assert.equal(server.args.includes("--api-key-file"), true);
    // and the same model and turn budget the session itself runs under
    assert.equal(explore.model, "sonnet");
    // the session's budget by default, and the knob lowers it
    assert.equal(explore.maxTurns, 50);
    assert.equal(innerMaxTurns({}), 50);
    assert.equal(innerMaxTurns({ CX_BENCH_INNER_MAX_TURNS: "12" }), 12);
    assert.equal(innerMaxTurns({ CX_BENCH_INNER_MAX_TURNS: "nope" }), 50);
    assert.equal(innerMaxTurns({ CX_BENCH_INNER_MAX_TURNS: "0" }), 50);
    assert.equal(laneDef("delegated-forced").kind, "hosted");
  });
});

test("delegated-relay differs from delegated-forced in the prompt and the budget alone", () => {
  withHostedEnv(() => {
    const forced = laneOptions("delegated-forced", "/r", "/r/.infino").agents.Explore;
    const relay = laneOptions("delegated-relay", "/r", "/r/.infino").agents.Explore;
    // same outer surface, so the two are comparable
    assert.deepEqual(laneOptions("delegated-relay", "/r", "/r/.infino").tools, ["Agent"]);
    // same tools and same model in the middle: the local primitives stay,
    // because an exact string is a local lookup
    assert.deepEqual(relay.tools, forced.tools);
    assert.equal(relay.tools.includes("mcp__code-context__find"), true);
    assert.equal(relay.model, forced.model);
    // and exactly one thing differs: the prompt. The budget is deliberately
    // the same on both sides, because a low cap on the subagent was measured
    // to multiply the outer model's spawns rather than reduce its spend.
    assert.notEqual(relay.prompt, forced.prompt);
    assert.equal(forced.maxTurns, 50);
    assert.equal(relay.maxTurns, 50);
    // the instruction is one retrieval then the answer
    assert.match(relay.prompt, /Spend one retrieval/);
    assert.match(relay.prompt, /in one call/);
    // the knob still overrides, which is how the respawn effect is reproduced
    assert.equal(innerMaxTurns({ CX_BENCH_INNER_MAX_TURNS: "4" }), 4);
    assert.equal(innerMaxTurns({}), 50);
  });
});

test("find-explore is find-subagent with explore in ask's place", () => {
  withHostedEnv(() => {
    const opts = laneOptions("find-explore", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
    assert.deepEqual(opts.disallowedTools, ["mcp__code-context__search", "mcp__code-context__sql", "mcp__code-context__ask"]);
    assert.equal(opts.agents, undefined);
    assert.equal(opts.mcpServers["code-context"].args.includes("--db"), true);
  });
});

test("CX_BENCH_AGENT_K passes through as --subagent-k after the turn cap", () => {
  withHostedEnv(() => {
    const args = laneOptions("find-subagent", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.deepEqual(args.slice(-4), ["--subagent-max-turns", "3", "--subagent-k", "100"]);
  }, { CX_BENCH_AGENT_MAX_TURNS: "3", CX_BENCH_AGENT_K: "100" });
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
    assert.deepEqual(platform.agents.Explore.tools, ["mcp__code-context__explore", "Read"]);
    assert.equal(platform.agents.Explore.description, index.agents.Explore.description);
    const args = platform.mcpServers["code-context"].args;
    assert.deepEqual(args.slice(-2), ["--subagent-max-turns", "4"]);
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
    assert.deepEqual(only.slice(-2), ["--subagent-max-turns", "4"]);
    const withAgent = laneOptions("hosted-agent", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.deepEqual(withAgent.slice(-2), ["--subagent-max-turns", "4"]);
    assert.equal(laneOptions("hosted", "/r", "/r/.infino").mcpServers["code-context"].args.includes("--subagent-max-turns"), false);
  }, { CX_BENCH_AGENT_MAX_TURNS: "4" });
  withHostedEnv(() => {
    const only = laneOptions("agent-only", "/r", "/r/.infino").mcpServers["code-context"].args;
    assert.equal(only.at(-1), "platform"); // the provider closes the line; no agent flag without a cap
  }, { CX_BENCH_AGENT_MAX_TURNS: undefined, CX_BENCH_EMBED_PROVIDER: undefined });
});

test("hostedFlags is the one place the server's platform command line is built", () => {
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

// --- snowflake lane -----------------------------------------------------------

test("the snowflake lane attaches the Snowflake server alone, configured by SF_* env, with the token as a file path", () => {
  assert.equal(laneDef("snowflake").kind, "snowflake");
  withSnowflakeEnv(() => {
    const opts = laneOptions("snowflake", "/r", "/r/.infino");
    assert.deepEqual(opts.tools, ["Glob", "Grep", "Read", "LS", "Bash"]);
    assert.equal(opts.disallowedTools, undefined);
    assert.equal(opts.agents, undefined);
    assert.equal(opts.strictMcpConfig, true);
    // the Snowflake server in the code-context server's place, not beside it
    assert.deepEqual(Object.keys(opts.mcpServers), ["snowflake"]);
    const server = opts.mcpServers.snowflake;
    assert.equal(server.command, "node");
    assert.equal(server.args.length, 1);
    assert.ok(server.args[0].endsWith("/bench/snowflake-mcp.mjs"), server.args[0]);
    assert.equal(server.alwaysLoad, true);
    assert.equal(server.env.SF_ACCOUNT, FAKE_SF_ACCOUNT);
    assert.equal(server.env.SF_USER, FAKE_SF_USER);
    // the token travels as the path of its file - a path nothing could have
    // read, since it does not exist - and no token value is in the env
    assert.equal(server.env.SF_TOKEN_FILE, FAKE_SF_TOKEN_FILE);
    assert.equal(server.env.SF_TOKEN, undefined);
    // the optional ones are not passed when unset, so the client's defaults hold
    for (const name of ["SF_ROLE", "SF_WAREHOUSE", "SF_DATABASE", "SF_SCHEMA", "SF_TABLE"]) assert.equal(server.env[name], undefined);
    assert.equal(dbHost("snowflake", { CX_BENCH_DB_URL: FAKE_URL }), null);
  });
});

test("an optional CX_BENCH_SF_* passes through under its SF_* name; snowflakeServer is the one place the block is built", () => {
  withSnowflakeEnv(() => {
    const server = laneOptions("snowflake", "/r", "/r/.infino").mcpServers.snowflake;
    assert.equal(server.env.SF_ROLE, "BENCH_ROLE");
    assert.equal(server.env.SF_SCHEMA, "CX2");
    assert.equal(server.env.SF_WAREHOUSE, undefined);
    assert.deepEqual(laneOptions("snowflake", "/r", "/r/.infino").mcpServers, snowflakeServer(process.env));
  }, { CX_BENCH_SF_ROLE: "BENCH_ROLE", CX_BENCH_SF_SCHEMA: "CX2" });
  // from a given env, nothing of the process's leaks in
  const given = { CX_BENCH_SF_ACCOUNT: "A", CX_BENCH_SF_USER: "U", CX_BENCH_SF_TOKEN_FILE: FAKE_SF_TOKEN_FILE, CX_BENCH_SF_TABLE: "T" };
  const mapped = { SF_ACCOUNT: "A", SF_USER: "U", SF_TOKEN_FILE: FAKE_SF_TOKEN_FILE, SF_TABLE: "T" };
  assert.deepEqual(snowflakeServer(given).snowflake.env, { ...given, ...mapped });
  // the mapping alone is what the loader lays over its environment, so the
  // same exported line configures the load and the run; an unset or empty
  // optional is left to the client's default, and no SF_TOKEN is ever made
  assert.deepEqual(snowflakeServerEnv(given), mapped);
  assert.deepEqual(snowflakeServerEnv({ ...given, CX_BENCH_SF_ROLE: "" }), mapped);
  assert.deepEqual(snowflakeServerEnv({}), {});
  // (a token from SF_TOKEN here, since the fake token file cannot be read)
  const loaderEnv = { CX_BENCH_SF_ACCOUNT: "A", CX_BENCH_SF_USER: "U", CX_BENCH_SF_TABLE: "T", SF_TOKEN: "t", SF_ACCOUNT: "shell-account" };
  const settings = snowflakeSettings({ ...loaderEnv, ...snowflakeServerEnv(loaderEnv) });
  assert.equal(settings.account, "A"); // the harness's variable wins over a shell's SF_*
  assert.equal(settings.user, "U");
  assert.equal(settings.table, "T");
});

test("the snowflake lane without its env fails fast, naming the variables", () => {
  assert.throws(() => checkLaneEnv("snowflake", {}), /needs CX_BENCH_SF_ACCOUNT and CX_BENCH_SF_USER and CX_BENCH_SF_TOKEN_FILE/);
  assert.throws(() => checkLaneEnv("snowflake", { CX_BENCH_SF_ACCOUNT: "A", CX_BENCH_SF_USER: "U" }), /needs CX_BENCH_SF_TOKEN_FILE .*it is not set/);
  assert.doesNotThrow(() => checkLaneEnv("snowflake", { CX_BENCH_SF_ACCOUNT: "A", CX_BENCH_SF_USER: "U", CX_BENCH_SF_TOKEN_FILE: FAKE_SF_TOKEN_FILE }));
  withSnowflakeEnv(() => assert.throws(() => laneOptions("snowflake", "/r", "/r/.infino"), /CX_BENCH_SF_TOKEN_FILE/), { CX_BENCH_SF_TOKEN_FILE: undefined });
  // the platform's env does not stand in for it, and the server's own SF_* do not either
  withHostedEnv(
    () => assert.throws(() => laneOptions("snowflake", "/r", "/r/.infino"), /CX_BENCH_SF_ACCOUNT/),
    { ...unset(["CX_BENCH_SF_ACCOUNT", "CX_BENCH_SF_USER", "CX_BENCH_SF_TOKEN_FILE"]), SF_ACCOUNT: "A", SF_USER: "U", SF_TOKEN_FILE: FAKE_SF_TOKEN_FILE },
  );
});

test("shortToolName shortens both servers' prefixes and leaves built-ins alone", () => {
  assert.equal(shortToolName("mcp__snowflake__sql"), "sf:sql");
  assert.equal(shortToolName("mcp__code-context__sql"), "cx:sql");
  assert.equal(shortToolName("Read"), "Read");
  assert.equal(isSfTool("sf:sql"), true);
  assert.equal(isSfTool("cx:sql"), false);
  assert.equal(isCxTool("sf:sql"), false);
});

// --- tool-result parsing ----------------------------------------------------

const cxResult = { hits: [], took_ms: 12.5, usage: "returned ~300 tokens | 2 chunks / 2 files | invoked 1x this session (~300 tokens total)" };
const assistantCall = (id, name, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
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

test("parseCxResult reads took_ms, the usage receipt and the platform's queries, and tolerates non-JSON", () => {
  assert.deepEqual(parseCxResult(JSON.stringify(cxResult)), { tookMs: 12.5, usage: cxResult.usage, queries: [] });
  assert.deepEqual(parseCxResult("search failed: no index"), { tookMs: null, usage: null, queries: [] });
  assert.deepEqual(parseCxResult(JSON.stringify({ rows: [] })), { tookMs: null, usage: null, queries: [] });
  assert.deepEqual(parseCxResult(null), { tookMs: null, usage: null, queries: [] });
  // an ask result names the statement its rows came from
  assert.deepEqual(parseCxResult(JSON.stringify({ sql: "SELECT path FROM chunks LIMIT 1", hits: [], took_ms: 1 })).queries, ["SELECT path FROM chunks LIMIT 1"]);
  // an explore result carries its chain; the last statement is not listed twice
  const explore = { answer: "...", sql: "SELECT 2", chain: ["SELECT 1", "SELECT 2", "", 7], hits: [] };
  assert.deepEqual(parseCxResult(JSON.stringify(explore)).queries, ["SELECT 2", "SELECT 1"]);
});

test("keepInput keeps the input object and cuts only over-long string fields", () => {
  const embed = { q: "how compaction picks files" };
  assert.deepEqual(keepInput({ query: "SELECT 1", embed }), { query: "SELECT 1", embed });
  const long = "x".repeat(5000);
  const kept = keepInput({ command: long, n: 3 });
  assert.equal(kept.n, 3);
  assert.equal(kept.command.length, 4000 + "... (5000 chars)".length);
  assert.ok(kept.command.endsWith("... (5000 chars)"));
  assert.equal(keepInput(undefined), undefined);
  assert.equal(keepInput("text"), "text");
});

test("foldToolMessage joins tool_use to tool_result by id, keeps every input and records cx telemetry only", () => {
  const acc = newToolAccounting();
  const sqlInput = { query: "SELECT path, COUNT(*) AS chunks FROM hybrid_search('chunks','content','compaction','embedding', {{q}}, 300) GROUP BY path", embed: { q: "compaction" } };
  foldToolMessage(acc, assistantCall("t1", "mcp__code-context__search", { query: "where files are merged" }));
  foldToolMessage(acc, assistantCall("t2", "Read", { file_path: "/r/src/lib.rs" }));
  foldToolMessage(acc, assistantCall("t3", "mcp__code-context__sql", sqlInput));
  // t1 arrives with the structured output; t3 with only the block text; t2 is a built-in
  foldToolMessage(acc, userResult("t1", "ignored", { content: [{ type: "text", text: JSON.stringify(cxResult) }] }));
  foldToolMessage(acc, userResult("t2", "file contents"));
  foldToolMessage(acc, userResult("t3", JSON.stringify({ rows: [], took_ms: 7.5, usage: "returned ~10 tokens | 0 rows" })));
  assert.deepEqual(acc.toolCalls, ["cx:search", "Read", "cx:sql"]);
  assert.deepEqual(acc.toolDetails, [
    { name: "cx:search", input: { query: "where files are merged" }, tookMs: 12.5, usage: cxResult.usage },
    { name: "Read", input: { file_path: "/r/src/lib.rs" }, tookMs: null, usage: null },
    { name: "cx:sql", input: sqlInput, tookMs: 7.5, usage: "returned ~10 tokens | 0 rows" },
  ]);
  assert.equal(cxTookMs(acc.toolDetails), 20);
  assert.equal(acc.pending.size, 0);
});

test("foldToolMessage keeps the statements a platform tool ran, and recordedQueries lists them under the call", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, assistantCall("e1", "mcp__code-context__explore", { question: "how does compaction pick files?" }));
  foldToolMessage(acc, assistantCall("g1", "Grep", { pattern: "compact" }));
  foldToolMessage(acc, assistantCall("s1", "mcp__code-context__ask", { question: "count compaction tests" }));
  foldToolMessage(acc, userResult("e1", JSON.stringify({ answer: "...", chain: ["SELECT 1", "SELECT 2"], sql: "SELECT 2", hits: [], took_ms: 3 })));
  foldToolMessage(acc, userResult("s1", JSON.stringify({ sql: "SELECT COUNT(*) FROM chunks", rows: [{ count: 4 }], took_ms: 1 })));
  assert.deepEqual(acc.toolDetails[0].queries, ["SELECT 2", "SELECT 1"]);
  assert.equal(acc.toolDetails[1].queries, undefined);
  assert.deepEqual(acc.toolDetails[2].queries, ["SELECT COUNT(*) FROM chunks"]);
  assert.deepEqual(recordedQueries(acc.toolDetails), [
    'explore {"question":"how does compaction pick files?"}',
    "  ran: SELECT 2",
    "  ran: SELECT 1",
    'ask {"question":"count compaction tests"}',
    "  ran: SELECT COUNT(*) FROM chunks",
  ]);
  // rows written before inputs were kept have nothing to list
  assert.deepEqual(recordedQueries([{ name: "cx:sql", tookMs: 1, usage: null }]), []);
  assert.deepEqual(recordedQueries(undefined), []);
});

test("foldToolMessage records a Snowflake tool's telemetry, and recordedQueries lists its input under its sf: name", () => {
  const acc = newToolAccounting();
  // the server's sql tool takes its statement as `query`, like code-context's
  const query = "SELECT path, COUNT(*) AS chunks FROM CHUNKS WHERE SEARCH(content, 'compaction') GROUP BY path ORDER BY chunks DESC";
  foldToolMessage(acc, assistantCall("f1", "mcp__snowflake__sql", { query }));
  foldToolMessage(acc, assistantCall("f2", "Grep", { pattern: "compaction" }));
  foldToolMessage(acc, assistantCall("f3", "mcp__code-context__find", { literal: "compaction" }));
  foldToolMessage(acc, userResult("f1", JSON.stringify({ rows: [], took_ms: 340, usage: "returned ~20 tokens | 0 rows" })));
  foldToolMessage(acc, userResult("f2", "src/a.rs:1:compaction"));
  foldToolMessage(acc, userResult("f3", JSON.stringify({ hits: [], took_ms: 4 })));
  assert.deepEqual(acc.toolCalls, ["sf:sql", "Grep", "cx:find"]);
  assert.deepEqual(acc.toolDetails[0], { name: "sf:sql", input: { query }, tookMs: 340, usage: "returned ~20 tokens | 0 rows" });
  assert.deepEqual(acc.toolDetails[1], { name: "Grep", input: { pattern: "compaction" }, tookMs: null, usage: null });
  // each server's share is its own: the warehouse's time is not counted as engine work
  assert.equal(sfTookMs(acc.toolDetails), 340);
  assert.equal(cxTookMs(acc.toolDetails), 4);
  // the Snowflake query keeps its prefix so it is not mistaken for code-context's sql
  assert.deepEqual(recordedQueries(acc.toolDetails), [`sf:sql ${JSON.stringify({ query })}`, 'find {"literal":"compaction"}']);
});

// --- snowflake client and server ------------------------------------------------

/** '?' placeholders in a statement: what its bindings must number. */
const placeholders = (statement) => (statement.match(/\?/g) ?? []).length;

test("snowflakeSettings: the bench defaults, SF_* overrides, the token from its file over SF_TOKEN, and an error naming the variables only", () => {
  const fromEnv = snowflakeSettings({ SF_TOKEN: " tok ", SF_ACCOUNT: "ACCT-ID", SF_USER: "BENCH" });
  assert.equal(fromEnv.token, "tok");
  assert.deepEqual(
    [fromEnv.account, fromEnv.user, fromEnv.role, fromEnv.warehouse, fromEnv.database, fromEnv.schema, fromEnv.table],
    ["ACCT-ID", "BENCH", "ACCOUNTADMIN", "COMPUTE_WH", "INFINO_BENCH", "CX", "CHUNKS"],
  );
  // the account and the user have no default: each is named when missing
  assert.throws(() => snowflakeSettings({ SF_TOKEN: "t", SF_USER: "BENCH" }), /set SF_ACCOUNT/);
  assert.throws(() => snowflakeSettings({ SF_TOKEN: "t", SF_ACCOUNT: "ACCT-ID" }), /set SF_USER/);
  const over = snowflakeSettings({ SF_TOKEN: "t", SF_ACCOUNT: "ACCT", SF_USER: "U", SF_ROLE: "R", SF_WAREHOUSE: "W", SF_DATABASE: "D", SF_SCHEMA: "S", SF_TABLE: "T" });
  assert.deepEqual([over.account, over.user, over.role, over.warehouse, over.database, over.schema, over.table], ["ACCT", "U", "R", "W", "D", "S", "T"]);
  // the file wins over the variable, and is trimmed like it
  const tokenFile = join(mkdtempSync(join(tmpdir(), "sf-token-")), "token");
  writeFileSync(tokenFile, "from-file\n", { mode: 0o600 });
  assert.equal(snowflakeSettings({ SF_TOKEN_FILE: tokenFile, SF_TOKEN: "from-env", SF_ACCOUNT: "ACCT-ID", SF_USER: "BENCH" }).token, "from-file");
  // neither set, or set empty: the error names both variables and echoes nothing
  for (const env of [{}, { SF_TOKEN: "" }, { SF_TOKEN: "   " }]) {
    assert.throws(() => snowflakeSettings(env), (err) => /SF_TOKEN_FILE/.test(err.message) && /SF_TOKEN\b/.test(err.message));
  }
  assert.deepEqual(CHUNK_COLUMNS, ["path", "start_line", "end_line", "lang", "symbol", "content"]);
});

test("compareFind reports the totals, the per-file counts and the lines only one side returned", () => {
  const side = (total, files, byFile, lines) => ({ total, files, byFile: new Map(byFile), lines: new Set(lines) });
  const agree = side(3, 2, [["a.rs", 2], ["b.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:4"]);
  const same = compareFind(agree, side(3, 2, [["a.rs", 2], ["b.rs", 1]], ["a.rs:9", "a.rs:1", "b.rs:4"]));
  assert.equal(same.same, true);
  assert.equal(same.total, null);
  assert.deepEqual(same.byFile, []);
  // the shape of the bug this script exists for: identical lines, inflated counts
  const inflated = compareFind(agree, side(4, 2, [["a.rs", 3], ["b.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:4"]));
  assert.equal(inflated.same, false);
  assert.deepEqual(inflated.total, { client: 3, platform: 4 });
  assert.deepEqual(inflated.byFile, [{ path: "a.rs", client: 2, platform: 3 }]);
  assert.deepEqual(inflated.onlyClient, []);
  assert.deepEqual(inflated.onlyPlatform, []);
  // a line, and a whole file, present on one side only
  const missing = compareFind(agree, side(2, 1, [["a.rs", 2]], ["a.rs:1", "a.rs:9"]));
  assert.deepEqual(missing.files, { client: 2, platform: 1 });
  assert.deepEqual(missing.onlyClient, ["b.rs:4"]);
  assert.deepEqual(missing.byFile, [{ path: "b.rs", client: 1, platform: null }]);
  const extra = compareFind(agree, side(4, 3, [["a.rs", 2], ["b.rs", 1], ["c.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:4", "c.rs:7"]));
  assert.deepEqual(extra.onlyPlatform, ["c.rs:7"]);
  assert.deepEqual(extra.byFile, [{ path: "c.rs", client: null, platform: 1 }]);
});

test("declaredNarrows checks a declaration filter against the same side's unfiltered answer", () => {
  const side = (total, lines, truncated = false, before = null) => ({ total, lines: new Set(lines), truncated, before });
  const all = side(6, ["a.rs:1", "a.rs:3", "a.rs:4", "a.rs:5", "b.rs:2", "b.rs:9"]);
  // the intended shape: one declaration out of six occurrences, and the
  // pre-filter count it reports is the unfiltered total
  const ok = declaredNarrows(all, side(1, ["a.rs:1"], false, 6));
  assert.equal(ok.same, true);
  assert.deepEqual(ok.extra, []);
  assert.equal(ok.beforeMatches, true);
  assert.equal(ok.unfilteredTotal, 6);
  // a filter cannot invent a line: one absent from the unfiltered answer
  // means the filter changed which rows were considered
  const invented = declaredNarrows(all, side(2, ["a.rs:1", "c.rs:7"], false, 6));
  assert.equal(invented.same, false);
  assert.deepEqual(invented.extra, ["c.rs:7"]);
  // the count taken at the wrong point - before the overlap dedupe rather
  // than after it - makes "1 of N" incomparable with the unfiltered total
  const miscounted = declaredNarrows(all, side(1, ["a.rs:1"], false, 8));
  assert.equal(miscounted.same, false);
  assert.equal(miscounted.beforeMatches, false);
  assert.equal(miscounted.before, 8);
  // an unfiltered answer cut at the limit cannot vouch for membership: the
  // filter may keep a line the limit cut off, so only the count is asserted
  const cut = declaredNarrows(side(600, ["a.rs:1"], true), side(1, ["a.rs:400"], false, 600));
  assert.equal(cut.subsetChecked, false);
  assert.equal(cut.same, true);
  // but a bad count is still a bad count when the unfiltered answer was cut
  assert.equal(declaredNarrows(side(600, ["a.rs:1"], true), side(1, ["a.rs:400"], false, 599)).same, false);
  // no filter applied: nothing to check, and no false alarm
  const none = declaredNarrows(all, side(6, [...all.lines]));
  assert.equal(none.same, true);
  assert.equal(none.beforeMatches, null);
});

test("projectionInvariance holds the totals and counts always, and the lines only when nothing was cut", () => {
  const side = (total, files, byFile, lines, truncated = false) => ({ total, files, byFile: new Map(byFile), lines: new Set(lines), truncated });
  const base = { label: "path", answer: side(3, 2, [["a.rs", 2], ["b.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:4"]) };
  // adding columns changes nothing: the contract holds
  assert.equal(projectionInvariance([base, { label: "path,symbol", answer: side(3, 2, [["a.rs", 2], ["b.rs", 1]], ["a.rs:9", "a.rs:1", "b.rs:4"]) }]).same, true);
  // the bug this exists for: a projected column inflates the total and a count
  const inflated = projectionInvariance([base, { label: "path,end_line", answer: side(4, 2, [["a.rs", 3], ["b.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:4"]) }]);
  assert.equal(inflated.same, false);
  assert.equal(inflated.broken[0].label, "path,end_line");
  assert.deepEqual(inflated.broken[0].dimensions, ["total 3 against 4", "1 per-file counts"]);
  // a cut answer is the FIRST N matches, so two answers cut at one limit hold
  // the same N: differing lines break the contract even when both were cut,
  // and the message says the cut is not the same N
  const cut = projectionInvariance([
    { label: "path", answer: side(9, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:1", "a.rs:9"], true) },
    { label: "path,symbol", answer: side(9, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:1", "b.rs:4"], true) },
  ]);
  assert.equal(cut.same, false);
  assert.match(cut.broken[0].dimensions[0], /^2 lines \(both cut at the limit/);
  // two answers cut at one limit that hold the same N still agree
  assert.equal(
    projectionInvariance([
      { label: "path", answer: side(9, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:1", "a.rs:9"], true) },
      { label: "path,symbol", answer: side(9, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:9", "a.rs:1"], true) },
    ]).same,
    true,
  );
  // but a cut answer that disagrees on the total still breaks it
  assert.equal(
    projectionInvariance([
      { label: "path", answer: side(9, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:1"], true) },
      { label: "path,symbol", answer: side(11, 2, [["a.rs", 8], ["b.rs", 1]], ["a.rs:1"], true) },
    ]).same,
    false,
  );
  // an untruncated pair that returns different lines does break it
  const lines = projectionInvariance([base, { label: "path,symbol", answer: side(3, 2, [["a.rs", 2], ["b.rs", 1]], ["a.rs:1", "a.rs:9", "b.rs:5"]) }]);
  assert.equal(lines.same, false);
  assert.deepEqual(lines.broken[0].dimensions, ["2 lines"]);
});

test("fileOrder names the first pair of returned lines that are out of file order", () => {
  assert.deepEqual(fileOrder(["a.rs:1", "a.rs:9", "b.rs:2", "b.rs:40"]), { ordered: true });
  assert.deepEqual(fileOrder([]), { ordered: true });
  assert.deepEqual(fileOrder(["a.rs:7"]), { ordered: true });
  // a line number that goes backwards inside one file
  assert.deepEqual(fileOrder(["a.rs:9", "a.rs:1"]), { ordered: false, at: 1, after: "a.rs:9", before: "a.rs:1" });
  // a path that goes backwards
  assert.deepEqual(fileOrder(["b.rs:1", "a.rs:1"]), { ordered: false, at: 1, after: "b.rs:1", before: "a.rs:1" });
  // numeric, not lexical: 40 after 9 is in order
  assert.deepEqual(fileOrder(["a.rs:9", "a.rs:40"]), { ordered: true });
  // a path holding a colon still splits at the last one
  assert.deepEqual(fileOrder(["a:b.rs:1", "a:b.rs:2"]), { ordered: true });
});

test("countInFile is the referee: the 1-based lines of a file holding the literal, case-sensitively", () => {
  const text = "let compaction = 1;\n// Compaction runs\nno match here\n  compaction();\n";
  assert.deepEqual(countInFile(text, "compaction"), [1, 4]);
  assert.deepEqual(countInFile(text, "Compaction"), [2]);
  assert.deepEqual(countInFile(text, "absent"), []);
  // one line holding it twice is one line, as grep -c counts it
  assert.deepEqual(countInFile("a compaction and compaction\n", "compaction"), [1]);
});

test("readOnlyError admits one SELECT or WITH and refuses everything else", () => {
  for (const ok of ["SELECT 1", "  select path from t", "\nWITH m AS (SELECT 1) SELECT * FROM m", "with m as (select 1) select 1"]) {
    assert.equal(readOnlyError(ok), null, ok);
  }
  assert.match(readOnlyError("DELETE FROM t"), /SELECT or WITH/);
  assert.match(readOnlyError("DROP TABLE t"), /SELECT or WITH/);
  assert.match(readOnlyError("SELECTX 1"), /SELECT or WITH/); // a word, not a prefix
  assert.match(readOnlyError("-- note\nSELECT 1"), /SELECT or WITH/); // the first token decides
  assert.match(readOnlyError("SELECT 1; DELETE FROM t"), /semicolon/);
  assert.match(readOnlyError("WITH m AS (SELECT 1) SELECT * FROM m;"), /semicolon/);
});

test("findSql and searchSql bind positionally: one '?' per value the server passes", () => {
  const table = tableName({ database: "D", schema: "S", table: "T" });
  assert.equal(table, "D.S.T");
  const find = findSql(table);
  // the lines statement takes the string and the limit; the counts the string alone
  assert.equal(placeholders(find.lines), 2);
  assert.equal(placeholders(find.counts), 1);
  assert.ok(find.lines.endsWith("ORDER BY c.path, line LIMIT ?"), find.lines);
  for (const statement of [find.lines, find.counts]) {
    assert.ok(statement.includes(`FROM ${table} c, LATERAL SPLIT_TO_TABLE(c.content, '\\n') s`), statement);
    assert.ok(statement.includes("SELECT DISTINCT c.path, c.start_line + s.index - 1 AS line, s.value AS text"), statement);
    assert.ok(statement.includes("WHERE CONTAINS(s.value, ?)"), statement);
  }
  assert.ok(find.counts.startsWith("SELECT path, COUNT(*) AS n FROM ("), find.counts);
  // search: a CASE per term, then the whole query for SEARCH, then k
  const terms = splitTerms("  compaction merge   superfiles ");
  assert.deepEqual(terms, ["compaction", "merge", "superfiles"]);
  assert.deepEqual(splitTerms("   "), []);
  const search = searchSql(table, terms);
  assert.equal(placeholders(search), terms.length + 2);
  assert.ok(search.startsWith(`SELECT ${CHUNK_COLUMNS.join(", ")}, (`), search);
  assert.equal((search.match(/CASE WHEN CONTAINS\(LOWER\(content\), LOWER\(\?\)\) THEN 1 ELSE 0 END/g) ?? []).length, terms.length);
  assert.ok(search.includes(`FROM ${table} WHERE SEARCH(content, ?) ORDER BY matched_terms DESC, LENGTH(content) ASC, path, start_line LIMIT ?`), search);
  assert.equal(placeholders(searchSql(table, ["one"])), 3);
});

test("tableName takes plain identifiers only, so a setting cannot carry SQL into a statement", () => {
  assert.equal(tableName({ database: "INFINO_BENCH", schema: "CX", table: "CHUNKS" }), "INFINO_BENCH.CX.CHUNKS");
  assert.equal(tableName({ database: "d_1", schema: "s$", table: "_t" }), "d_1.s$._t");
  for (const bad of ["1x", "a-b", "a.b", "a b", "t;DROP TABLE x", "", '"q"']) {
    assert.throws(() => tableName({ database: "D", schema: "S", table: bad }), /identifier/, bad);
  }
});

test("foldToolMessage marks errored results and ignores results with no matching call", () => {
  const acc = newToolAccounting();
  foldToolMessage(acc, assistantCall("t1", "mcp__code-context__find"));
  foldToolMessage(acc, userResult("t1", "find failed: no index", undefined, true));
  foldToolMessage(acc, userResult("orphan", "x"));
  foldToolMessage(acc, { type: "user", message: { content: "a plain prompt echo" } });
  foldToolMessage(acc, { type: "result", result: "done" });
  assert.deepEqual(acc.toolDetails, [{ name: "cx:find", input: {}, tookMs: null, usage: null, isError: true }]);
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
