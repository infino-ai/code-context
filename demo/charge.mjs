// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// What the run cost, on both meters.
//
// Two different bills, on two different clocks, and the demo shows both:
//
//   THEIRS   what the caller model cost at the lab. The agent SDK reports it
//            per run (`total_cost_usd`, list price), so it needs no arithmetic
//            here - it is passed through and labelled.
//
//   OURS     what we would charge for the same question. Two meters: platform
//            READ TOKENS, which the gateway returns on every response and the
//            client files in its ledger, and the SUBAGENT MODEL TOKENS an ask
//            or explore burned inside the platform. Only the infino arm has
//            either; the grep arm's is zero by construction, since nothing of
//            it touches us.
//
// The prices are NOT in this file and must not be added to it. A rate is a
// commercial decision, and one guessed here would go stale silently and be
// quoted back as if it were measured. Rates arrive as configuration; with none
// supplied the demo shows metered tokens and no dollar sign, which is honest
// and still shows the shape.
//
// Attribution is by ledger position, not by timestamp. The client appends one
// JSON line per retrieval call to `<indexDir>/usage.jsonl` with no run id, no
// pid and no session marker, so entries from two runs against one index dir
// are indistinguishable after the fact. Reading the file's length before the
// run and parsing only what was appended after is exact - as long as one run
// touches that index dir at a time, which is why the server serializes.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The client's ledger, inside the index dir it was told to use. */
export const ledgerPath = (indexDir) => join(indexDir, "usage.jsonl");

/** The ledger's length in bytes right now, or 0 if it does not exist yet. The
 * mark to read forward from after a run. */
export function ledgerMark(indexDir) {
  try {
    return statSync(ledgerPath(indexDir)).size;
  } catch {
    return 0;
  }
}

/** The entries appended since `mark`. A torn or half-written final line is
 * skipped rather than throwing - the client appends without locking, and a
 * demo must not fail on a line it could not parse. */
export function ledgerSince(indexDir, mark) {
  let text;
  try {
    text = readFileSync(ledgerPath(indexDir), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.slice(mark).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a line still being written, or one another writer tore */
    }
  }
  return entries;
}

/** What we metered over a set of ledger entries.
 *
 * `readTokens` is the gateway's own figure, echoed on each response and the
 * exact quantity it billed. `modelTokens` is what the platform's loop spent
 * with the inference provider on our account - the number that becomes revenue
 * under a markup, and the larger of the two by orders of magnitude. */
export function meteredFrom(entries) {
  let readTokens = 0;
  let modelTokens = 0;
  let platformCalls = 0;
  let platformMs = 0;
  for (const e of entries ?? []) {
    if (e?.platform) {
      platformCalls += 1;
      if (Number.isFinite(e.platform.readTokens)) readTokens += e.platform.readTokens;
      if (Number.isFinite(e.platform.rttMs)) platformMs += e.platform.rttMs;
    }
    if (Number.isFinite(e?.agentModelTokens)) modelTokens += e.agentModelTokens;
  }
  return { readTokens, modelTokens, platformCalls, platformMs: Math.round(platformMs) };
}

/** Rates, from configuration only.
 *
 * `readTokenUsdPerMillion`  what a Read Token is sold for.
 * `modelTokenUsdPerMillion` what the inference costs us, blended.
 * `markup`                  the fraction added to the inference cost, e.g. 0.3.
 *
 * Any of them absent means that half of the charge stays in tokens. */
export function ratesFromEnv(env = process.env) {
  const num = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  return {
    readTokenUsdPerMillion: num("DEMO_READ_TOKEN_USD_PER_M"),
    modelTokenUsdPerMillion: num("DEMO_MODEL_TOKEN_USD_PER_M"),
    markup: num("DEMO_INFERENCE_MARKUP") ?? 0,
  };
}

/** Our charge in dollars, or null for the part no rate was given for. Returns
 * the parts as well as the total, because the two are different businesses:
 * retrieval is cents, and the inference markup is the line that scales. */
export function ourCharge(metered, rates) {
  const perM = (tokens, rate) => (rate === null ? null : (tokens / 1_000_000) * rate);
  const retrieval = perM(metered.readTokens, rates.readTokenUsdPerMillion);
  const inferenceCost = perM(metered.modelTokens, rates.modelTokenUsdPerMillion);
  const inference = inferenceCost === null ? null : inferenceCost * (1 + rates.markup);
  const known = [retrieval, inference].filter((v) => v !== null);
  return {
    retrievalUsd: retrieval,
    inferenceUsd: inference,
    // The total is null unless BOTH halves are priced, so a partial rate card
    // cannot be read as a complete bill.
    totalUsd: known.length === 2 ? retrieval + inference : null,
    priced: known.length === 2,
  };
}

/** Everything the demo prints in the cost row of one arm. */
export function armCost({ costUsd, entries, rates }) {
  const metered = meteredFrom(entries);
  return {
    theirModelBillUsd: Number.isFinite(costUsd) ? costUsd : null,
    metered,
    ours: ourCharge(metered, rates),
  };
}
