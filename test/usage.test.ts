import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  estTokens,
  newSession,
  sqlEntry,
  formatReceipt,
  recordUsage,
  readUsage,
  clearUsage,
  usageLogPath,
  recordHookEvent,
  currentSessionStats,
} from "../src/core/usage.js";
describe("estTokens", () => {
  it("estimates ~chars/4", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
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

  it("accumulates the invocation count and token total across calls", () => {
    const session = newSession();
    formatReceipt(sqlEntry("SELECT 1", [{ z: "z".repeat(396) }]), session);
    const line = formatReceipt(sqlEntry("SELECT 1", [{ z: "z".repeat(396) }]), session);
    expect(session.queries).toBe(2);
    expect(line).toMatch(/invoked 2x this session/);
  });
});

describe("the ledger", () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), "cx-ledger-"))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips entries oldest-first and captures the response summary", () => {
    recordUsage(dir, sqlEntry("SELECT path FROM bm25_search('chunks','content','auth', 5)", [{ path: "a.ts" }]));
    recordUsage(dir, sqlEntry("SELECT count(*)", [{ n: 3 }]));
    const entries = readUsage(dir);
    expect(entries.map((e) => e.tool)).toEqual(["sql", "sql"]);
    expect(entries[0].query).toContain("bm25_search");
    expect(entries[0].rows).toBe(1);
    expect(entries[1].rows).toBe(1);
  });

  it("skips torn / hand-edited lines instead of throwing", () => {
    writeFileSync(usageLogPath(dir), '{"tool":"sql"}\nnot json\n', { flag: "a" });
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
  const cxCall = (sid: string) => recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: sid, tool_name: "mcp__code-context__sql" });
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
