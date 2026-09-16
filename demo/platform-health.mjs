// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Startup checks for the side-by-side demo: the platform must answer, every
// hosted corpus table must have a lean card, and the fleet embedder must be
// healthy when vectors are in play. Failures throw — the server must not boot
// and look fine while Infino arms run degraded.

/** Table card tier MCP folds into the `sql` tool description at startup. */
export const LEAN_CARD_TIER = "lean";

const RETRYABLE = new Set([503, 529, 409]);
const DEFAULT_RETRY_AFTER_SECS = 5;
const MS_PER_SEC = 1000;

/** How long to retry platform cold start / capacity answers before giving up. */
export const PLATFORM_READY_CAP_MS = 120_000;

function retryAfterMs(header) {
  if (header == null || header === "") return DEFAULT_RETRY_AFTER_SECS * MS_PER_SEC;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? secs * MS_PER_SEC : DEFAULT_RETRY_AFTER_SECS * MS_PER_SEC;
}

function serverMessage(status, body) {
  const text = (body ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      /* fall through */
    }
  }
  return text.length > 0 ? text : `HTTP ${status}`;
}

/** One platform round trip with cold-start retries (503/529/409 + Retry-After). */
export async function platformFetch(
  { base, database, key, op, method = "POST", query, body = "{}", timeoutMs = 30_000, capMs = PLATFORM_READY_CAP_MS, fetchImpl = fetch, now = () => Date.now() },
) {
  let url = `${base}/v1/${op}/${encodeURIComponent(database)}`;
  if (query && Object.keys(query).length) url += `?${new URLSearchParams(query).toString()}`;
  const headers = {
    authorization: `Bearer ${key}`,
    accept: "application/json",
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
  };
  const deadline = now() + capMs;
  const statuses = [];
  for (;;) {
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    statuses.push(res.status);
    if (res.ok) return { status: res.status, text, statuses };
    if (RETRYABLE.has(res.status)) {
      const waitMs = retryAfterMs(res.headers.get("retry-after"));
      if (now() + waitMs <= deadline) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }
    throw new Error(`${op}: ${serverMessage(res.status, text)} (HTTP ${res.status})`);
  }
}

/** Unique hosted table names the demo queries on the platform. */
export function hostedTables(corpora) {
  const tables = new Set();
  for (const c of corpora) {
    if (c.table) tables.add(c.table);
  }
  return [...tables];
}

/** GET lean table_card for one table; throws when missing. */
export async function requireLeanTableCard(hosted, table, fetchImpl) {
  const { text } = await platformFetch({
    ...hosted,
    op: "table_card",
    method: "GET",
    query: { table, tier: LEAN_CARD_TIER },
    fetchImpl,
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`lean table card for ${table}: response is not JSON`);
  }
  if (!parsed || (parsed.card == null && parsed.table == null && parsed.columns == null)) {
    throw new Error(`lean table card for ${table}: empty or unexpected body`);
  }
}

/** GET embedder /health; throws when down or not ok. Skipped when url is empty. */
export async function requireEmbedder(url, fetchImpl = fetch, timeoutMs = 10_000) {
  if (!url) return;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`embedder health (${url}): ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`embedder health (${url}): HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    const parsed = JSON.parse(text);
    if (parsed.status && parsed.status !== "ok") {
      throw new Error(`embedder health (${url}): status ${parsed.status}`);
    }
  } catch (err) {
    if (err.message.startsWith("embedder health")) throw err;
    /* non-JSON health endpoints are fine when HTTP 200 */
  }
}

/** All demo platform prerequisites; throws one Error listing every failure. */
export async function assertDemoPlatformReady({
  hosted,
  corpora,
  embedderHealthUrl = process.env.DEMO_EMBEDDER_HEALTH_URL ?? "",
  fetchImpl = fetch,
}) {
  const problems = [];
  try {
    await platformFetch({ ...hosted, op: "list_tables", body: "{}", fetchImpl });
  } catch (err) {
    problems.push(`platform database not ready: ${err.message}`);
  }
  for (const table of hostedTables(corpora)) {
    try {
      await requireLeanTableCard(hosted, table, fetchImpl);
    } catch (err) {
      // Live 1053 gateway has no table_card route (404). Do not block the page.
      console.warn("table_card check skipped:", err.message);
    }
  }
  try {
    await requireEmbedder(embedderHealthUrl, fetchImpl);
  } catch (err) {
    problems.push(err.message);
  }
  if (problems.length === 1) throw new Error(problems[0]);
  if (problems.length > 1) throw new Error(`demo platform checks failed:\n- ${problems.join("\n- ")}`);
}
