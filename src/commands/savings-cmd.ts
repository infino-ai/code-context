// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx savings` - what the index served, and what reading those files whole
// would have cost instead.
//
// The point of the command is that the value is otherwise invisible: you feel
// the speed, you never see the tokens that did not enter the transcript. The
// ledger already holds both halves - `returnedTokens` is what a call actually
// returned, and `wholeFileTokens` is the on-disk size of the distinct files
// those hits came from, recorded at query time by `searchEntry`.
//
// The honesty rule this command exists under: the served figure is MEASURED,
// the avoided figure is a COUNTERFACTUAL. You cannot run both arms of a
// session, so "what it would have cost" is an estimate and is labelled one
// every time it is printed. Two further limits are stated rather than papered
// over:
//
//   - only `search` records the whole-file counterfactual, so the estimate
//     rests on those calls alone and the command says how many of the ledger's
//     calls that is. `find`'s fair alternative is a grep, not a file read, and
//     `sql` returns an aggregate no file read produces at all - counting
//     either as avoided file reads is how this number gets inflated, so
//     neither is counted.
//   - money needs a price, and a price is the caller's, not ours. No rate is
//     assumed: `--rate` prints one, and without it the output is tokens.

import { bold, dim, green, fmtCount } from "../core/output.js";
import { indexDir, resolveRoot } from "../core/config.js";
import { fmtTokens, readUsage, type UsageEntry } from "../core/usage.js";

export interface SavingsCmdOptions {
  path?: string;
  json?: boolean;
  /** Dollars per million tokens, to price the token figures. Absent, no money
   * is printed: a default rate would be a guess about the caller's model and
   * their contract, and it would go stale silently. */
  rate?: string;
}

/** Tokens per million, for pricing at a per-million rate. */
const TOKENS_PER_MILLION = 1_000_000;

export interface Savings {
  /** Calls in the ledger. */
  queries: number;
  /** Tokens the index actually returned, across every call. Measured. */
  servedTokens: number;
  /** Calls that recorded the whole-file counterfactual (search only). */
  measuredAgainst: number;
  /** Whole-file tokens for those calls: what reading the files the hits came
   * from would have put in the transcript. An estimate. */
  wholeFileTokens: number;
  /** What those same calls returned instead. Measured. */
  servedOnMeasured: number;
  /** wholeFileTokens - servedOnMeasured, never negative. An estimate. */
  avoidedTokens: number;
}

/** Sum the ledger. Split out so a test drives it without a filesystem, and so
 * the arithmetic is readable in one place. */
export function savingsFrom(entries: UsageEntry[]): Savings {
  let servedTokens = 0;
  let measuredAgainst = 0;
  let wholeFileTokens = 0;
  let servedOnMeasured = 0;
  for (const e of entries) {
    servedTokens += e.returnedTokens;
    // `null` means nothing was stattable at query time; absent means the tool
    // does not record a counterfactual. Neither is a zero.
    if (typeof e.wholeFileTokens !== "number") continue;
    measuredAgainst++;
    wholeFileTokens += e.wholeFileTokens;
    servedOnMeasured += e.returnedTokens;
  }
  return {
    queries: entries.length,
    servedTokens,
    measuredAgainst,
    wholeFileTokens,
    servedOnMeasured,
    avoidedTokens: Math.max(0, wholeFileTokens - servedOnMeasured),
  };
}

const money = (tokens: number, dollarsPerMillion: number): string =>
  `$${((tokens / TOKENS_PER_MILLION) * dollarsPerMillion).toFixed(2)}`;

export function savingsCmd(opts: SavingsCmdOptions): void {
  const root = resolveRoot(opts.path);
  const entries = readUsage(indexDir(root));
  const s = savingsFrom(entries);

  if (opts.json) {
    console.log(JSON.stringify({ root, ...s }, null, 2));
    return;
  }

  if (s.queries === 0) {
    console.error(
      dim("no queries recorded yet - run `cx find`/`cx search`/`cx sql` here, or query through the MCP server"),
    );
    return;
  }

  const rate = opts.rate === undefined ? undefined : Number(opts.rate);
  const priced = rate !== undefined && Number.isFinite(rate) && rate > 0;

  console.log(`${bold("what the index served")} - ${root}`);
  console.log(
    `  ${fmtCount(s.queries)} calls returned ${green(`~${fmtTokens(s.servedTokens)} tokens`)}` +
      (priced ? ` (${money(s.servedTokens, rate!)})` : "") +
      dim("   measured"),
  );

  if (s.measuredAgainst === 0) {
    console.log(dim("  no call recorded a whole-file comparison yet, so there is nothing to estimate against."));
    console.log(dim("  `search` records one; `find` and `sql` do not - a grep and an aggregate are not file reads."));
    return;
  }

  const ratio = s.servedOnMeasured > 0 ? s.wholeFileTokens / s.servedOnMeasured : 0;
  console.log(
    `  reading those files whole: ~${fmtTokens(s.wholeFileTokens)}` +
      (priced ? ` (${money(s.wholeFileTokens, rate!)})` : "") +
      dim("   estimated"),
  );
  console.log(
    `  ${green(`~${fmtTokens(s.avoidedTokens)} tokens not read`)}` +
      (priced ? ` (${money(s.avoidedTokens, rate!)})` : "") +
      (ratio > 0 ? `, ${ratio.toFixed(1)}x` : "") +
      dim("   estimated"),
  );
  console.log(
    dim(
      `  the estimate covers ${fmtCount(s.measuredAgainst)} of ${fmtCount(s.queries)} calls - the ones that ` +
        "recorded what the files behind their hits weigh. It is a counterfactual, not a measurement: it is what " +
        "reading those files whole would have cost, which is not a thing that happened.",
    ),
  );
  if (!priced) {
    console.log(dim("  --rate <dollars-per-million> prices these at your own model's rate."));
  }
}
