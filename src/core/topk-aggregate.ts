// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The check a ranked aggregate passes before it runs: a GROUP BY over the
// top k rows of a search function (hybrid_search, bm25_search,
// vector_search) with a small k ranks a share of those k rows, not the
// corpus, and the statement is refused with the two shapes that do rank
// the corpus, so the model rewrites it.
//
// Measured before this existed (the 36-question panel of 2026-09-24, four
// caller families): every "which files have the most code about X" the
// Infino arm lost was this shape - hybrid_search(..., 50) GROUP BY path
// ORDER BY count - and the sql description had warned against it in so
// many words on every one of those runs. The join gate showed that a
// refusal moves a model where a sentence does not; the owner: "this makes
// sense".

/** The search functions whose rows are a ranked top k. */
const RANKED_SEARCH_FUNCTIONS = ["hybrid_search", "bm25_search", "vector_search"];

/** The smallest k a GROUP BY over a ranked search runs at unrefused: the
 * size the sql description's own ranking example uses, and past which the
 * top k covers enough of the corpus for a per-file share to mean
 * something. Below it the aggregate is refused. */
export const RANKED_AGGREGATE_MIN_K = 300;

/** A ranked search call in a statement: its function, and its k when the
 * call's last argument is a number literal. */
export interface RankedSearchCall {
  fn: string;
  k: number | null;
}

/** Every ranked search call in `query`, with the k each one asks for.
 * The k is the call's last top-level argument when it is an integer
 * literal; a placeholder or an expression reads as unknown. */
export function rankedSearchCalls(query: string): RankedSearchCall[] {
  const calls: RankedSearchCall[] = [];
  const re = new RegExp(`\\b(${RANKED_SEARCH_FUNCTIONS.join("|")})\\s*\\(`, "gi");
  for (const m of query.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    // Walk to the matching close paren, tracking depth and quotes.
    let depth = 0;
    let inQuote: string | null = null;
    let end = -1;
    for (let i = open; i < query.length; i += 1) {
      const c = query[i];
      if (inQuote) {
        if (c === inQuote) inQuote = null;
        continue;
      }
      if (c === "'" || c === '"') inQuote = c;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    const inner = query.slice(open + 1, end);
    const last = lastTopLevelArgument(inner).trim();
    const k = /^\d+$/.test(last) ? Number(last) : null;
    calls.push({ fn: m[1].toLowerCase(), k });
  }
  return calls;
}

/** The last comma-separated argument of a call's inner text, at depth zero. */
function lastTopLevelArgument(inner: string): string {
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (inQuote) { if (c === inQuote) inQuote = null; continue; }
    if (c === "'" || c === '"') inQuote = c;
    else if (c === "(" || c === "{") depth += 1;
    else if (c === ")" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) start = i + 1;
  }
  return inner.slice(start);
}

/** Whether the statement aggregates per group: a GROUP BY anywhere in it. */
export function groupsRows(query: string): boolean {
  return /\bgroup\s+by\b/i.test(query);
}

/** The refusal for `query`, or null when it runs: a GROUP BY over a ranked
 * search whose k is known and under the floor. */
export function topKAggregateRefusal(tool: string, query: string): string | null {
  if (!groupsRows(query)) return null;
  const small = rankedSearchCalls(query).filter((c) => c.k !== null && c.k < RANKED_AGGREGATE_MIN_K);
  if (!small.length) return null;
  const named = small.map((c) => `${c.fn}(..., ${c.k})`).join(", ");
  return (
    `${tool} refused: a GROUP BY over ${named} ranks a share of those ${small[0].k} top-ranked rows, not the corpus, ` +
    `so a per-file count or sum from it says which files hold the most of the top ${small[0].k} hits and nothing about ` +
    `which files hold the most such code. Two shapes rank the corpus: token_match('<table>', '<column>', '<terms>', 'and') ` +
    `over every row, GROUP BY path; or the same search with k of at least ${RANKED_AGGREGATE_MIN_K}, reading each group's ` +
    `file_lines and term_lines off the result's validation. Rewrite with one of these and run it again.`
  );
}
