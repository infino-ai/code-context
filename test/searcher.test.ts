import { describe, expect, it } from "vitest";
import { applyEmbeds, guardSql } from "../src/core/searcher.js";
import type { Embedder } from "../src/core/embedder.js";

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
