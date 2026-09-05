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
  subagentEntry,
  exploreEntry,
  withPlatform,
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
import type { ExploreResult, RetrievalAgentResult, RetrievalAgentSpend } from "../src/core/retrieval-agent.js";
import type { HostedDb, HostedCallInfo } from "../src/core/hosted.js";

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

describe("subagent receipt", () => {
  const answered: RetrievalAgentResult = {
    question: "which files?",
    sql: "SELECT path, COUNT(*) AS n FROM token_match('chunks','content','compaction') GROUP BY path",
    hits: [{ path: "src/a.ts", startLine: 10, endLine: 30, content: "export function a() {\n}" }],
    rows: [{ path: "src/a.ts", n: 3 }],
    hitsTotal: 1,
    rowsTotal: 1,
    turns: 4,
  };
  const spend: RetrievalAgentSpend = { modelTokens: 12_555 };

  it("counts the statement, hits and rows as what was returned, records the places, and the loop's spend", () => {
    const entry = subagentEntry(answered, spend);
    expect(entry.tool).toBe("subagent");
    expect(entry.query).toBe("which files?");
    expect(entry.returnedTokens).toBe(estTokens(JSON.stringify({ sql: answered.sql, hits: answered.hits, rows: answered.rows })));
    expect(entry.hits).toEqual([{ path: "src/a.ts", startLine: 10, endLine: 30 }]);
    expect(entry.rows).toBe(1);
    expect(entry.agentTurns).toBe(4);
    expect(entry.agentModelTokens).toBe(12_555);
    // The ledger points at places; the code does not leak into it.
    expect(JSON.stringify(entry)).not.toContain("export function a");
  });

  it("prints the returned tokens, the hits and rows, the turns, and the model tokens the platform metered", () => {
    const line = formatReceipt(subagentEntry(answered, spend));
    expect(line).toMatch(/^returned ~\d+ tokens \| 1 hit \/ 1 row \| 4 turns \| 12\.6k model tokens$/);
  });

  it("singularizes one turn and accumulates into the session", () => {
    const session = newSession();
    const line = formatReceipt(subagentEntry({ ...answered, turns: 1 }, spend), session);
    expect(line).toMatch(/\| 1 turn \|/);
    expect(line).toMatch(/invoked 1x this session/);
    expect(session.queries).toBe(1);
  });

  it("counts a no-answer result by the facts it still carries", () => {
    const { sql: _none, ...noStatement } = answered;
    const entry = subagentEntry({ ...noStatement, error: "the retrieval agent ran out of turns - the hits and rows below are what it retrieved before stopping" }, spend);
    expect(entry.returnedTokens).toBe(estTokens(JSON.stringify({ hits: answered.hits, rows: answered.rows })));
  });

  it("round-trips through the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-agent-ledger-"));
    try {
      recordUsage(dir, subagentEntry(answered, spend));
      const [entry] = readUsage(dir);
      expect(entry.tool).toBe("subagent");
      expect(entry.agentTurns).toBe(4);
      expect(entry.agentModelTokens).toBe(12_555);
      expect(entry.hits).toEqual([{ path: "src/a.ts", startLine: 10, endLine: 30 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records that the platform ranked the facts, and only then", () => {
    expect(subagentEntry(answered, spend)).not.toHaveProperty("agentRanked");
    const ranked = subagentEntry({ ...answered, coverage: { rowsTotal: 20, rowsReturned: 1, truncated: true, ranked: true } }, spend);
    expect(ranked.agentRanked).toBe(true);
  });

  it("records nothing about the platform's costs beyond the one metered number", () => {
    const entry = subagentEntry(answered, spend) as Record<string, unknown>;
    for (const gone of ["agentCalls", "agentPromptTokens", "agentCompletionTokens", "agentRung", "agentModel"]) expect(entry).not.toHaveProperty(gone);
  });
});

describe("explore receipt", () => {
  const explored: ExploreResult = {
    question: "how do tombstones work?",
    sql: "find(\"struct Tombstone\")",
    hits: [{ path: "src/a.ts", startLine: 10, endLine: 30, content: "export function a() {\n}" }],
    rows: [],
    hitsTotal: 1,
    rowsTotal: 0,
    turns: 6,
    answer: "Tombstones are written at ... and read at ...",
    chain: ["SELECT ... FROM bm25_search('chunks','content','tombstone', 100)", "find(\"struct Tombstone\")"],
  };
  const spend: RetrievalAgentSpend = { modelTokens: 40_900 };

  it("counts the answer, the chain and the facts as what was returned, under its own tool name", () => {
    const entry = exploreEntry(explored, spend);
    expect(entry.tool).toBe("explore");
    expect(entry.returnedTokens).toBe(
      estTokens(JSON.stringify({ answer: explored.answer, chain: explored.chain, sql: explored.sql, hits: explored.hits, rows: explored.rows })),
    );
    expect(entry.hits).toEqual([{ path: "src/a.ts", startLine: 10, endLine: 30 }]);
    expect(entry.agentTurns).toBe(6);
    expect(entry.agentModelTokens).toBe(40_900);
    expect(JSON.stringify(entry)).not.toContain("Tombstones are written");
  });

  it("prints the same receipt shape as a subagent call", () => {
    const line = formatReceipt(exploreEntry(explored, spend));
    expect(line).toMatch(/^returned ~\d+ tokens \| 1 hit \/ 0 rows \| 6 turns \| 40\.9k model tokens$/);
  });

  it("records whether the exploration came back with an answer, so empty ones can be counted", () => {
    expect(exploreEntry(explored, spend).agentAnswered).toBe(true);
    const { answer: _none, ...unanswered } = explored;
    expect(exploreEntry({ ...unanswered, error: "the retrieval agent ran out of turns" }, spend).agentAnswered).toBe(false);
    expect(subagentEntry(explored, spend)).not.toHaveProperty("agentAnswered");
  });
});

describe("withPlatform (hosted telemetry on the ledger entry)", () => {
  /** A stand-in for the platform client: only `lastCall` is read. */
  const hostedWith = (info: HostedCallInfo | null): HostedDb => ({ lastCall: () => info }) as unknown as HostedDb;

  it("attaches the answering call's round trip and metered tokens, and nothing else", () => {
    const info: HostedCallInfo = { op: "bm25_search", status: 200, rttMs: 12.5, retries: 1, readTokens: 0.05 };
    const entry = withPlatform(sqlEntry("SELECT 1", [{ a: 1 }]), { hosted: hostedWith(info) });
    expect(entry.platform).toEqual({ rttMs: 12.5, readTokens: 0.05 });
    // The receipt the model sees is unchanged by the telemetry.
    expect(formatReceipt(entry)).toBe(formatReceipt(sqlEntry("SELECT 1", [{ a: 1 }])));
  });

  it("leaves a local entry untouched, and a hosted one before any call", () => {
    expect(withPlatform(sqlEntry("SELECT 1", []), {}).platform).toBeUndefined();
    expect(withPlatform(sqlEntry("SELECT 1", []), { hosted: hostedWith(null) }).platform).toBeUndefined();
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
    recordHookEvent(dir, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__code-context-dev__search" });
    expect(currentSessionStats(dir)?.cxCallsByTool).toEqual({ search: 1 });
    expect(currentSessionStats(dir)?.firstToolByPrompt).toEqual({ search: 1 });
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
