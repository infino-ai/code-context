// Shared lane plumbing: hermetic agent runs where the only variable is the
// toolset. Exported for the question and localization runners.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const WORK = join(BENCH, ".work");
export const RESULTS = join(WORK, "results");
export const CX = resolve(BENCH, "..", "dist", "cli.js");
export const MODEL = process.env.BENCH_MODEL ?? "claude-opus-4-8";

/** Lane options: identical hermetic base, only the toolset differs. */
export function laneOptions(lane, repoDir, indexDir) {
  const hermetic = { cwd: repoDir, settingSources: [], strictMcpConfig: true };
  if (lane === "cx") {
    return {
      ...hermetic,
      // retrieval via the index; Read stays for following citations
      tools: ["Read"],
      mcpServers: {
        "code-context": {
          command: "node",
          args: [CX, "mcp"],
          // present in the turn-1 prompt (not deferred behind tool search),
          // and startup blocks until connected - no race on the first call
          alwaysLoad: true,
          env: { ...process.env, CX_ROOT: repoDir, CX_INDEX_DIR: indexDir, CX_AUTO_SYNC: "0" },
        },
      },
    };
  }
  // stock file-tool lane
  return { ...hermetic, tools: ["Glob", "Grep", "Read", "LS"] };
}

/** Run one agent conversation; returns the measured record. */
export async function runLane({ lane, prompt, system, repoDir, indexDir, maxTurns = 10 }) {
  const t0 = performance.now();
  const toolCalls = [];
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
      if (m.type === "assistant") {
        for (const b of m.message.content ?? []) {
          if (b.type === "tool_use") toolCalls.push(b.name.replace("mcp__code-context__", "cx:"));
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
  return {
    lane,
    model: MODEL,
    tokens,
    usage: u,
    costUsd,
    wallMs: Math.round(performance.now() - t0),
    toolCalls,
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
