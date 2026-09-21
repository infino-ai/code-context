// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The record of what a server returned in a session: kept by place, in
// order, deduplicated, capped to the most recent, and rendered as the rows
// the platform reads back for the writer.

import { describe, expect, it } from "vitest";
import { RECORD_ROWS_CAP, RetrievalRecord } from "../src/core/retrieval-record.js";

const TABLE = "chunks_repo";

describe("the retrieval record", () => {
  it("keeps a hit, a matched line and a sql row with a place as the chunk holding a line, once each, in order", () => {
    const record = new RetrievalRecord();
    record.addPlaces(TABLE, [{ path: "src/a.rs", startLine: 40 }, { path: "src/b.rs", startLine: 1 }]);
    record.addLines(TABLE, [{ path: "src/a.rs", line: 40 }, { path: "src/c.rs", line: 7 }]);
    record.addRows(TABLE, [
      { path: "src/d.rs", start_line: 12, end_line: 20, content: "12: fn d() {}" },
      { path: "src/a.rs", chunks: 3 },
      { count: 42 },
    ]);
    expect(record.facts()).toEqual([
      { table: TABLE, row: { path: "src/b.rs", start_line: 1 } },
      // Seen again in the find: moved to the end, kept once.
      { table: TABLE, row: { path: "src/a.rs", start_line: 40 } },
      { table: TABLE, row: { path: "src/c.rs", start_line: 7 } },
      // A row with text still travels as its place: the platform reads the
      // text back as the index holds it.
      { table: TABLE, row: { path: "src/d.rs", start_line: 12 } },
      // Rows without a place are kept as they came.
      { table: TABLE, row: { path: "src/a.rs", chunks: 3 } },
      { table: TABLE, row: { count: 42 } },
    ]);
    expect(record.size).toBe(6);
  });

  it("names a row of a table of another shape by its key, skips a row without one, and keys sql rows when told the key", () => {
    const record = new RetrievalRecord();
    record.addKeys("jobs", "id", [{ id: 7, title: "Own the platform" }, { title: "no key" }]);
    record.addRows("jobs", [{ id: 9, title: "Another" }, { n: 2 }], "id");
    expect(record.facts()).toEqual([
      { table: "jobs", row: { id: 7 } },
      { table: "jobs", row: { id: 9 } },
      { table: "jobs", row: { n: 2 } },
    ]);
  });

  it("keeps the most recent rows when over the cap, and forgets everything on clear", () => {
    const record = new RetrievalRecord();
    const hits = Array.from({ length: RECORD_ROWS_CAP + 5 }, (_, i) => ({ path: `src/f${i}.rs`, startLine: 1 }));
    record.addPlaces(TABLE, hits);
    const facts = record.facts();
    expect(facts).toHaveLength(RECORD_ROWS_CAP);
    expect(facts[0].row.path).toBe("src/f5.rs");
    expect(facts.at(-1)?.row.path).toBe(`src/f${RECORD_ROWS_CAP + 4}.rs`);
    record.clear();
    expect(record.facts()).toEqual([]);
    expect(record.size).toBe(0);
  });

  it("ignores a place without a finite line", () => {
    const record = new RetrievalRecord();
    record.addPlaces(TABLE, [{ path: "src/a.rs", startLine: Number.NaN }]);
    expect(record.facts()).toEqual([]);
  });
});
