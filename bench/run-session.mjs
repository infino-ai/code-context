// The realistic-session invocation benchmark.
//
// Unlike run-invocation.mjs (one hermetic query per question), this runs ONE
// continuous conversation - shared context carried across turns via `resume` -
// inside a reproduction of the developer's REAL environment:
//   settingSources: ['user','project','local']  -> the actual ~/.claude config,
//   no strictMcpConfig, no tool pin -> every configured MCP server (code-context
//   competing against context7/slack/github/infino/... ), all plugins, skills,
//   slash commands and subagents load, exactly as in a real client. MCP tools
//   are NOT force-loaded into turn 1; the agent discovers and chooses them as
//   it would live.
//
// The turn script interleaves drift (Slack, calendar, docs, a concept refresher)
// between the codebase questions, so the codebase turns land AFTER context has
// drifted through other tools. We measure, per turn, whether code-context fired,
// and score recall / specificity over the drifted session.
//
// Usage: node run-session.mjs [repoPath] [turnsFile]
//   repoPath   the repo under test (default ../../infino)
//   turnsFile  default questions/session-drift.json
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { record, MODEL, BENCH } from "./lanes.mjs";

const repoDir = resolve(process.argv[2] ?? process.env.CX_BENCH_REPO ?? join(BENCH, "..", "..", "infino"));
const turnsFile = process.argv[3] ?? join(BENCH, "questions", "session-drift.json");
const { turns } = JSON.parse(readFileSync(turnsFile, "utf8"));
const MAX_TURNS_PER = Number(process.env.CX_SESSION_MAXTURNS ?? 30);

// Opt-in: inject the LOCAL build as `code-context-local` with the alwaysLoad
// _meta marker on, so we test the prototype inside the full real environment
// (drift + all the user's servers/skills). The user's config only carries the
// published `code-context` (deferred), so this is how the local build enters.
const CX = resolve(BENCH, "..", "dist", "cli.js");
const indexDir = join(repoDir, ".infino");
const injectLocal = ["1", "true", "yes"].includes((process.env.INJECT_LOCAL_CX ?? "").toLowerCase());

const system =
  `You are a coding assistant in a developer's session. The current working ` +
  `directory is a git checkout at ${repoDir}. Help with each request. Use ` +
  `whatever tools are appropriate, or none if you don't need them.`;

const baseOptions = {
  model: MODEL,
  cwd: repoDir,
  systemPrompt: system,
  settingSources: ["user", "project", "local"], // real config: all MCP/plugins/skills
  permissionMode: "bypassPermissions",
  maxTurns: MAX_TURNS_PER,
  env: { ...process.env, IS_SANDBOX: "1" },
  // deliberately NO strictMcpConfig and NO tools pin -> full real environment
  ...(injectLocal
    ? {
        mcpServers: {
          "code-context-local": {
            command: "node",
            args: [CX, "mcp"],
            env: { ...process.env, CX_ROOT: repoDir, CX_INDEX_DIR: indexDir, CX_AUTO_SYNC: "0", CX_ALWAYS_LOAD: "1" },
          },
        },
      }
    : {}),
};

const isCx = (name) => name.startsWith("mcp__code-context");
const shortName = (name) =>
  name.startsWith("mcp__") ? name.replace(/^mcp__/, "").replace(/__/, ":") : name;

async function runTurn(prompt, resumeId) {
  const toolCalls = [];
  let sessionId = resumeId ?? null;
  let answer = "";
  let error = null;
  let initServers = null;
  try {
    for await (const m of query({
      prompt,
      options: resumeId ? { ...baseOptions, resume: resumeId } : baseOptions,
    })) {
      if (m.type === "system" && m.subtype === "init") {
        initServers = (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`);
      }
      if (m.type === "assistant") {
        for (const b of m.message.content ?? []) {
          if (b.type === "tool_use") toolCalls.push(b.name);
          if (b.type === "text") answer = b.text;
        }
      }
      if (m.type === "result") {
        sessionId = m.session_id ?? sessionId;
        if (m.result) answer = m.result;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  return { toolCalls, sessionId, answer, error, initServers };
}

console.log(`model=${MODEL}  repo=${repoDir.split("/").pop()}  turns=${turns.length}  (real config: settingSources=user,project,local)\n`);

const results = [];
let resumeId = null;
for (let i = 0; i < turns.length; i++) {
  const t = turns[i];
  process.stdout.write(`(${i + 1}/${turns.length}) [${t.expect}] ${t.id} (${t.topic}) … `);
  const r = await runTurn(t.q, resumeId);
  if (i === 0 && r.initServers) console.log(`\n   env mcp: ${r.initServers.join(", ")}`);
  resumeId = r.sessionId ?? resumeId;
  const cx = r.toolCalls.filter(isCx).map((n) => shortName(n).replace("code-context:", ""));
  const fired = cx.length > 0;
  let correct = null;
  if (t.expect === "fire") correct = fired;
  else if (t.expect === "nofire") correct = !fired;
  const other = r.toolCalls.filter((n) => !isCx(n)).map(shortName);
  results.push({ ...t, fired, correct, cx, allTools: r.toolCalls.map(shortName), error: r.error });
  record("session-drift.jsonl", {
    turn: i + 1, id: t.id, expect: t.expect, topic: t.topic,
    fired, correct, cx, otherTools: other, error: r.error,
    sessionId: resumeId, answer: r.answer.slice(0, 800), ts: new Date().toISOString(),
  });
  const mark = correct === null ? "·" : correct ? "✓" : "✗";
  console.log(
    `${mark} fired=${fired}` +
      (cx.length ? ` {${cx.join(",")}}` : "") +
      `  tools: ${other.length ? other.join(", ") : "(none)"}` +
      (r.error ? "  ERR" : "")
  );
}

// ---- score over the drifted session ----
const fireQ = results.filter((r) => r.expect === "fire");
const nofireQ = results.filter((r) => r.expect === "nofire");
const recall = fireQ.length ? fireQ.filter((r) => r.fired).length / fireQ.length : null;
const specificity = nofireQ.length ? nofireQ.filter((r) => !r.fired).length / nofireQ.length : null;
const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

console.log("\n──────── realistic-session summary ────────");
console.log(`recall      (fired when it should):      ${pct(recall)}  (${fireQ.filter((r) => r.fired).length}/${fireQ.length})`);
console.log(`specificity (stayed out when it should): ${pct(specificity)}  (${nofireQ.filter((r) => !r.fired).length}/${nofireQ.length})`);
const misfires = results.filter((r) => r.correct === false);
if (misfires.length) console.log(`misfires: ${misfires.map((r) => `${r.id}(${r.expect},fired=${r.fired})`).join(", ")}`);
record("session-drift-summary.jsonl", { ts: new Date().toISOString(), model: MODEL, repo: repoDir, n: results.length, recall, specificity, misfires: misfires.map((r) => r.id) });
