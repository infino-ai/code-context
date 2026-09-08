// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The account plane: the two platform routes that belong to an account rather
// than to one of its databases, so their URLs carry no database segment and
// HostedDb - which always addresses one database - cannot express them.
//
//   GET  /v1/databases   the account's databases. Also the cheapest proof that
//                        a key works at all, which is what `cx login` needs.
//   POST /v1/databases   register this repository's database.
//
// Both authenticate with the same bearer key as the data plane. Neither is
// retried: an account-plane call is a person waiting at a terminal, and every
// failure here is one they have to act on (a refused key, an account with no
// billing details, a name already taken) rather than one that passes.

import { HostedError, serverMessage } from "./hosted.js";

/** Per-call wall clock. Short on purpose: these run in front of a person, and
 * a platform that cannot answer a metadata read in ten seconds is a failure to
 * report rather than one to wait out. */
const ACCOUNT_TIMEOUT_MS = 10_000;

/** The API version prefix, as on the data plane. */
const API_PREFIX = "/v1";

/** `POST /v1/databases` on a name the account already has. Not a failure for
 * our purposes: the caller wanted the database to exist, and it does. */
const HTTP_CONFLICT = 409;

/** Longest database name the platform accepts. */
const MAX_DATABASE_NAME = 128;

/** Who to talk to. The base URL carries no database: one account holds many. */
export interface AccountTarget {
  baseUrl: string;
  apiKey: string;
}

export interface AccountApiOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One of the account's databases, as the platform reports it. */
export interface AccountDatabase {
  name: string;
  /** `registered` (usable), `purging`, or `unreachable`. */
  state: string;
}

/** Whether `createDatabase` had to make it, or found it already there. */
export type CreateOutcome = "created" | "exists";

/** What a trial gave us: a key, the database it registered, the credit on the
 * account, and where a human manages it. */
export interface Trial {
  apiKey: string;
  database: string;
  creditCents: number;
  consoleUrl?: string;
}

/** Ask a platform for a trial account: `POST /v1/trial`, the one route that
 * answers without a credential. Returns a bearer key, a registered database
 * and a credit balance.
 *
 * Two refusals are ordinary rather than exceptional and callers are expected
 * to read them off the status: `501` means this platform does not offer a
 * trial (nothing is wrong, it just has to be asked for another way), and `409`
 * means this machine's address has already had one. */
export async function requestTrial(
  baseUrl: string,
  database: string,
  opts: AccountApiOptions = {},
): Promise<Trial> {
  const body = await unauthenticatedCall(
    "trial",
    baseUrl,
    "/trial",
    JSON.stringify({ database }),
    opts,
  );
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const apiKey = parsed.api_key;
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new HostedError("trial", 0, `no api_key in the trial response: ${body.slice(0, 200)}`);
  }
  return {
    apiKey,
    database: typeof parsed.database === "string" && parsed.database !== "" ? parsed.database : database,
    creditCents: typeof parsed.credit_cents === "number" ? parsed.credit_cents : 0,
    ...(typeof parsed.console_url === "string" && parsed.console_url !== "" ? { consoleUrl: parsed.console_url } : {}),
  };
}

/** The account's databases. Doubles as the key check: it is the lightest
 * authenticated call on the account plane, and its failure statuses are the
 * ones a person needs to hear about - 401 the key, 402 the billing details. */
export async function listDatabases(target: AccountTarget, opts: AccountApiOptions = {}): Promise<AccountDatabase[]> {
  const body = await accountCall("list_databases", target, { method: "GET" }, opts);
  const parsed: unknown = JSON.parse(body);
  const databases = (parsed as { databases?: unknown }).databases;
  if (!Array.isArray(databases)) {
    throw new HostedError("list_databases", 0, `expected a "databases" array, got ${body.slice(0, 200)}`);
  }
  return databases.map((d) => {
    const row = d as { name?: unknown; state?: unknown };
    return { name: String(row.name ?? ""), state: String(row.state ?? "") };
  });
}

/** Register `name` for this account, reporting whether it had to be made. A
 * name the account already holds answers 409, which is the outcome the caller
 * wanted, so it is a result and not an error. */
export async function createDatabase(
  target: AccountTarget,
  name: string,
  opts: AccountApiOptions = {},
): Promise<CreateOutcome> {
  try {
    await accountCall(
      "create_database",
      target,
      { method: "POST", body: JSON.stringify({ name }), contentType: "application/json" },
      opts,
    );
  } catch (err) {
    if (err instanceof HostedError && err.status === HTTP_CONFLICT) return "exists";
    throw err;
  }
  return "created";
}

/** The database name for a repository at `root`: its own directory name, with
 * everything the platform does not accept in an identifier replaced.
 *
 * The platform's rule is `[A-Za-z0-9_-]`, not starting with `_`, at most 128
 * characters. A checkout directory can be anything - `my.project`, `web app`,
 * `.dotfiles` - so this maps rather than refuses, and keeps the mapping
 * obvious enough that a person can recognise their own repository in a list of
 * databases. A name that maps to nothing usable falls back to a fixed one
 * rather than to something generated, so re-running in the same directory
 * always lands on the same database. */
export function databaseNameFor(root: string): string {
  const base = root.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const mapped = base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[_-]+/, "").slice(0, MAX_DATABASE_NAME);
  return mapped === "" ? "repo" : mapped;
}

/** A request that carries no credential, because it is asking for one. The
 * only such route is the trial; everything else on this plane is a bearer
 * call. Kept separate from `accountCall` so no authenticated request can end
 * up here by accident and no header of ours travels unauthenticated. */
async function unauthenticatedCall(
  op: string,
  baseUrl: string,
  path: string,
  body: string,
  opts: AccountApiOptions,
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ACCOUNT_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}${API_PREFIX}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new HostedError(op, 0, timedOut ? `no response within ${timeoutMs} ms` : `request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const text = await response.text();
  if (!response.ok) throw new HostedError(op, response.status, serverMessage(response.status, text));
  return text;
}

/** One account-plane request. Shares HostedError with the data plane so a
 * caller can read `status`, `paymentRequired` and `unauthenticated` off either
 * without knowing which plane refused it. */
async function accountCall(
  op: string,
  target: AccountTarget,
  request: { method: string; body?: string; contentType?: string },
  opts: AccountApiOptions,
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ACCOUNT_TIMEOUT_MS;
  const url = `${target.baseUrl.replace(/\/+$/, "")}${API_PREFIX}/databases`;
  const headers: Record<string, string> = { authorization: `Bearer ${target.apiKey}`, accept: "application/json" };
  if (request.contentType) headers["content-type"] = request.contentType;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new HostedError(op, 0, timedOut ? `no response within ${timeoutMs} ms` : `request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const text = await response.text();
  if (!response.ok) throw new HostedError(op, response.status, serverMessage(response.status, text));
  return text;
}
