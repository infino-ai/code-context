// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// How a written answer reaches the person: the marker the tool leaves, the
// chunks a hook shows, and what the hook prints from Claude Code's input.

import { describe, expect, it } from "vitest";
import {
  ANSWER_DISPLAY_CHUNK_CHARS,
  answerChunks,
  answerDisplayMode,
  answerFileFrom,
  answerFileMarker,
  hookDeliveryText,
  hookOutput,
  relayDeliveryText,
} from "../src/core/answer-display.js";
import { hookChunk } from "../src/commands/hook-cmd.js";

describe("the display mode", () => {
  it("is hook only when the install set the variable, relay otherwise", () => {
    expect(answerDisplayMode({ CX_ANSWER_DISPLAY: "hook" })).toBe("hook");
    expect(answerDisplayMode({ CX_ANSWER_DISPLAY: "HOOK" })).toBe("hook");
    expect(answerDisplayMode({})).toBe("relay");
    expect(answerDisplayMode({ CX_ANSWER_DISPLAY: "yes" })).toBe("relay");
  });
});

describe("the marker", () => {
  it("names the file and is read back from plain text and from JSON-escaped text", () => {
    const path = "/repo/.infino/answers/2026-09-21T01-00-00-000Z.md";
    expect(answerFileFrom(hookDeliveryText(path, "the answer"))).toBe(path);
    expect(answerFileFrom(JSON.stringify({ content: [{ type: "text", text: hookDeliveryText(path, "the answer") }] }))).toBe(path);
    expect(answerFileFrom("no marker here")).toBeNull();
    expect(answerFileMarker(path)).toBe(`[[answer-file:${path}]]`);
  });

  it("tells the model one thing under each delivery, and never both", () => {
    expect(hookDeliveryText("/f", "the answer")).toMatch(/one short sentence/);
    expect(hookDeliveryText("/f", "the answer")).not.toMatch(/exactly as written/);
    expect(relayDeliveryText("the answer")).toMatch(/^Reply with the following answer exactly as written/);
    expect(relayDeliveryText("the answer")).toMatch(/\n\nthe answer$/);
  });

  it("carries the answer under the hook too, after the marker and the instruction, so the model holds it for the next request", () => {
    // An answer that mentions the marker's own spelling does not confuse the
    // hook: the file marker comes first in the text.
    const answer = "The merge picks files by size.\n\nSee [[answer-file:/nowhere]] for nothing.";
    const text = hookDeliveryText("/f", answer);
    expect(text.endsWith(`\n\n${answer}`)).toBe(true);
    expect(text.indexOf("[[answer-file:/f]]")).toBeLessThan(text.indexOf("Reply with one short sentence"));
    expect(answerFileFrom(text)).toBe("/f");
  });
});

describe("chunks", () => {
  it("keeps a short answer whole", () => {
    expect(answerChunks("short", 3)).toEqual(["short"]);
  });

  it("cuts a long answer at paragraph breaks under the cap, in order, losing nothing", () => {
    const paragraph = `${"x".repeat(2999)}\n\n`;
    const text = paragraph.repeat(5).trimEnd(); // five paragraphs, 15,003 chars
    const chunks = answerChunks(text, 3);
    // Two paragraphs fit under the cap, a third would end one character
    // over it: two, two, one.
    expect(chunks.map((c) => c.split("\n\n").length)).toEqual([2, 2, 1]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(ANSWER_DISPLAY_CHUNK_CHARS);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("fills a chunk rather than cutting at a break near its start", () => {
    // A break in the first few characters is no place to cut: the chunk
    // would be a word long and the cap wasted. Cut mid-text instead.
    const chunks = answerChunks(`first\n\n${"z".repeat(ANSWER_DISPLAY_CHUNK_CHARS)}`, 3);
    expect(chunks[0].length).toBe(ANSWER_DISPLAY_CHUNK_CHARS);
    expect(chunks[0].startsWith("first\n\nzzz")).toBe(true);
  });

  it("says how much was left out when the chunks run out", () => {
    const text = "y".repeat(ANSWER_DISPLAY_CHUNK_CHARS * 2 + 500);
    const chunks = answerChunks(text, 2);
    expect(chunks.length).toBe(2);
    expect(chunks[1]).toMatch(/\[\d+ more characters of the answer were not shown here\]$/);
    expect(chunks[1].length).toBeLessThanOrEqual(ANSWER_DISPLAY_CHUNK_CHARS);
  });

  it("prints a chunk as the hook's system message", () => {
    expect(JSON.parse(hookOutput("hi"))).toEqual({ systemMessage: "hi" });
  });
});

describe("the hook's chunk from Claude Code's input", () => {
  // A first paragraph past half the cap, so the break after it is where the
  // first chunk ends; then more than fits, so a second chunk exists.
  const FIRST = "a".repeat(5000);
  const files: Record<string, string> = { "/a/answer.md": `${FIRST}\n\n${"z".repeat(6000)}\n\nlast` };
  const read = (p: string) => files[p] ?? null;
  const input = (text: string) => JSON.stringify({ tool_name: "mcp__code-context__answer", tool_response: { content: [{ type: "text", text }] } });

  it("reads the file the result names and returns its chunk", () => {
    const first = hookChunk(input(hookDeliveryText("/a/answer.md")), { chunk: "1", chunks: "3" }, read);
    const second = hookChunk(input(hookDeliveryText("/a/answer.md")), { chunk: "2", chunks: "3" }, read);
    expect(first).toBe(FIRST);
    expect(second?.startsWith("zzz")).toBe(true);
    expect(second?.endsWith("last")).toBe(true);
    expect(hookChunk(input(hookDeliveryText("/a/answer.md")), { chunk: "3", chunks: "3" }, read)).toBeNull();
  });

  it("prints nothing without a marker, a file, a chunk, or JSON", () => {
    expect(hookChunk(input("no file named"), {}, read)).toBeNull();
    expect(hookChunk(input(hookDeliveryText("/a/missing.md")), {}, read)).toBeNull();
    expect(hookChunk(input(hookDeliveryText("/a/answer.md")), { chunk: "9", chunks: "3" }, read)).toBeNull();
    expect(hookChunk("not json", {}, read)).toBeNull();
  });
});
