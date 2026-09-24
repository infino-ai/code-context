// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The ranked-aggregate check: which search calls a statement makes and with
// what k, and which statements are refused - a GROUP BY over a ranked
// search's small top k - and which run.

import { describe, expect, it } from "vitest";
import { RANKED_AGGREGATE_MIN_K, rankedSearchCalls, topKAggregateRefusal } from "../src/core/topk-aggregate.js";

const HYBRID_50 = "SELECT path, COUNT(*) AS chunks FROM hybrid_search('chunks', 'content', 'fts index', 'embedding', {{q}}, 50) GROUP BY path ORDER BY chunks DESC";

describe("rankedSearchCalls", () => {
  it("reads each ranked search's k from its last argument, through quotes, nesting and placeholders", () => {
    expect(rankedSearchCalls(HYBRID_50)).toEqual([{ fn: "hybrid_search", k: 50 }]);
    expect(rankedSearchCalls("SELECT * FROM bm25_search('t', 'c', 'a, b) (c', 300)")).toEqual([{ fn: "bm25_search", k: 300 }]);
    expect(rankedSearchCalls("SELECT * FROM vector_search('t', 'embedding', {{q}}, 20) v JOIN bm25_search('t','c','x', 40) b ON v._id = b._id")).toEqual([
      { fn: "vector_search", k: 20 },
      { fn: "bm25_search", k: 40 },
    ]);
    // A k that is not a literal is unknown, and token_match has no k.
    expect(rankedSearchCalls("SELECT * FROM bm25_search('t', 'c', 'x', :k)")).toEqual([{ fn: "bm25_search", k: null }]);
    expect(rankedSearchCalls("SELECT count(*) FROM token_match('t', 'c', 'x', 'and')")).toEqual([]);
  });
});

describe("topKAggregateRefusal", () => {
  it("refuses a GROUP BY over a ranked search with k under the floor, naming the call and the two shapes that rank the corpus", () => {
    const text = topKAggregateRefusal("sql", HYBRID_50);
    expect(text).toContain("sql refused: a GROUP BY over hybrid_search(..., 50)");
    expect(text).toContain("token_match(");
    expect(text).toContain(`k of at least ${RANKED_AGGREGATE_MIN_K}`);
    expect(text).toContain("file_lines and term_lines");
  });

  it("lets through a GROUP BY at or above the floor, one with an unknown k, a search without GROUP BY, and a scan", () => {
    expect(topKAggregateRefusal("sql", HYBRID_50.replace(", 50)", `, ${RANKED_AGGREGATE_MIN_K})`))).toBeNull();
    expect(topKAggregateRefusal("sql", "SELECT path, count(*) FROM bm25_search('t','c','x', :k) GROUP BY path")).toBeNull();
    expect(topKAggregateRefusal("sql", "SELECT path, content FROM hybrid_search('chunks','content','x','embedding', {{q}}, 20)")).toBeNull();
    expect(topKAggregateRefusal("sql", "SELECT path, count(*) FROM token_match('chunks','content','fts','and') GROUP BY path ORDER BY 2 DESC")).toBeNull();
    expect(topKAggregateRefusal("sql", "SELECT lang, count(*) FROM chunks GROUP BY lang")).toBeNull();
  });
});
