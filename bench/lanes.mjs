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
/** The embedding provider a hosted lane's server uses when the caller does
 * not pick one: the same local model the local lanes run, so the two differ
 * in where the index lives and nothing else. */
const DEFAULT_HOSTED_EMBED_PROVIDER = "local";

/** Server env that is common to every MCP lane. Auto-sync is off in every
 * lane: the index is built before the run and a re-sync mid-question would
 * put a stat walk on the clock. */
const mcpEnvBase = (repoDir, indexDir) => ({ CX_ROOT: repoDir, CX_INDEX_DIR: indexDir, CX_AUTO_SYNC: "0" });

/** Server env for a hosted lane: the index lives in a platform database and
 * the server reaches it over HTTPS. Auto-index is off too - a hosted build is
 * a separate, metered step (load-hosted.mjs), never something a question
 * triggers. The key is passed through by name only; nothing here reads it. */
const hostedEnv = (repoDir, indexDir) => ({
  ...mcpEnvBase(repoDir, indexDir),
  CX_DB_URL: process.env.CX_DB_URL,
  INFINO_API_KEY: process.env.INFINO_API_KEY,
  CX_AUTO_INDEX: "0",
  CX_EMBED_PROVIDER: process.env.CX_EMBED_PROVIDER ?? DEFAULT_HOSTED_EMBED_PROVIDER,
});

/** The lane table. Each lane is the identical hermetic base plus:
 *   kind      "local" (index in .infino/ on this machine) or "hosted" (index
 *             in a platform database over HTTPS) - recorded on every row as
 *             laneKind, since the engine version differs between the two
 *   tools     the built-in tools the agent gets
 *   mcp       whether the code-context server is attached
 *   env       server env for the MCP lanes (repoDir, indexDir) => object
 *   requires  env vars that must be set before the lane can run
 *
 *   files      - stock file tools only
 *   cx         - the MCP tools plus Read (retrieval via the index)
 *   combo      - both, which is what installing the MCP server actually
 *                produces in a real client
 *   hosted     - combo, but the server talks to a platform database
 *   hosted-agent - hosted plus the retrieval_agent tool (the platform's own
 *                  agent loop) */
export const LANES = {
  files: { kind: "local", tools: STOCK_TOOLS, mcp: false, requires: [] },
  cx: { kind: "local", tools: ["Read"], mcp: true, env: mcpEnvBase, requires: [] },
  combo: { kind: "local", tools: STOCK_TOOLS, mcp: true, env: mcpEnvBase, requires: [] },
  hosted: { kind: "hosted", tools: STOCK_TOOLS, mcp: true, env: hostedEnv, requires: ["CX_DB_URL", "INFINO_API_KEY"] },
  "hosted-agent": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: (repoDir, indexDir) => ({ ...hostedEnv(repoDir, indexDir), CX_RETRIEVAL_AGENT: "1" }),
    requires: ["CX_DB_URL", "INFINO_API_KEY"],
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
  if (laneDef(lane).kind !== "hosted" || !env.CX_DB_URL) return null;
  try {
    return new URL(env.CX_DB_URL).host;
  } catch {
    return null;
  }
}

/** Lane options: identical hermetic base, only the toolset differs. */
export function laneOptions(lane, repoDir, indexDir) {
  const def = laneDef(lane);
  checkLaneEnv(lane);
  const hermetic = { cwd: repoDir, settingSources: [], strictMcpConfig: true, tools: def.tools };
  if (!def.mcp) return hermetic;
  return {
    ...hermetic,
    mcpServers: {
      "code-context": {
        command: "node",
        args: [CX, "mcp"],
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
 * carry the matching tool_result blocks, so the id joins the two. Exported
 * so the parsing is testable without a model. */
export function foldToolMessage(acc, m) {
  if (m.type === "assistant") {
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") {
        const name = shortToolName(b.name);
        acc.toolCalls.push(name);
        const detail = { name, tookMs: null, usage: null };
        acc.toolDetails.push(detail);
        if (b.id) acc.pending.set(b.id, detail);
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

export const newToolAccounting = () => ({ toolCalls: [], toolDetails: [], pending: new Map() });

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
  const { toolCalls, toolDetails } = acc;
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
    answer,
    error,
    ts: new Date().toISOString(),
  };
}

export function record(file, obj) {
  mkdirSync(RESULTS, { recursive: true });
  appendFileSync(join(RESULTS, file), JSON.stringify(obj) + "\n");
}
