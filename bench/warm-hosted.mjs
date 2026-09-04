// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Wake the platform database a hosted lane targets before the clock starts.
// A database that is not ready yet answers a retryable status (503 or 529)
// with a Retry-After; a question that lands on that would bill the wait to
// the model's wall clock. This posts the cheapest read the API has -
// list_tables - until it answers 200, honouring Retry-After, and prints the
// round trip of that first good answer and whether a cold start was seen, so
// a report can say which it measured.
//
// Usage: CX_BENCH_DB_URL=https://host/<database> CX_BENCH_KEY_FILE=<path> node warm-hosted.mjs
// Exits non-zero when the database is not live within the cap (WARM_CAP_MS).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_DB_URL, BENCH_KEY_FILE } from "./lanes.mjs";

/** How long to keep retrying before giving up: two minutes covers a database
 * coming up; a Retry-After longer than that is reported rather than waited
 * out. */
export const WARM_CAP_MS = 120_000;
/** Retry-After to assume when a retryable answer carries none. */
export const DEFAULT_RETRY_AFTER_SECS = 5;
/** Answers that mean "not yet, try again"; the first two are a cold start,
 * the third a change in flight. */
const RETRYABLE = new Set([503, 529, 409]);
const COLD_START = new Set([503, 529]);
/** Platform metering header on every response; recorded, never billed here. */
const READ_TOKENS_HEADER = "x-infino-read-tokens";
const MS_PER_SEC = 1000;

/** `https://host/<database>` -> { base: "https://host", db: "<database>" };
 * the shape the engine's own URI parser accepts for a hosted connection. */
export function splitDbUrl(url) {
  const u = new URL(url);
  const db = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!db || db.includes("/")) throw new Error(`the database URL must be https://host/<database>, got a path of "${u.pathname}"`);
  return { base: u.origin, db };
}

/** The message of a platform JSON ErrorBody, or the raw text; never the
 * request, so a credential cannot leak into a log line. */
async function errorMessage(res) {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text)?.message ?? text;
  } catch {
    return text;
  }
}

/** Poll list_tables until 200. Returns { rttMs, totalMs, attempts, coldStart,
 * statuses, readTokens, tables }. Every collaborator is injectable so the
 * loop is testable without a network. */
export async function warmHosted({
  base,
  db,
  key,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => performance.now(),
  capMs = WARM_CAP_MS,
}) {
  const url = `${base}/v1/list_tables/${encodeURIComponent(db)}`;
  const start = now();
  const statuses = [];
  let coldStart = false;
  for (;;) {
    const t0 = now();
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: "{}",
    });
    const rttMs = Math.round(now() - t0);
    statuses.push(res.status);
    if (res.status === 200) {
      const tables = await res.json().catch(() => null);
      const readTokens = res.headers.get(READ_TOKENS_HEADER);
      return {
        rttMs,
        totalMs: Math.round(now() - start),
        attempts: statuses.length,
        coldStart,
        statuses,
        readTokens: readTokens === null ? null : Number(readTokens),
        tables,
      };
    }
    if (!RETRYABLE.has(res.status)) {
      throw new Error(`list_tables answered ${res.status}: ${await errorMessage(res)}`);
    }
    if (COLD_START.has(res.status)) coldStart = true;
    const retryAfterSecs = Number(res.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_SECS;
    const elapsed = now() - start;
    const waitMs = retryAfterSecs * MS_PER_SEC;
    if (elapsed + waitMs > capMs) {
      throw new Error(
        `database not live after ${Math.round(elapsed)}ms (statuses ${statuses.join(",")}; next Retry-After ${retryAfterSecs}s exceeds the ${capMs}ms cap)`,
      );
    }
    await sleep(waitMs);
  }
}

async function main() {
  const url = process.env[BENCH_DB_URL];
  const keyFile = process.env[BENCH_KEY_FILE];
  if (!url || !keyFile) {
    console.error(`warm-hosted needs ${BENCH_DB_URL} (https://host/<database>) and ${BENCH_KEY_FILE} (the file holding the key) in the environment`);
    process.exit(1);
  }
  const { base, db } = splitDbUrl(url);
  // The key is read for the one request loop and never printed.
  const r = await warmHosted({ base, db, key: readFileSync(keyFile, "utf8").trim() });
  console.log(
    `${new URL(base).host}/${db}: live - rtt ${r.rttMs}ms, ${r.coldStart ? `cold start seen (${r.statuses.join(",")}, ${r.totalMs}ms to live)` : "warm (200 first try)"}` +
      `, ${Array.isArray(r.tables) ? r.tables.length : "?"} tables${r.readTokens === null ? "" : `, read tokens ${r.readTokens}`}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
