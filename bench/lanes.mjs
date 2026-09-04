// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Shared lane plumbing: hermetic agent runs where the only variable is the
// toolset. Exported for the question and localization runners.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const WORK = join(BENCH, ".work");
export const RESULTS = join(WORK, "results");
/** The server build the MCP lanes run: this checkout's `dist/cli.js`, or
 * `CX_BENCH_CLI` to point the same harness at another build (a variant of the
 * tool surface in a sibling worktree), so lanes differ in the server alone. */
export const CX = process.env.CX_BENCH_CLI ? resolve(process.env.CX_BENCH_CLI) : resolve(BENCH, "..", "dist", "cli.js");
/** A label for the build under test, recorded on every result so runs from
 * different variants can be told apart in one results file. */
export const BUILD = process.env.CX_BENCH_BUILD ?? null;
export const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";

/** The built-in tool set of real Claude Code (Bash included, since a real
 * client has it). Every lane but `cx` gets exactly this. */
const STOCK_TOOLS = ["Glob", "Grep", "Read", "LS", "Bash"];
/** The prefix the SDK puts on the code-context MCP tools; results record the
 * short `cx:<tool>` form so they stay readable and comparable across builds. */
const CX_TOOL_PREFIX = "mcp__code-context__";
const CX_SHORT_PREFIX = "cx:";
/** The three retrieval tools, hidden from the model in the agent-only lane
 * so that every retrieval has to go through `retrieval_agent`. */
const CX_RETRIEVAL_TOOLS = ["find", "search", "sql"];
/** The built-in tool that spawns subagents, and the built-in read-only
 * exploration subagent the explore lanes override: a programmatic agent
 * definition under the same name replaces it (probed: the overridden Explore
 * sees only the tools its definition names, the main agent keeps its own). */
const AGENT_TOOL = "Agent";
const EXPLORE = "Explore";
/** The model inside an overridden Explore: the cheap one, since the index
 * does the finding and the subagent only reads results and writes the
 * conclusion. */
const EXPLORE_MODEL = "haiku";

/** What the main agent reads when deciding to delegate: the same job the
 * built-in Explore advertises (broad, read-only, conclusion not file dumps),
 * with the index named as how it gets there. Shared by both overrides so the
 * two differ only in what runs underneath. */
const EXPLORE_DESCRIPTION =
  "Read-only exploration agent for questions that span the repository: how X works, where Y is " +
  "handled, which files are about Z, every occurrence of an identifier. It searches the repository's " +
  "code index and returns the conclusion with path:line citations, not file dumps. Use it when " +
  "answering means sweeping many files and you only need the conclusion.";

/** Explore over code-context's own tools, Haiku inside. */
const exploreOnIndex = {
  description: EXPLORE_DESCRIPTION,
  tools: [...CX_RETRIEVAL_TOOLS.map((tool) => `${CX_TOOL_PREFIX}${tool}`), "Read"],
  prompt:
    "You explore this repository through code-context's index. find: every occurrence of an exact " +
    "identifier or string, where you would grep. search: how something works, where it is handled, code " +
    "by meaning. sql: counts and rankings across the repo (bm25_search('chunks','content','<terms>', k) " +
    "as a table function with GROUP BY). Answer from the hits and cite path:line; Read a file only for a " +
    "hit marked truncated. Return a concise, complete answer with citations - the caller will not see " +
    "your tool results.",
  model: EXPLORE_MODEL,
};

/** Explore over the platform's retrieval agent alone, Haiku relaying. The
 * inner loop's turn cap comes from the server flags (CX_BENCH_AGENT_MAX_TURNS),
 * so the outer agent, not the platform's ladder, decides how far to go. */
const exploreOnPlatform = {
  description: EXPLORE_DESCRIPTION,
  tools: [`${CX_TOOL_PREFIX}retrieval_agent`, "Read"],
  prompt:
    "You explore this repository by calling retrieval_agent with the question, at most twice (rephrase " +
    "once if the first call returns no answer). Return its answer with the places it found cited " +
    "path:line; if there is still no answer, return what it found and say so. The caller will not see " +
    "your tool results.",
  model: EXPLORE_MODEL,
};
/** The embedding provider a hosted lane's server uses when the caller does
 * not pick one: the product default - the platform embeds - since the hosted
 * lanes measure the hosted product as shipped. CX_BENCH_EMBED_PROVIDER=local
 * runs the same local model the local lanes use instead, so the two sides
 * differ in where the index lives and nothing else. */
export const DEFAULT_HOSTED_EMBED_PROVIDER = "platform";

/** The harness's own env for a hosted lane: the database URL, the FILE holding
 * its key, and the optional provider override. The server takes these as
 * flags (--db, --api-key-file, --embed-provider), never from its environment;
 * these names carry the CX_BENCH_ prefix of the other harness knobs so nothing
 * the server could read is set by accident. */
export const BENCH_DB_URL = "CX_BENCH_DB_URL";
export const BENCH_KEY_FILE = "CX_BENCH_KEY_FILE";
export const BENCH_EMBED_PROVIDER = "CX_BENCH_EMBED_PROVIDER";
/** Optional turn cap for retrieval_agent in the agent lanes, passed through as
 * the server's --agent-max-turns; unset leaves the server's default. */
export const BENCH_AGENT_MAX_TURNS = "CX_BENCH_AGENT_MAX_TURNS";

/** The env a hosted lane needs before it can run. */
const HOSTED_REQUIRES = [BENCH_DB_URL, BENCH_KEY_FILE];

/** Server env that is common to every MCP lane. Auto-sync is off in every
 * lane: the index is built before the run and a re-sync mid-question would
 * put a stat walk on the clock. (In hosted mode the server forces auto-index
 * and auto-sync off itself: a hosted build is a separate, metered step -
 * load-hosted.mjs - never something a question triggers.) */
const mcpEnvBase = (repoDir, indexDir) => ({ CX_ROOT: repoDir, CX_INDEX_DIR: indexDir, CX_AUTO_SYNC: "0" });

/** The server flags that point a `cx` command at the hosted database: the
 * same for the MCP server of a hosted lane and for the `cx index` of
 * load-hosted.mjs, so the table is loaded the way the lane queries it. The
 * key travels as the path of its file; nothing here reads it. */
export function hostedFlags(env = process.env) {
  return [
    "--db",
    env[BENCH_DB_URL],
    "--api-key-file",
    env[BENCH_KEY_FILE],
    "--embed-provider",
    env[BENCH_EMBED_PROVIDER] ?? DEFAULT_HOSTED_EMBED_PROVIDER,
  ];
}

/** The server flags that add retrieval_agent to a hosted lane, with the turn
 * cap when the harness names one. */
export function agentFlags(env = process.env) {
  const cap = env[BENCH_AGENT_MAX_TURNS];
  return ["--retrieval-agent", ...(cap ? ["--agent-max-turns", cap] : [])];
}

/** The lane table. Each lane is the identical hermetic base plus:
 *   kind      "local" (index in .infino/ on this machine) or "hosted" (index
 *             in a platform database over HTTPS) - recorded on every row as
 *             laneKind, since the engine version differs between the two
 *   tools     the built-in tools the agent gets
 *   mcp       whether the code-context server is attached
 *   env       server env for the MCP lanes (repoDir, indexDir) => object
 *   args      extra flags for the server command line (env) => string[]
 *   disallowedTools  MCP tool names the SDK removes from the model's context
 *   agents    subagent definitions by name; a built-in name (Explore) is overridden
 *   requires  harness env vars that must be set before the lane can run
 *
 *   files      - stock file tools only
 *   cx         - the MCP tools plus Read (retrieval via the index)
 *   combo      - both, which is what installing the MCP server actually
 *                produces in a real client
 *   hosted     - combo, but the server talks to a platform database
 *   hosted-agent - hosted plus the retrieval_agent tool (the platform's own
 *                  agent loop)
 *   agent-only - Read plus retrieval_agent alone: find, search and sql are
 *                hidden, so every retrieval goes through the platform's agent.
 *                Measures that agent's answers and cost in isolation - not how
 *                often a model would choose it (hosted-agent measures that).
 *   stock-explore    - files plus the Agent tool with the built-in Explore
 *                      subagent: pure Sonnet as a real session has it
 *   index-explore    - stock-explore plus the local MCP server, with Explore
 *                      overridden to run on code-context's tools (Haiku inside)
 *   platform-explore - the same over the hosted server, with Explore
 *                      overridden to run on retrieval_agent alone */
export const LANES = {
  files: { kind: "local", tools: STOCK_TOOLS, mcp: false, requires: [] },
  cx: { kind: "local", tools: ["Read"], mcp: true, env: mcpEnvBase, requires: [] },
  combo: { kind: "local", tools: STOCK_TOOLS, mcp: true, env: mcpEnvBase, requires: [] },
  hosted: { kind: "hosted", tools: STOCK_TOOLS, mcp: true, env: mcpEnvBase, args: hostedFlags, requires: HOSTED_REQUIRES },
  "hosted-agent": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    requires: HOSTED_REQUIRES,
  },
  "agent-only": {
    kind: "hosted",
    tools: ["Read"],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    disallowedTools: CX_RETRIEVAL_TOOLS.map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  "stock-explore": { kind: "local", tools: [...STOCK_TOOLS, AGENT_TOOL], mcp: false, requires: [] },
  "index-explore": {
    kind: "local",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    agents: { [EXPLORE]: exploreOnIndex },
    requires: [],
  },
  "platform-explore": {
    kind: "hosted",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    agents: { [EXPLORE]: exploreOnPlatform },
    requires: HOSTED_REQUIRES,
  },
};

/** The lane definition for a name; an unknown name is a usage error, not a
 * silent fall-through to the files lane (which used to make a typo look like
 * a real baseline run). */
export function laneDef(lane) {
  const def = LANES[lane];
  if (!def) throw new Error(`unknown lane "${lane}" - one of: ${Object.keys(LANES).join(", ")}`);
  return def;
}

/** Fail fast, before any model call is paid for, when a lane's required env
 * is missing. Names only - the values are credentials. */
export function checkLaneEnv(lane, env = process.env) {
  const missing = laneDef(lane).requires.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`lane "${lane}" needs ${missing.join(" and ")} in the environment (${missing.length === 1 ? "it is" : "they are"} not set)`);
  }
}

/** The host of the platform database a hosted lane targets - host only, never
 * the key and never the path; null for a local lane or when unset. */
export function dbHost(lane, env = process.env) {
  if (laneDef(lane).kind !== "hosted" || !env[BENCH_DB_URL]) return null;
  try {
    return new URL(env[BENCH_DB_URL]).host;
  } catch {
    return null;
  }
}

/** Lane options: identical hermetic base; only the toolset and, for a hosted
 * lane, the server's command line differ. */
export function laneOptions(lane, repoDir, indexDir) {
  const def = laneDef(lane);
  checkLaneEnv(lane);
  const hermetic = {
    cwd: repoDir,
    settingSources: [],
    strictMcpConfig: true,
    tools: def.tools,
    ...(def.agents ? { agents: def.agents } : {}),
  };
  if (!def.mcp) return hermetic;
  return {
    ...hermetic,
    // The SDK drops disallowed tools from the model's context entirely (not a
    // permission denial the model would see), which is what makes a forced
    // lane a fair measurement: the hidden tools cost no prompt text either.
    ...(def.disallowedTools ? { disallowedTools: def.disallowedTools } : {}),
    mcpServers: {
      "code-context": {
        command: "node",
        args: [CX, "mcp", ...(def.args?.(process.env) ?? [])],
        // present in the turn-1 prompt (not deferred behind tool search),
        // and startup blocks until connected - no race on the first call
        alwaysLoad: true,
        env: { ...process.env, ...def.env(repoDir, indexDir) },
      },
    },
  };
}

export const shortToolName = (name) => name.replace(CX_TOOL_PREFIX, CX_SHORT_PREFIX);
export const isCxTool = (shortName) => shortName.startsWith(CX_SHORT_PREFIX);

/** The text a tool returned, from the structured `tool_use_result` the SDK
 * attaches to the user message when it has one (for an MCP tool that is the
 * server's own {content:[{type:"text",text}]} output), else from the
 * tool_result block's content (a string, or text blocks). null when neither
 * carries text. */
export function toolResultText(block, toolUseResult) {
  const fromBlocks = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
      return texts.length ? texts.join("\n") : null;
    }
    return null;
  };
  const structured = toolUseResult && typeof toolUseResult === "object" ? fromBlocks(toolUseResult.content) : null;
  return structured ?? fromBlocks(block?.content);
}

/** The per-call telemetry of one code-context result: the server-side
 * took_ms and the one-line usage receipt, both fields of the JSON the tool
 * returns. A result that is not JSON (an error message) yields nulls; the
 * call is still counted. */
export function parseCxResult(text) {
  if (typeof text !== "string") return { tookMs: null, usage: null };
  try {
    const v = JSON.parse(text);
    return {
      tookMs: typeof v?.took_ms === "number" ? v.took_ms : null,
      usage: typeof v?.usage === "string" ? v.usage : null,
    };
  } catch {
    return { tookMs: null, usage: null };
  }
}

/** Fold one SDK message into the per-run tool accounting. Assistant messages
 * carry the tool_use blocks (name + id); the user messages the CLI emits
 * carry the matching tool_result blocks, so the id joins the two. A message
 * with parent_tool_use_id set came from inside a subagent: its calls are
 * counted like any other and marked, and an Agent call records which
 * subagent type it spawned. Exported so the parsing is testable without a
 * model. */
export function foldToolMessage(acc, m) {
  if (m.type === "assistant") {
    const inSubagent = Boolean(m.parent_tool_use_id);
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") {
        const name = shortToolName(b.name);
        acc.toolCalls.push(name);
        const detail = { name, tookMs: null, usage: null, ...(inSubagent ? { inSubagent: true } : {}) };
        acc.toolDetails.push(detail);
        if (b.id) acc.pending.set(b.id, detail);
        if (inSubagent) acc.subagentCalls++;
        if (b.name === AGENT_TOOL) acc.subagents.push(typeof b.input?.subagent_type === "string" ? b.input.subagent_type : "?");
      }
    }
  }
  if (m.type === "user") {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const detail = acc.pending.get(b.tool_use_id);
      if (!detail) continue;
      acc.pending.delete(b.tool_use_id);
      if (b.is_error) detail.isError = true;
      if (!isCxTool(detail.name)) continue;
      const parsed = parseCxResult(toolResultText(b, m.tool_use_result));
      detail.tookMs = parsed.tookMs;
      detail.usage = parsed.usage;
    }
  }
}

export const newToolAccounting = () => ({ toolCalls: [], toolDetails: [], pending: new Map(), subagentCalls: 0, subagents: [] });

/** Sum of the server-side took_ms over the code-context calls of a run - the
 * engine work inside the question's wall clock. */
export const cxTookMs = (toolDetails) =>
  Math.round(toolDetails.reduce((n, d) => n + (isCxTool(d.name) && d.tookMs ? d.tookMs : 0), 0));

/** Run one agent conversation; returns the measured record. */
export async function runLane({ lane, prompt, system, repoDir, indexDir, maxTurns = 50 }) {
  const t0 = performance.now();
  const acc = newToolAccounting();
  let usage = null;
  let costUsd = null;
  let answer = "";
  let error = null;
  try {
    for await (const m of query({
      prompt,
      options: {
        model: MODEL,
        maxTurns,
        systemPrompt: system,
        permissionMode: "bypassPermissions",
        env: { ...process.env, IS_SANDBOX: "1" },
        ...laneOptions(lane, repoDir, indexDir),
      },
    })) {
      foldToolMessage(acc, m);
      if (m.type === "assistant") {
        for (const b of m.message.content ?? []) {
          if (b.type === "text") answer = b.text;
        }
      }
      if (m.type === "result") {
        usage = m.usage ?? null;
        costUsd = m.total_cost_usd ?? null;
        if (m.result) answer = m.result;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  const u = usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  const { toolCalls, toolDetails, subagentCalls, subagents } = acc;
  return {
    lane,
    laneKind: laneDef(lane).kind,
    dbHost: dbHost(lane),
    model: MODEL,
    build: BUILD,
    cli: CX,
    tokens,
    usage: u,
    costUsd,
    wallMs: Math.round(performance.now() - t0),
    toolCalls,
    toolDetails,
    cxTookMs: cxTookMs(toolDetails),
    calls: toolCalls.length,
    // Calls made inside subagents (a subset of `calls`) and the subagent
    // types the main agent spawned, in order - the delegation signal.
    subagentCalls,
    subagents,
    answer,
    error,
    ts: new Date().toISOString(),
  };
}

export function record(file, obj) {
  mkdirSync(RESULTS, { recursive: true });
  appendFileSync(join(RESULTS, file), JSON.stringify(obj) + "\n");
}
