// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Outer caller for OpenRouter-only model families (DeepSeek, Kimi, …).
// OpenRouter works on the platform inner loop; Claude Code rejects those model
// ids even with ANTHROPIC_BASE_URL pointed at OpenRouter. This runner calls
// OpenRouter chat/completions directly and executes stock + MCP tools locally.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  OPENROUTER_BASE_URL,
  openRouterConfigured,
} from "./caller-models.mjs";
import {
  BUILD,
  CX,
  CX_TOOL_PREFIX,
  foldToolMessage,
  laneDef,
  laneOptions,
  dbHost,
  newToolAccounting,
  cxTookMs,
  sfTookMs,
} from "./lanes.mjs";

const AGENT_TOOL = "Agent";
const STOCK_TOOL_NAMES = new Set(["Glob", "Grep", "Read", "LS", "Bash"]);

function openRouterHeaders(env = process.env) {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is required for OpenRouter caller models");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.OPENROUTER_HTTP_REFERER ?? "https://infino.ai",
    "X-Title": env.OPENROUTER_X_TITLE ?? "Infino side-by-side demo",
  };
}

function openRouterUrl(env = process.env) {
  const base = (env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

const TOOL_RESULT_CHARS = 12_000;
const OPENROUTER_FETCH_MS = 180_000;

async function openRouterChat(body, env = process.env) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPENROUTER_FETCH_MS);
  try {
    const res = await fetch(openRouterUrl(env), {
      method: "POST",
      headers: openRouterHeaders(env),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`OpenRouter non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(parsed?.error?.message ?? `OpenRouter HTTP ${res.status}`);
    }
    return parsed;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`OpenRouter request timed out after ${OPENROUTER_FETCH_MS / 1000}s`);
    }
    const msg = String(err?.message ?? err);
    if (msg === "fetch failed" && err?.cause) {
      throw new Error(`OpenRouter network error: ${err.cause}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function trimToolContent(text) {
  if (typeof text !== "string") return text;
  if (text.length <= TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_CHARS)}… (${text.length} chars truncated)`;
}

function globFiles(cwd, pattern, root) {
  const base = resolve(cwd, root ?? ".");
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      const rel = relative(cwd, p);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (matchGlob(pattern, rel)) out.push(rel);
      if (out.length >= 200) return;
    }
  };
  walk(base, 0);
  return out;
}

function matchGlob(pattern, path) {
  const re = new RegExp(
    `^${pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`,
  );
  return re.test(path);
}

function runStockTool(name, input, repoDir) {
  const cwd = repoDir;
  if (name === "Read") {
    const fp = input?.file_path ?? input?.path;
    if (typeof fp !== "string") return { error: "Read needs file_path" };
    const abs = resolve(cwd, fp);
    if (!abs.startsWith(resolve(cwd))) return { error: "path outside repo" };
    try {
      const text = readFileSync(abs, "utf8");
      const limit = input?.limit ?? 2000;
      const offset = input?.offset ?? 1;
      const lines = text.split("\n");
      const slice = lines.slice(Math.max(0, offset - 1), offset - 1 + limit);
      return { content: slice.map((l, i) => `${offset + i}|${l}`).join("\n") };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  }
  if (name === "Grep") {
    const pattern = input?.pattern;
    if (typeof pattern !== "string") return { error: "Grep needs pattern" };
    const path = input?.path ?? ".";
    const r = spawnSync("rg", ["-n", "--max-count", "80", pattern, path], { cwd, encoding: "utf8" });
    if (r.error?.code === "ENOENT") {
      return { error: "rg not installed on host" };
    }
    return { content: (r.stdout || r.stderr || "").slice(0, 120_000) || "(no matches)" };
  }
  if (name === "Glob") {
    const pattern = input?.pattern ?? input?.glob_pattern;
    if (typeof pattern !== "string") return { error: "Glob needs pattern" };
    const files = globFiles(cwd, pattern, input?.path ?? ".");
    return { content: files.join("\n") || "(no files)" };
  }
  if (name === "LS") {
    const path = input?.path ?? ".";
    try {
      const abs = resolve(cwd, path);
      const entries = readdirSync(abs, { withFileTypes: true });
      return {
        content: entries.map((e) => `${e.isDirectory() ? "d" : "f"}\t${join(path, e.name)}`).join("\n"),
      };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  }
  if (name === "Bash") {
    return { error: "Bash is disabled for OpenRouter caller runs" };
  }
  if (name === AGENT_TOOL) {
    return {
      error:
        "Explore subagents require Claude Code; use Read/Grep/Glob and code-context tools (find/search/ask) directly.",
    };
  }
  return { error: `unknown stock tool ${name}` };
}

async function connectMcpServers(mcpServers) {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const clients = [];
  for (const [serverName, cfg] of Object.entries(mcpServers)) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
      cwd: cfg.cwd,
    });
    const client = new Client({ name: `openrouter-lane-${serverName}`, version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    clients.push({ serverName, client, tools });
  }
  return clients;
}

async function closeMcpClients(clients) {
  for (const { client } of clients) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

function mcpToolOpenAiName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`.slice(0, 64);
}

function buildToolSchemas(def, mcpClients) {
  const allowed = new Set(def.tools.filter((t) => t !== AGENT_TOOL));
  const tools = [];
  for (const name of allowed) {
    if (STOCK_TOOL_NAMES.has(name)) {
      tools.push({
        type: "function",
        function: {
          name,
          description: `Stock ${name} tool over the repository checkout`,
          parameters: { type: "object", properties: {}, additionalProperties: true },
        },
      });
    }
  }
  for (const { serverName, tools: mcpTools } of mcpClients) {
    for (const t of mcpTools) {
      if (!t.name) continue;
      const sdkName = `${CX_TOOL_PREFIX}${t.name}`;
      if (def.disallowedTools?.includes(sdkName)) continue;
      tools.push({
        type: "function",
        function: {
          name: mcpToolOpenAiName(serverName, t.name),
          description: t.description ?? t.name,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return tools;
}

async function executeToolCall(name, args, repoDir, mcpClients) {
  if (STOCK_TOOL_NAMES.has(name) || name === AGENT_TOOL) {
    const out = runStockTool(name, args, repoDir);
    return typeof out.content === "string" ? out.content : JSON.stringify(out);
  }
  for (const { serverName, client, tools } of mcpClients) {
    for (const t of tools) {
      if (mcpToolOpenAiName(serverName, t.name) !== name) continue;
      const result = await client.callTool({ name: t.name, arguments: args ?? {} });
      const text =
        result.content
          ?.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n") ?? JSON.stringify(result);
      return text;
    }
  }
  return JSON.stringify({ error: `unknown tool ${name}` });
}

function sdkNameForOpenAiTool(openAiName, mcpClients) {
  if (STOCK_TOOL_NAMES.has(openAiName) || openAiName === AGENT_TOOL) return openAiName;
  for (const { serverName, tools } of mcpClients) {
    for (const t of tools) {
      if (mcpToolOpenAiName(serverName, t.name) === openAiName) {
        return `${CX_TOOL_PREFIX}${t.name}`;
      }
    }
  }
  return openAiName;
}

function foldSynthetic(acc, role, content, now, emit) {
  const m =
    role === "assistant"
      ? { type: "assistant", message: { content } }
      : { type: "user", message: { content } };
  const { started, ended } = foldToolMessage(acc, m, now);
  if (emit) {
    for (const d of started) emit({ at: now, kind: "tool_start", name: d.name, batch: d.batch, inSubagent: false });
    for (const d of ended) emit({ at: now, kind: "tool_end", name: d.name, batch: d.batch, inSubagent: false });
  }
}

/** Same contract as `runLane` in lanes.mjs. */
export async function runOpenRouterLane({
  lane,
  prompt,
  system,
  repoDir,
  indexDir,
  maxTurns = 50,
  onEvent,
  serverEnv,
  model,
  family: _family,
}) {
  if (!openRouterConfigured()) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter caller models");
  }
  const t0 = performance.now();
  const acc = newToolAccounting();
  const emit = onEvent
    ? (event) => {
        try {
          onEvent(event);
        } catch {
          /* listener */
        }
      }
    : null;

  const def = laneDef(lane);
  const options = laneOptions(lane, repoDir, indexDir, serverEnv);
  let mcpClients = [];
  let answer = "";
  let error = null;
  let totalIn = 0;
  let totalOut = 0;

  try {
    mcpClients = await connectMcpServers(options.mcpServers);
    const tools = buildToolSchemas(def, mcpClients);
    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
      const body = await openRouterChat({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        max_tokens: 8192,
      });
      totalIn += body.usage?.prompt_tokens ?? 0;
      totalOut += body.usage?.completion_tokens ?? 0;
      const msg = body.choices?.[0]?.message;
      if (!msg) throw new Error("OpenRouter returned no message");

      if (msg.content) answer = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

      const toolCalls = msg.tool_calls ?? [];
      if (!toolCalls.length) break;

      messages.push(msg);

      const assistantBlocks = [];
      const resultBlocks = [];
      for (const tc of toolCalls) {
        const id = tc.id ?? `call_${turn}_${assistantBlocks.length}`;
        const fn = tc.function ?? {};
        const openAiName = fn.name;
        let args = {};
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          args = {};
        }
        const sdkToolName = sdkNameForOpenAiTool(openAiName, mcpClients);
        assistantBlocks.push({ type: "tool_use", id, name: sdkToolName, input: args });
      }
      const atAssist = Math.round(performance.now() - t0);
      foldSynthetic(acc, "assistant", assistantBlocks, atAssist, emit);

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const id = assistantBlocks[i].id;
        const openAiName = tc.function?.name;
        let args = assistantBlocks[i].input;
        let resultText;
        try {
          resultText = await executeToolCall(openAiName, args, repoDir, mcpClients);
        } catch (e) {
          resultText = JSON.stringify({ error: String(e.message ?? e) });
        }
        resultBlocks.push({ type: "tool_result", tool_use_id: id, content: resultText });
        messages.push({ role: "tool", tool_call_id: id, content: trimToolContent(resultText) });
      }
      const atUser = Math.round(performance.now() - t0);
      foldSynthetic(acc, "user", resultBlocks, atUser, emit);
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  } finally {
    await closeMcpClients(mcpClients);
  }

  const usage = { input_tokens: totalIn, output_tokens: totalOut };
  const tokens = totalIn + totalOut;
  const { toolCalls, toolDetails, subagentCalls, subagents } = acc;
  return {
    lane,
    laneKind: def.kind,
    dbHost: dbHost(lane),
    model,
    build: BUILD,
    cli: CX,
    tokens,
    usage,
    costUsd: null,
    modelUsage: null,
    durationApiMs: null,
    wallMs: Math.round(performance.now() - t0),
    toolCalls,
    toolDetails,
    cxTookMs: cxTookMs(toolDetails),
    sfTookMs: sfTookMs(toolDetails),
    calls: toolCalls.length,
    subagentCalls,
    subagents,
    answer,
    error,
    ts: new Date().toISOString(),
  };
}
