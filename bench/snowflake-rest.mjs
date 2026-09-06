// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// A small client for Snowflake's SQL REST API, shared by the loader that
// fills the Snowflake arm's chunks table and the lane that queries it. It is
// plain fetch against the statements endpoint - no driver, no dependency -
// because the bench needs exactly one thing from Snowflake: run a statement
// with positional bindings and hand back the rows.
//
// Authentication is a programmatic access token. It is read from a file named
// by SF_TOKEN_FILE (preferred: the path is what appears in a process listing,
// not the secret) or from SF_TOKEN, and travels only in the Authorization
// header; no error message, log line or thrown value ever carries it.
import { readFileSync } from "node:fs";

/** The columns of the chunks table on both sides: the local index and the
 * Snowflake copy of it. The loader selects them in this order and the queries
 * name them, so the two never drift apart. */
export const CHUNK_COLUMNS = ["path", "start_line", "end_line", "lang", "symbol", "content"];

/** Environment variable names, one place. */
const ENV = {
  account: "SF_ACCOUNT",
  user: "SF_USER",
  role: "SF_ROLE",
  warehouse: "SF_WAREHOUSE",
  database: "SF_DATABASE",
  schema: "SF_SCHEMA",
  table: "SF_TABLE",
  tokenFile: "SF_TOKEN_FILE",
  token: "SF_TOKEN",
};
/** Where the bench's Snowflake copy lives when the environment says nothing.
 * The account and the user have no default: they identify whose Snowflake the
 * bench talks to and are always given, like the token. */
const DEFAULTS = {
  role: "ACCOUNTADMIN",
  warehouse: "COMPUTE_WH",
  database: "INFINO_BENCH",
  schema: "CX",
  table: "CHUNKS",
};
/** The SQL API lives under this path on the account's host. */
const STATEMENTS_PATH = "/api/v2/statements";
/** Header value telling Snowflake the bearer token is a programmatic access
 * token rather than an OAuth token. */
const TOKEN_TYPE_HEADER = "PROGRAMMATIC_ACCESS_TOKEN";
/** Server-side limit on one statement's execution, in seconds. A bench
 * statement is a search or a batched insert; anything past this is stuck. */
const STATEMENT_TIMEOUT_SECS = 300;
/** How long to wait between polls of a statement the server answered 202
 * (still running) for. */
const POLL_INTERVAL_MS = 1000;
/** HTTP status Snowflake returns for a statement that has not finished within
 * its synchronous wait; the result is fetched by handle afterwards. */
const HTTP_ACCEPTED = 202;
/** How much of a non-JSON error body to keep in the thrown message. */
const ERROR_BODY_CHARS = 300;

/** Connection settings from the environment, with the bench's defaults for
 * everything but the account, the user and the token, which are required: the
 * token from the file SF_TOKEN_FILE names, else SF_TOKEN. Every error names
 * the variable and nothing else. */
export function snowflakeSettings(env = process.env) {
  const tokenFile = env[ENV.tokenFile];
  const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : (env[ENV.token] ?? "").trim();
  if (!token) {
    throw new Error(`no Snowflake token: set ${ENV.tokenFile} to the path of the file holding the programmatic access token, or ${ENV.token}`);
  }
  for (const name of [ENV.account, ENV.user]) {
    if (!env[name]) throw new Error(`no Snowflake ${name === ENV.account ? "account" : "user"}: set ${name}`);
  }
  return {
    account: env[ENV.account],
    user: env[ENV.user],
    role: env[ENV.role] ?? DEFAULTS.role,
    warehouse: env[ENV.warehouse] ?? DEFAULTS.warehouse,
    database: env[ENV.database] ?? DEFAULTS.database,
    schema: env[ENV.schema] ?? DEFAULTS.schema,
    table: env[ENV.table] ?? DEFAULTS.table,
    token,
  };
}

/** One positional binding in the SQL API's shape. Strings are TEXT, integers
 * (number or bigint) FIXED, null a TEXT null; the loader's rows and the lane's
 * query terms are all of those. Anything else is a caller bug, named. */
function bindingFor(value, position) {
  if (value === null || value === undefined) return { type: "TEXT", value: null };
  if (typeof value === "string") return { type: "TEXT", value };
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    return { type: "FIXED", value: String(value) };
  }
  throw new Error(`binding ${position}: unsupported value of type ${typeof value} (strings, integers and null bind)`);
}

/** The API's bindings object: keys are the 1-based '?' positions. */
function bindingsOf(binds) {
  if (binds.length === 0) return undefined;
  const out = {};
  binds.forEach((value, i) => {
    out[String(i + 1)] = bindingFor(value, i + 1);
  });
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client bound to one account and session context. `query` runs one
 * statement and resolves to { columns, rows, tookMs }: column names from the
 * result metadata, rows as the API returns them (every value a string, or
 * null), and the wall time of the whole exchange including polling and
 * partition fetches. A non-2xx answer throws with Snowflake's message and
 * error code; the token is never part of it. */
export function snowflakeClient(settings) {
  const base = `https://${settings.account}.snowflakecomputing.com${STATEMENTS_PATH}`;
  const headers = {
    Authorization: `Bearer ${settings.token}`,
    "X-Snowflake-Authorization-Token-Type": TOKEN_TYPE_HEADER,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  /** One HTTP exchange, parsed. Throws on any status but 200 and 202: the
   * body is Snowflake's error object when it is JSON, otherwise its text. */
  const exchange = async (url, init) => {
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (res.ok || res.status === HTTP_ACCEPTED) return { status: res.status, body };
    const detail = body?.message ? `${body.message}${body.code ? ` (code ${body.code})` : ""}` : text.slice(0, ERROR_BODY_CHARS);
    throw new Error(`snowflake: HTTP ${res.status}: ${detail}`);
  };

  /** Poll a statement handle until the server has a result for it. */
  const awaitResult = async (handle) => {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const { status, body } = await exchange(`${base}/${handle}`, { method: "GET" });
      if (status !== HTTP_ACCEPTED) return body;
    }
  };

  /** Rows of every partition after the first, which the initial result
   * already carries. */
  const remainingPartitions = async (handle, count) => {
    const rows = [];
    for (let partition = 1; partition < count; partition++) {
      const { body } = await exchange(`${base}/${handle}?partition=${partition}`, { method: "GET" });
      rows.push(...(body?.data ?? []));
    }
    return rows;
  };

  const query = async (statement, binds = []) => {
    const t0 = performance.now();
    const request = {
      statement,
      warehouse: settings.warehouse,
      role: settings.role,
      database: settings.database,
      schema: settings.schema,
      timeout: STATEMENT_TIMEOUT_SECS,
      bindings: bindingsOf(binds),
    };
    let { status, body } = await exchange(base, { method: "POST", body: JSON.stringify(request) });
    if (status === HTTP_ACCEPTED) body = await awaitResult(body.statementHandle);
    const meta = body?.resultSetMetaData ?? {};
    const columns = (meta.rowType ?? []).map((c) => c.name);
    const rows = [...(body?.data ?? [])];
    const partitions = meta.partitionInfo?.length ?? 1;
    if (partitions > 1) rows.push(...(await remainingPartitions(body.statementHandle, partitions)));
    return { columns, rows, tookMs: Math.round(performance.now() - t0) };
  };

  return { query };
}
