// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Usage accounting: the per-call receipt and the on-disk ledger behind
// `cx usage`. Both are built from the same structured entry so the whole-file
// stat runs once. Everything is local and factual - tokens are a `~` chars/4
// estimate (we can't run the agent's tokenizer), and nothing leaves the
// machine: the ledger is a plain JSONL file inside the repo's index dir.

import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { jsonify, hostedTelemetry, type FindResult, type SearchResult } from "./searcher.js";
import type { RetrievalAgentResult, RetrievalAgentSpend } from "./retrieval-agent.js";
import type { HostedDb } from "./hosted.js";

/** Rough tokens-per-char - the standard heuristic for English + code. Kept
 * deliberately simple: usage reports `~` figures, not a billed count. */
const CHARS_PER_TOKEN = 4;

export const estTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Running totals for one server session (the long-lived `cx mcp` process). */
export interface SessionUsage {
  queries: number;
  returnedTokens: number;
}

export const newSession = (): SessionUsage => ({ queries: 0, returnedTokens: 0 });

/** Whether usage accounting is on. Default on - off only when CX_NO_RECEIPT is
 * set. One switch governs both the inline receipt and the ledger, shared by the
 * MCP server and the CLI. */
export const receiptEnabled = (): boolean =>
  !["1", "true", "yes"].includes((process.env.CX_NO_RECEIPT ?? "").toLowerCase());

// --- the structured entry ---------------------------------------------------

/** One recorded query: what was asked and a compact summary of what came back.
 * Deliberately does not store chunk content - the ledger points at path:line,
 * it doesn't duplicate the repo. */
export interface UsageEntry {
  ts: string;
  tool: "find" | "search" | "sql" | "retrieval_agent";
  query: string;
  returnedTokens: number;
  /** search only: whole-file size of the distinct files the hits came from. */
  wholeFileTokens?: number | null;
  ranking?: "hybrid" | "keyword";
  /** search and find: the response, as the regions you'd jump to (a find
   * match is a single line, so its start and end are the same). */
  hits?: Array<{ path: string; startLine: number; endLine: number }>;
  /** find only: matching lines across the repo, before the limit. */
  matches?: number;
  /** sql only. */
  rows?: number;
  /** sql only: a truncated preview of the returned rows (the answer itself). */
  rowsPreview?: string;
  /** retrieval_agent only: what the platform's agent spent on the question -
   * its turns and tokens. The platform bills these; the receipt shows them,
   * the tool result does not. */
  agentTurns?: number;
  agentPromptTokens?: number;
  agentCompletionTokens?: number;
  /** Hosted mode only: what the platform call behind this query cost - the
   * round trip of the answering request and the tokens the platform metered
   * (from its response headers, when present). Lives in the ledger, never in
   * the tool result, so the model sees the same shape in both modes. */
  platform?: { rttMs: number; readTokens?: number; writeTokens?: number };
}

/** Best-effort sum of the on-disk size (as tokens) of the distinct files the
 * hits came from - the "what reading them whole would cost" counterfactual.
 * Conservative: a file we can't stat is skipped, never guessed, so the figure
 * only ever understates the whole-file cost. null when nothing was stattable. */
function wholeFileTokens(paths: string[], root: string): number | null {
  let total = 0;
  let counted = 0;
  for (const p of paths) {
    try {
      total += Math.ceil(statSync(resolve(root, p)).size / CHARS_PER_TOKEN);
      counted++;
    } catch {
      // unreadable/moved since indexing - drop it rather than mislead
    }
  }
  return counted > 0 ? total : null;
}

export function searchEntry(result: SearchResult, root: string): UsageEntry {
  const hits = result.hits.map((h) => ({ path: h.path, startLine: h.startLine, endLine: h.endLine }));
  const files = [...new Set(hits.map((h) => h.path))];
  return {
    ts: new Date().toISOString(),
    tool: "search",
    query: result.query,
    returnedTokens: result.hits.reduce((n, h) => n + estTokens(h.content), 0),
    wholeFileTokens: wholeFileTokens(files, root),
    ranking: result.ranking,
    hits,
  };
}

/** A find returns one line per match, so what it cost is the serialized
 * matches themselves; the whole-file counterfactual is search's and does not
 * apply - grep never read the files whole either. */
export function findEntry(result: FindResult): UsageEntry {
  return {
    ts: new Date().toISOString(),
    tool: "find",
    query: result.query,
    returnedTokens: estTokens(jsonify(result.matches)),
    hits: result.matches.map((m) => ({ path: m.path, startLine: m.line, endLine: m.line })),
    matches: result.total,
  };
}

const ROWS_PREVIEW_CAP = 2000;

export function sqlEntry(query: string, rows: Array<Record<string, unknown>>): UsageEntry {
  const serialized = jsonify(rows);
  return {
    ts: new Date().toISOString(),
    tool: "sql",
    query,
    returnedTokens: estTokens(serialized),
    rows: rows.length,
    rowsPreview: serialized.length > ROWS_PREVIEW_CAP ? serialized.slice(0, ROWS_PREVIEW_CAP) + "..." : serialized,
  };
}

/** A retrieval_agent call returns an answer and the hits behind it, so what
 * it cost the outer agent is those two serialized; the loop's own spend
 * (turns, tokens) is the platform's meter and rides beside it in the ledger. */
export function retrievalAgentEntry(result: RetrievalAgentResult, spend: RetrievalAgentSpend): UsageEntry {
  return {
    ts: new Date().toISOString(),
    tool: "retrieval_agent",
    query: result.question,
    returnedTokens: estTokens(jsonify({ answer: result.answer, hits: result.hits })),
    agentTurns: result.turns,
    agentPromptTokens: spend.promptTokens,
    agentCompletionTokens: spend.completionTokens,
  };
}

/** Attach the platform telemetry of the hosted call that answered this entry's
 * query (its round trip and the tokens the platform metered) - read right
 * after the query, while the client's last call is that query's. A no-op for a
 * local handle. Ledger-only: the receipt and the tool result the model sees
 * are the same in both modes. Shared by the MCP server and the CLI so the two
 * ledgers record the same shape. */
export function withPlatform(entry: UsageEntry, source: { hosted?: HostedDb }): UsageEntry {
  const platform = hostedTelemetry(source);
  if (platform) entry.platform = platform;
  return entry;
}

// --- the one-line receipt ----------------------------------------------------

/** 1203 -> "1.2k", 300 -> "300". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The terse receipt line for an entry, ASCII-only so it can't mojibake.
 * Mutates and appends the running total when a session is supplied. */
export function formatReceipt(entry: UsageEntry, session?: SessionUsage): string {
  const parts: string[] = [];
  if (entry.tool === "search") {
    const hits = entry.hits ?? [];
    const files = new Set(hits.map((h) => h.path)).size;
    // Just what was returned - no "vs whole file" counterfactual here: it's an
    // estimate of a road not taken, not a measured saving, so we don't assert
    // it after every response. The raw wholeFileTokens still lives in the entry
    // for anyone who wants to reason about it from the ledger.
    parts.push(`returned ~${fmtTokens(entry.returnedTokens)} tokens | ${plural(hits.length, "chunk", "chunks")} / ${plural(files, "file", "files")}`);
  } else if (entry.tool === "find") {
    const hits = entry.hits ?? [];
    const files = new Set(hits.map((h) => h.path)).size;
    // The repo-wide count, not just the lines returned: a cut result still
    // tells the reader how many matches exist.
    parts.push(`returned ~${fmtTokens(entry.returnedTokens)} tokens | ${plural(entry.matches ?? hits.length, "match", "matches")} / ${plural(files, "file", "files")}`);
  } else if (entry.tool === "retrieval_agent") {
    // The inner agent's spend beside what came back: the platform bills the
    // turns and tokens, so the caller sees what one question cost there.
    parts.push(
      `returned ~${fmtTokens(entry.returnedTokens)} tokens | ${plural(entry.agentTurns ?? 0, "turn", "turns")} | ` +
        `${fmtTokens(entry.agentPromptTokens ?? 0)} prompt / ${fmtTokens(entry.agentCompletionTokens ?? 0)} completion tokens`,
    );
  } else {
    parts.push(`returned ~${fmtTokens(entry.returnedTokens)} tokens | ${plural(entry.rows ?? 0, "row", "rows")}`);
  }
  if (session) {
    session.queries++;
    session.returnedTokens += entry.returnedTokens;
    parts.push(`invoked ${session.queries}x this session (~${fmtTokens(session.returnedTokens)} tokens total)`);
  }
  return parts.join(" | ");
}

// --- the on-disk ledger ------------------------------------------------------

/** The usage log lives beside the manifest in the index dir; the engine ignores
 * foreign files in its catalog root, and `.infino/` is already gitignored. */
export const USAGE_LOG = "usage.jsonl";
export const usageLogPath = (indexDir: string): string => join(indexDir, USAGE_LOG);

/** Append one entry. Best-effort: accounting must never break a query, so a
 * write failure (read-only dir, race) is swallowed. */
export function recordUsage(indexDir: string, entry: UsageEntry): void {
  try {
    appendFileSync(usageLogPath(indexDir), jsonify(entry) + "\n");
  } catch {
    // logging is a convenience, not a guarantee
  }
}

/** Read the ledger back, oldest first. Tolerant of a partially-written last
 * line and of hand-edits - unparseable lines are skipped. */
export function readUsage(indexDir: string): UsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(usageLogPath(indexDir), "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageEntry);
    } catch {
      // skip a torn or edited line
    }
  }
  return out;
}

export function clearUsage(indexDir: string): void {
  rmSync(usageLogPath(indexDir), { force: true });
}

// --- prompt telemetry (local, via Claude Code hooks) ------------------------
//
// The receipt is server-side and can only count its own invocations - it can't
// see how many prompts you ran or turns where it wasn't called. That "used in
// K of N prompts" ratio lives in the client, so we collect it from Claude Code
// hooks: UserPromptSubmit ticks the prompt count, PostToolUse on a code-context
// tool ticks the invocation count (and marks the prompt as one that used it).
// Everything stays in a local file; nothing is sent anywhere.

export const PROMPT_STATS = "prompt-stats.json";
export const promptStatsPath = (indexDir: string): string => join(indexDir, PROMPT_STATS);

/** Per-session prompt/invocation counters, keyed by Claude Code session id. */
export interface PromptStats {
  sessionId: string;
  startedAt: string;
  lastAt: string;
  /** UserPromptSubmit events - how many prompts the user ran. */
  prompts: number;
  /** code-context tool invocations across the session. */
  cxCalls: number;
  /** prompts in which code-context was used at least once. */
  promptsWithCx: number;
  /** transient: has the current prompt already used code-context. */
  curPromptUsedCx: boolean;
  /** code-context invocations by tool (`find`, `search`, `sql`): which door
   * the agent actually walks through. Absent on stats files written before
   * it was recorded. */
  cxCallsByTool?: Record<string, number>;
  /** The first tool the agent called in each prompt, counted by name - a
   * code-context tool by its short name, anything else (Grep, Read, Bash)
   * by the name the hook delivered. This is the selection signal: whether a
   * grep-shaped prompt opens with `find` or with Grep. Only the tools the
   * PostToolUse hook is configured to forward are visible, so with the
   * default `mcp__code-context.*` matcher it records code-context tools
   * only; widen the matcher to see the rest. Absent on older stats files. */
  firstToolByPrompt?: Record<string, number>;
  /** transient: has the current prompt's first tool call been recorded. */
  curPromptFirstToolSeen?: boolean;
}

/** The shape Claude Code delivers to a hook command on stdin (subset we use). */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  cwd?: string;
}

/** A tool name is code-context's when it's one of our MCP tools - matches the
 * default server and any renamed variant (e.g. code-context-local). */
const isCodeContextTool = (name?: string): boolean => !!name && /^mcp__code[-_]?context/i.test(name);

/** The short tool name inside a code-context MCP tool id:
 * `mcp__code-context__find` -> `find`, `mcp__code-context-dev__sql` -> `sql`.
 * The server segment may carry a suffix, so the split is on the last `__`. */
export function codeContextToolName(name: string): string {
  const at = name.lastIndexOf("__");
  return at >= 0 ? name.slice(at + 2) : name;
}

/** Add one to `counts[key]`, creating the map or the key as needed. */
function bump(counts: Record<string, number> | undefined, key: string): Record<string, number> {
  const out = counts ?? {};
  out[key] = (out[key] ?? 0) + 1;
  return out;
}

const MAX_SESSIONS = 25;

function loadPromptStats(indexDir: string): Record<string, PromptStats> {
  try {
    return JSON.parse(readFileSync(promptStatsPath(indexDir), "utf8")) as Record<string, PromptStats>;
  } catch {
    return {};
  }
}

function savePromptStats(indexDir: string, all: Record<string, PromptStats>): void {
  // Keep the file bounded: newest MAX_SESSIONS sessions by last activity.
  const kept = Object.values(all)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, MAX_SESSIONS);
  const pruned: Record<string, PromptStats> = {};
  for (const s of kept) pruned[s.sessionId] = s;
  try {
    writeFileSync(promptStatsPath(indexDir), JSON.stringify(pruned, null, 2));
  } catch {
    // telemetry is a convenience, never fail the hook
  }
}

/** Fold one Claude Code hook event into the local counters. Best-effort.
 * Every PostToolUse event counts toward the first-tool-per-prompt tally
 * (whatever tools the hook matcher forwards); only code-context's own tools
 * count as invocations. */
export function recordHookEvent(indexDir: string, payload: HookPayload): void {
  const event = payload.hook_event_name ?? "";
  const isCx = event === "PostToolUse" && isCodeContextTool(payload.tool_name);
  const tracked = event === "UserPromptSubmit" || (event === "PostToolUse" && !!payload.tool_name);
  if (!tracked) return;

  const sid = payload.session_id ?? "unknown";
  const now = new Date().toISOString();
  const all = loadPromptStats(indexDir);
  const s: PromptStats =
    all[sid] ?? { sessionId: sid, startedAt: now, lastAt: now, prompts: 0, cxCalls: 0, promptsWithCx: 0, curPromptUsedCx: false };

  if (event === "UserPromptSubmit") {
    s.prompts++;
    s.curPromptUsedCx = false;
    s.curPromptFirstToolSeen = false;
  } else {
    const rawName = payload.tool_name ?? "";
    const label = isCx ? codeContextToolName(rawName) : rawName;
    // The first tool of a prompt is the selection signal; a call that lands
    // before any prompt was seen has no prompt to belong to and is not counted.
    if (!s.curPromptFirstToolSeen && s.prompts > 0) {
      s.firstToolByPrompt = bump(s.firstToolByPrompt, label);
      s.curPromptFirstToolSeen = true;
    }
    if (isCx) {
      s.cxCalls++;
      s.cxCallsByTool = bump(s.cxCallsByTool, label);
      if (!s.curPromptUsedCx && s.prompts > 0) {
        s.promptsWithCx++;
        s.curPromptUsedCx = true;
      }
    }
  }
  s.lastAt = now;
  all[sid] = s;
  savePromptStats(indexDir, all);
}

/** The most recently active session's counters, or null if none recorded. */
export function currentSessionStats(indexDir: string): PromptStats | null {
  const all = Object.values(loadPromptStats(indexDir));
  if (all.length === 0) return null;
  return all.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0];
}
