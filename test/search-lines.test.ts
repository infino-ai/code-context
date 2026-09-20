// A search hit cut to its matching lines (`SearchOptions.lines`): which lines
// survive, how they are numbered, what a chunk with no matching line does, and
// how the content cap applies to a set of lines that need not be consecutive.
import { describe, expect, it } from "vitest";
import { analyzerTokens, focusLines } from "../src/core/searcher.js";

/** A chunk whose line `n` (1-based within the chunk) reads `line n`, with the
 * given lines replaced. */
function chunk(lines: number, replace: Record<number, string>): string {
  return Array.from({ length: lines }, (_, i) => replace[i + 1] ?? `line ${i + 1}`).join("\n");
}

const ascii = (query: string) => ({ terms: analyzerTokens(query, "ascii_lower"), analyzer: "ascii_lower" as const });

describe("focusLines", () => {
  it("keeps a term-bearing line with two lines either side, numbered with its line in the file", () => {
    // The chunk starts at file line 101; its 20th line carries the term.
    const out = focusLines(chunk(40, { 20: "FAIL tests::macros compile_fail_full" }), 101, ascii("compile_fail_full"));
    expect(out.matchedLines).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.content.split("\n")).toEqual([
      "118: line 18",
      "119: line 19",
      "120: FAIL tests::macros compile_fail_full",
      "121: line 21",
      "122: line 22",
    ]);
  });

  it("merges overlapping context windows and never repeats a line", () => {
    const out = focusLines(chunk(30, { 10: "error one", 12: "error two" }), 1, ascii("error"));
    expect(out.matchedLines).toBe(2);
    const numbers = out.content.split("\n").map((l) => Number(l.split(":")[0]));
    expect(numbers).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it("clips the context at the chunk's own edges", () => {
    const first = focusLines(chunk(10, { 1: "panic at the start" }), 50, ascii("panic"));
    expect(first.content.split("\n").map((l) => l.split(":")[0])).toEqual(["50", "51", "52"]);
    const last = focusLines(chunk(10, { 10: "panic at the end" }), 50, ascii("panic"));
    expect(last.content.split("\n").map((l) => l.split(":")[0])).toEqual(["57", "58", "59"]);
  });

  it("matches by the analyzer's tokens, so the split follows the index", () => {
    // Under ascii_lower `parse_config(` is `parse` and `config`, so a query
    // naming `config` reaches it; under standard the identifier is one token
    // and it does not - the same distinction the keyword half draws.
    const text = chunk(9, { 5: "let v = parse_config(path);" });
    const viaAscii = focusLines(text, 1, ascii("config"));
    expect(viaAscii.matchedLines).toBe(1);
    const viaStandard = focusLines(text, 1, { terms: analyzerTokens("config", "standard"), analyzer: "standard" });
    expect(viaStandard.matchedLines).toBe(0);
    // Case does not matter: the analyzer lowercases both sides.
    expect(focusLines(chunk(3, { 2: "Traceback (most recent call last)" }), 1, ascii("TRACEBACK")).matchedLines).toBe(1);
  });

  it("returns a chunk with no matching line whole, numbered, and says so with matchedLines 0", () => {
    // Such a chunk ranked on meaning alone; hiding it would lose the hit.
    const text = chunk(6, {});
    const out = focusLines(text, 200, ascii("exception"));
    expect(out.matchedLines).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.content.split("\n").length).toBe(6);
    expect(out.content.startsWith("200: line 1\n201: line 2")).toBe(true);
  });

  it("applies the content cap by whole lines and marks the cut", () => {
    // 200 lines that all match, 100 characters each: well over the cap.
    const long = Array.from({ length: 200 }, (_, i) => `error ${String(i).padStart(3, "0")} ${"x".repeat(90)}`).join("\n");
    const out = focusLines(long, 1, ascii("error"));
    expect(out.matchedLines).toBe(200);
    expect(out.truncated).toBe(true);
    const kept = out.content.split("\n");
    expect(kept.length).toBeLessThan(200);
    expect(kept.length).toBeGreaterThan(0);
    // Every kept line is whole: its text is the original line, prefixed.
    for (const line of kept) expect(line).toMatch(/^\d+: error \d{3} x{90}$/);
  });

  it("leaves an empty chunk empty", () => {
    expect(focusLines("", 1, ascii("error"))).toEqual({ content: "", matchedLines: 0, truncated: false });
  });
});
