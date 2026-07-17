import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  estTokens,
  newSession,
  searchEntry,
  sqlEntry,
  formatReceipt,
  recordUsage,
  readUsage,
  clearUsage,
  usageLogPath,
  recordHookEvent,
  currentSessionStats,
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
});
