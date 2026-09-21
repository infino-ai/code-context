// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx hook answer-input`: what the model said and thought since the person's
// question, read from a Claude Code session transcript and handed to the
// `answer` tool through the hook's updated input.

import { describe, expect, it } from "vitest";
import {
  ANSWER_STOP_REASON,
  NARRATION_CHARS,
  NARRATION_INPUT,
  hookNarrationOutput,
  hookStopOutput,
  transcriptNarration,
  transcriptToolCalls,
} from "../src/commands/hook-cmd.js";

/** One transcript line as Claude Code writes it. */
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (text: string, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const toolResult = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const assistant = (blocks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });

const TRANSCRIPT = [
  user("How is a bool query scored?"),
  assistant([{ type: "text", text: "Earlier answer about scoring." }]),
  user("How does a refresh differ from a flush?"),
  assistant([
    { type: "thinking", thinking: "Two asks: one for refresh, one for flush." },
    { type: "text", text: "Let me look at both paths." },
    { type: "tool_use", id: "t1", name: "mcp__code-context__ask", input: { question: "refresh" } },
  ]),
  toolResult("{\"hits\":[]}"),
  assistant([{ type: "text", text: "A refresh opens a new reader; a flush commits." }], { isSidechain: true }),
  assistant([{ type: "text", text: "Refresh makes documents visible; flush makes them durable." }]),
  "",
].join("\n");

describe("the narration read from a transcript", () => {
  it("takes the text after the last question, in order, and leaves out thinking, tool calls, tool results, earlier turns and subagents", () => {
    // The thinking block is the model's own and is never lifted out.
    expect(transcriptNarration(TRANSCRIPT)).toBe("Let me look at both paths.\n\nRefresh makes documents visible; flush makes them durable.");
  });

  it("is null without a question, without any narration after it, or for a file that is not a transcript", () => {
    expect(transcriptNarration([assistant([{ type: "text", text: "orphan" }])].join("\n"))).toBeNull();
    expect(transcriptNarration([user("q"), assistant([{ type: "tool_use", id: "t", name: "x", input: {} }])].join("\n"))).toBeNull();
    expect(transcriptNarration("not json at all")).toBeNull();
    expect(transcriptNarration("")).toBeNull();
  });

  it("treats a prompt given as a plain string as the question, and a partial last line as not yet written", () => {
    const jsonl = [line({ type: "user", message: { role: "user", content: "plain question" } }), assistant([{ type: "text", text: "said" }]), '{"type":"assis'].join("\n");
    expect(transcriptNarration(jsonl)).toBe("said");
  });

  it("keeps the most recent narration under the cap and says what was cut", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"x".repeat(400)}`);
    const jsonl = [user("q"), ...paragraphs.map((p) => assistant([{ type: "text", text: p }]))].join("\n");
    const narration = transcriptNarration(jsonl);
    expect(narration).not.toBeNull();
    expect(narration!.length).toBeLessThanOrEqual(NARRATION_CHARS);
    expect(narration!.startsWith("[earlier narration left out]\n\nparagraph ")).toBe(true);
    expect(narration!.endsWith(paragraphs[39])).toBe(true);
    // Whole paragraphs only: the cut falls on a paragraph break.
    expect(narration!.split("\n\n").slice(1).every((p) => /^paragraph \d+ x+$/.test(p))).toBe(true);
  });
});

describe("the stop hook", () => {
  const stopEvent = (transcript: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ session_id: "s", transcript_path: "/s/t.jsonl", cwd: "/r", hook_event_name: "Stop", stop_hook_active: false, ...extra });
  const reader = (transcript: string) => (p: string) => (p === "/s/t.jsonl" ? transcript : null);
  const retrievedNoAnswer = [
    user("How does a refresh differ from a flush?"),
    assistant([{ type: "tool_use", id: "t1", name: "mcp__code-context__ask", input: { question: "refresh" } }]),
    toolResult("{\"hits\":[]}"),
    assistant([{ type: "text", text: "Refresh makes documents visible; flush makes them durable." }]),
  ].join("\n");

  it("lists the model's own tool calls since the last question", () => {
    expect(transcriptToolCalls(retrievedNoAnswer)).toEqual(["mcp__code-context__ask"]);
    expect(transcriptToolCalls(TRANSCRIPT)).toEqual(["mcp__code-context__ask"]);
    expect(transcriptToolCalls("")).toEqual([]);
  });

  it("sends the model back for the answer call when it retrieved and stopped without one", () => {
    expect(JSON.parse(hookStopOutput(stopEvent(retrievedNoAnswer), reader(retrievedNoAnswer))!)).toEqual({ decision: "block", reason: ANSWER_STOP_REASON });
  });

  it("lets the model stop when it called answer, when it never retrieved, or when it was already sent back once", () => {
    const answered = [retrievedNoAnswer, assistant([{ type: "tool_use", id: "t2", name: "mcp__code-context__answer", input: { question: "q" } }])].join("\n");
    expect(hookStopOutput(stopEvent(answered), reader(answered))).toBeNull();
    const plain = [user("hello"), assistant([{ type: "text", text: "hi" }])].join("\n");
    expect(hookStopOutput(stopEvent(plain), reader(plain))).toBeNull();
    const withGrep = [user("q"), assistant([{ type: "tool_use", id: "g", name: "Grep", input: {} }]), assistant([{ type: "text", text: "found" }])].join("\n");
    expect(hookStopOutput(stopEvent(withGrep), reader(withGrep))).toBeNull();
    expect(hookStopOutput(stopEvent(retrievedNoAnswer, { stop_hook_active: true }), reader(retrievedNoAnswer))).toBeNull();
    expect(hookStopOutput(stopEvent(retrievedNoAnswer), () => null)).toBeNull();
    expect(hookStopOutput("not json", reader(retrievedNoAnswer))).toBeNull();
  });
});

describe("the hook's output", () => {
  const files: Record<string, string> = { "/s/transcript.jsonl": TRANSCRIPT };
  const read = (p: string) => files[p] ?? null;
  const event = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s",
      transcript_path: "/s/transcript.jsonl",
      cwd: "/r",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__code-context__answer",
      tool_input: { question: "How does a refresh differ from a flush?", under: "server/" },
      ...extra,
    });

  it("returns the call's input with the narration filled in, under an allow", () => {
    const out = JSON.parse(hookNarrationOutput(event(), read)!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      question: "How does a refresh differ from a flush?",
      under: "server/",
      [NARRATION_INPUT]: "Let me look at both paths.\n\nRefresh makes documents visible; flush makes them durable.",
    });
  });

  it("prints nothing without a transcript path, a readable transcript, any narration, or JSON", () => {
    expect(hookNarrationOutput(event({ transcript_path: undefined }), read)).toBeNull();
    expect(hookNarrationOutput(event({ transcript_path: "/s/missing.jsonl" }), read)).toBeNull();
    expect(hookNarrationOutput(event(), () => user("q"))).toBeNull();
    expect(hookNarrationOutput("not json", read)).toBeNull();
  });
});
