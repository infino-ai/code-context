import { describe, expect, it } from "vitest";
import { analyzerTokens, applyEmbeds, guardSql, matchLines } from "../src/core/searcher.js";
import type { Embedder } from "../src/core/embedder.js";

describe("analyzerTokens", () => {
  it("splits on anything outside [A-Za-z0-9] and lowercases, like the index analyzer", () => {
    // `parse_config` indexes as two tokens: the underscore is a separator.
    expect(analyzerTokens("parse_config(Path)")).toEqual(["parse", "config", "path"]);
  });

  it("dedupes repeated tokens", () => {
    expect(analyzerTokens("a.a A")).toEqual(["a"]);
  });

  it("drops a run that touches non-ASCII text, as the analyzer does", () => {
    expect(analyzerTokens("Süd ok")).toEqual(["ok"]);
    // The non-ASCII character extends the run rather than splitting it, so
    // the ASCII neighbours go with it.
    expect(analyzerTokens("abcédef ghi")).toEqual(["ghi"]);
  });

  it("yields nothing for punctuation-only text", () => {
    expect(analyzerTokens("->")).toEqual([]);
    expect(analyzerTokens("")).toEqual([]);
  });
});

describe("matchLines", () => {
  const content = "let parse_config = 1;\nparse config\nPARSE_CONFIG";

  it("cites 1-based lines offset from the chunk start and matches the literal, not its tokens", () => {
    // Line 2 has both tokens but not the literal.
    expect(matchLines(content, 10, "parse_config", false)).toEqual([{ line: 10, text: "let parse_config = 1;" }]);
  });

  it("is case-sensitive unless asked otherwise", () => {
    expect(matchLines(content, 10, "parse_config", true).map((m) => m.line)).toEqual([10, 12]);
  });

  it("strips a CRLF file's carriage return from the cited text", () => {
    expect(matchLines("x = 1;\r\ny = 2;\r\n", 1, "y =", false)).toEqual([{ line: 2, text: "y = 2;" }]);
  });
});

describe("guardSql", () => {
  it("accepts a single SELECT / WITH statement and strips the trailing semicolon", () => {
    expect(guardSql("SELECT 1;")).toBe("SELECT 1");
    expect(guardSql("  with x as (select 1) select * from x  ")).toMatch(/^with x/);
  });

  it("rejects multiple statements", () => {
    expect(() => guardSql("SELECT 1; SELECT 2")).toThrow(/single statement/);
  });

  it("rejects writes", () => {
    expect(() => guardSql("DROP TABLE chunks")).toThrow(/read-only/);
    expect(() => guardSql("INSERT INTO chunks VALUES (1)")).toThrow(/read-only/);
  });
});

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => [0.25, 0.5]),
  dim: async () => 2,
  provider: "fake",
  model: "fake",
};

describe("applyEmbeds", () => {
  it("passes SQL without placeholders through untouched", async () => {
    const sql = "SELECT * FROM chunks";
    expect(await applyEmbeds(sql, undefined, fakeEmbedder)).toBe(sql);
  });

  it("substitutes vector literals for each placeholder", async () => {
    const sql = "SELECT * FROM hybrid_search('chunks','content','t','embedding', {{q}}, 5)";
    const out = await applyEmbeds(sql, { q: "query text" }, fakeEmbedder);
    expect(out).toContain("'0.25,0.5'");
    expect(out).not.toContain("{{");
  });

  it("errors on a referenced placeholder with no supplied text", async () => {
    await expect(applyEmbeds("SELECT {{q}}", {}, fakeEmbedder)).rejects.toThrow(/no 'embed' text/);
    await expect(applyEmbeds("SELECT {{q}}", undefined, fakeEmbedder)).rejects.toThrow(/embed/);
  });
});
