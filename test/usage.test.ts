import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  estTokens,
  newSession,
  findEntry,
  searchEntry,
  sqlEntry,
  formatReceipt,
  recordUsage,
  readUsage,
  clearUsage,
  usageLogPath,
  recordHookEvent,
  currentSessionStats,
  codeContextToolName,
  promptStatsPath,
} from "../src/core/usage.js";
import type { SearchResult, SearchHit } from "../src/core/searcher.js";

const hit = (path: string, content: string): SearchHit => ({
  path,
  startLine: 1,
  endLine: 10,
  lang: "ts",
  score: 1,
  content,
});

const result = (hits: SearchHit[]): SearchResult => ({ query: "q", ranking: "keyword", hits });

describe("estTokens", () => {
  it("estimates ~chars/4", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
  });
});

describe("search receipt", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cx-usage-"));
    writeFileSync(join(root, "a.ts"), "x".repeat(4000)); // ~1k tokens on disk
    writeFileSync(join(root, "b.ts"), "y".repeat(4000));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports tokens returned and chunks/files, with no trailing markers", () => {
    const line = formatReceipt(searchEntry(result([hit("a.ts", "z".repeat(400)), hit("a.ts", "z".repeat(400))]), root));
    expect(line).toBe("returned ~200 tokens | 2 chunks / 1 file");
  });

  it("does not assert a whole-file counterfactual in the receipt", () => {
    // The estimate still lives on the entry (for the ledger), but the receipt
    // shown after every response makes no "vs reading them whole" claim.
    const entry = searchEntry(result([hit("a.ts", "z".repeat(40)), hit("b.ts", "z".repeat(40))]), root);
    expect(entry.wholeFileTokens).toBeGreaterThan(0);
    const line = formatReceipt(entry);
    expect(line).not.toMatch(/whole/);
    expect(line).not.toMatch(/\bvs\b/);
  });

  it("accumulates the session invocation count and token total across calls", () => {
    const session = newSession();
    formatReceipt(searchEntry(result([hit("a.ts", "z".repeat(400))]), root), session); // +100
    const line = formatReceipt(searchEntry(result([hit("a.ts", "z".repeat(400))]), root), session); // +100
    expect(session.queries).toBe(2);
    expect(session.returnedTokens).toBe(200);
    expect(line).toMatch(/invoked 2x this session \(~200 tokens total\)/);
  });

  it("counts the first call as invoked 1x", () => {
    const session = newSession();
    const line = formatReceipt(searchEntry(result([hit("a.ts", "z".repeat(40))]), "/nope"), session);
    expect(line).toMatch(/invoked 1x this session/);
  });
});

describe("find receipt", () => {
  const found = {
    query: "x",
    ignoreCase: false,
    total: 3,
    files: 1,
    byFile: [{ path: "a.ts", count: 3 }],
    truncated: true,
    matches: [
      { path: "a.ts", line: 3, text: "x = 1" },
      { path: "a.ts", line: 9, text: "x = 2" },
    ],
  };

  it("reports the repo-wide match count and the files, not just the lines returned", () => {
    const line = formatReceipt(findEntry(found));
    expect(line).toMatch(/^returned ~\d+ tokens \| 3 matches \/ 1 file$/);
  });

  it("records each match as a one-line region in the ledger", () => {
    const entry = findEntry(found);
    expect(entry.tool).toBe("find");
    expect(entry.hits).toEqual([
      { path: "a.ts", startLine: 3, endLine: 3 },
      { path: "a.ts", startLine: 9, endLine: 9 },
    ]);
    expect(entry.matches).toBe(3);
    expect(entry.wholeFileTokens).toBeUndefined();
  });
});

describe("sql receipt", () => {
  it("reports row count and token estimate of the rows", () => {
    const line = formatReceipt(sqlEntry("SELECT 1", [{ path: "a.ts", lines: 12 }, { path: "b.ts", lines: 8 }]));
    expect(line).toMatch(/^returned ~\d+ tokens \| 2 rows$/);
  });

  it("accumulates into the session and has no whole-file clause", () => {
    const session = newSession();
    const line = formatReceipt(sqlEntry("SELECT 1", [{ a: 1 }]), session);
    expect(session.queries).toBe(1);
    expect(line).not.toMatch(/to read those files whole/);
    expect(line).toMatch(/invoked 1x this session/);
  });
});

describe("the ledger", () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), "cx-ledger-"))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips entries oldest-first and captures the response summary", () => {
    recordUsage(dir, searchEntry({ query: "auth", ranking: "hybrid", hits: [hit("a.ts", "zzzz")] }, dir));
    recordUsage(dir, sqlEntry("SELECT count(*)", [{ n: 3 }]));
    const entries = readUsage(dir);
    expect(entries.map((e) => e.tool)).toEqual(["search", "sql"]);
    expect(entries[0].query).toBe("auth");
    expect(entries[0].hits?.[0]).toMatchObject({ path: "a.ts", startLine: 1, endLine: 10 });
    expect(entries[1].rows).toBe(1);
  });

  it("skips torn / hand-edited lines instead of throwing", () => {
    writeFileSync(usageLogPath(dir), '{"tool":"search"}\nnot json\n', { flag: "a" });
    expect(() => readUsage(dir)).not.toThrow();
    expect(readUsage(dir).length).toBeGreaterThanOrEqual(3);
  });

  it("clears the log", () => {
    clearUsage(dir);
    expect(existsSync(usageLogPath(dir))).toBe(false);
    expect(readUsage(dir)).toEqual([]);
  });
});

describe("prompt telemetry (hooks)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "cx-hooks-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const submit = (sid: string) => recordHookEvent(dir, { hook_event_name: "UserPromptSubmit", session_id: sid });
  const cxCall = (sid: string) => recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: sid, tool_name: "mcp__code-context__search" });
  const otherCall = (sid: string) => recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: sid, tool_name: "Grep" });

  it("counts prompts, cx calls, and prompts-that-used-cx (once per prompt)", () => {
    submit("s1");
    cxCall("s1");
    cxCall("s1"); // 2 calls in prompt 1, but the prompt counts once
    submit("s1"); // prompt 2, no cx
    submit("s1"); // prompt 3
    cxCall("s1");
    const s = currentSessionStats(dir);
    expect(s?.prompts).toBe(3);
    expect(s?.cxCalls).toBe(3);
    expect(s?.promptsWithCx).toBe(2);
  });

  it("ignores tools that aren't code-context", () => {
    submit("s1");
    otherCall("s1");
    const s = currentSessionStats(dir);
    expect(s?.cxCalls).toBe(0);
    expect(s?.promptsWithCx).toBe(0);
  });

  it("counts a matching variant like code-context-local", () => {
    recordHookEvent(dir, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context-local__sql" });
    expect(currentSessionStats(dir)?.cxCalls).toBe(1);
  });

  it("does not let promptsWithCx exceed prompts when a call precedes any prompt", () => {
    cxCall("s1"); // no UserPromptSubmit yet
    const s = currentSessionStats(dir);
    expect(s?.cxCalls).toBe(1);
    expect(s?.prompts).toBe(0);
    expect(s?.promptsWithCx).toBe(0);
  });

  it("returns null when nothing is recorded", () => {
    expect(currentSessionStats(dir)).toBeNull();
  });

  it("counts code-context calls by tool and the first tool of each prompt", () => {
    // Prompt 1 opens with find and also uses sql; prompt 2 opens with Grep
    // (a non-code-context tool, forwarded by a widened matcher) and then
    // reaches search; prompt 3 opens with find. Selection is the first call.
    submit("s1");
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context__find" });
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context__sql" });
    submit("s1");
    otherCall("s1"); // Grep
    cxCall("s1"); // search
    submit("s1");
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context__find" });
    const s = currentSessionStats(dir);
    expect(s?.cxCallsByTool).toEqual({ find: 2, sql: 1, search: 1 });
    expect(s?.firstToolByPrompt).toEqual({ find: 2, Grep: 1 });
    // The non-code-context call is not an invocation, and the prompt it
    // opened still counts as one that used code-context (search came later).
    expect(s?.cxCalls).toBe(4);
    expect(s?.promptsWithCx).toBe(3);
  });

  it("names a tool from a renamed server variant by its short name", () => {
    submit("s1");
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context-dev__reindex" });
    expect(currentSessionStats(dir)?.cxCallsByTool).toEqual({ reindex: 1 });
    expect(currentSessionStats(dir)?.firstToolByPrompt).toEqual({ reindex: 1 });
  });

  it("loads a stats file written before the per-tool fields existed", () => {
    writeFileSync(
      promptStatsPath(dir),
      JSON.stringify({
        old: { sessionId: "old", startedAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z", prompts: 2, cxCalls: 1, promptsWithCx: 1, curPromptUsedCx: false },
      }),
    );
    // A new event on the old session adds the fields rather than tripping on their absence.
    recordHookEvent(dir, { hook_event_name: "UserPromptSubmit", session_id: "old" });
    cxCall("old");
    const s = currentSessionStats(dir);
    expect(s?.prompts).toBe(3);
    expect(s?.cxCallsByTool).toEqual({ search: 1 });
    expect(s?.firstToolByPrompt).toEqual({ search: 1 });
  });
});

describe("codeContextToolName", () => {
  it("strips the server prefix however the server was named", () => {
    expect(codeContextToolName("mcp__code-context__find")).toBe("find");
    expect(codeContextToolName("mcp__code-context-dev__sql")).toBe("sql");
    expect(codeContextToolName("mcp__code_context_local__search")).toBe("search");
    expect(codeContextToolName("Grep")).toBe("Grep");
  });
});
