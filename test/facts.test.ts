// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The verdict's facts about a ranked aggregate fold into the rows the model
// reads, and leave the verdict carrying the note alone.

import { describe, expect, it } from "vitest";
import { foldValidationFacts, ordersRows, rankRows } from "../src/core/facts.js";

describe("rankRows", () => {
  const rows = [{ path: "a", n: 3 }, { path: "b", n: 2 }, { path: "c", n: 1 }];

  it("numbers an ordered result's rows with their place, rank first", () => {
    const ranked = rankRows(rows, "SELECT path, COUNT(*) AS n FROM chunks GROUP BY path\n  ORDER BY n DESC LIMIT 3");
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(Object.keys(ranked[0])[0]).toBe("rank");
    expect(rows[0]).not.toHaveProperty("rank");
  });

  it("leaves an unordered result, a single row, and rows that already carry a rank alone", () => {
    expect(rankRows(rows, "SELECT path, COUNT(*) AS n FROM chunks GROUP BY path")).toEqual(rows);
    expect(rankRows([rows[0]], "SELECT path FROM chunks ORDER BY path")).toEqual([rows[0]]);
    const own = [{ rank: 7, path: "a" }, { rank: 9, path: "b" }];
    expect(rankRows(own, "SELECT rank, path FROM t ORDER BY rank")).toEqual(own);
    expect(ordersRows("select 1 order\n by 1")).toBe(true);
    expect(ordersRows("select 1")).toBe(false);
  });
});

describe("foldValidationFacts", () => {
  const rows = [
    { path: "src/superfile/vector/reader.rs", ranked_lines: 1089, chunks: 17 },
    { path: "src/superfile/fts/builder.rs", ranked_lines: 407, chunks: 8 },
    { path: "docs/unknown.md", ranked_lines: 12, chunks: 1 },
  ];
  const verdict = {
    valid: true,
    check: "aggregate",
    group_column: "path",
    groups: [
      { value: "src/superfile/vector/reader.rs", file_lines: 11847, term_lines: { bm25: 0, vector: 210 } },
      { value: "src/superfile/fts/builder.rs", file_lines: 5089, term_lines: { bm25: 41, vector: 0 } },
    ],
    note: "what the columns measure",
  };

  it("adds each file's length and term lines to the rows that name it, and keeps the rest", () => {
    const { rows: folded, verdict: shown } = foldValidationFacts(rows, verdict);
    expect(folded[0]).toEqual({ ...rows[0], file_lines: 11847, term_lines: { bm25: 0, vector: 210 } });
    expect(folded[1].file_lines).toBe(5089);
    expect(folded[1].term_lines).toEqual({ bm25: 41, vector: 0 });
    // A row whose group has no facts is untouched.
    expect(folded[2]).toEqual(rows[2]);
    // The facts are in the rows now; the verdict keeps the note that says
    // what they measure, not a second copy of them.
    expect(shown).toEqual({ valid: true, check: "aggregate", group_column: "path", note: "what the columns measure" });
    expect(shown).not.toHaveProperty("groups");
    // The input is not mutated.
    expect(rows[0]).not.toHaveProperty("file_lines");
  });

  it("leaves rows and verdict alone when there are no facts", () => {
    const plain = { valid: true, check: "unchecked" };
    expect(foldValidationFacts(rows, plain)).toEqual({ rows, verdict: plain });
    expect(foldValidationFacts(rows, undefined)).toEqual({ rows, verdict: undefined });
    const empty = { ...verdict, groups: [] };
    expect(foldValidationFacts(rows, empty).rows).toEqual(rows);
  });

  it("matches group values as text, since JSON carries a group either way", () => {
    const numbered = [{ id: 7, n: 3 }];
    const { rows: folded } = foldValidationFacts(numbered, {
      group_column: "id",
      groups: [{ value: "7", file_lines: 40 }],
    });
    expect(folded[0].file_lines).toBe(40);
  });
});
