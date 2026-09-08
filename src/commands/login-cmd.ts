// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx login` - store this machine's Infino account once, so nothing after it
// needs a flag. It writes two files into `~/.infino/`: the bearer key, mode
// 600, and the platform's base URL beside it. `cx install` in any repository
// then needs no arguments at all, and no `.mcp.json` ever names a key or a
// path under someone's home directory.
//
// The key never travels through argv, because argv is readable by every
// process on the machine. It comes from a file (`--api-key-file`), or from
// standard input when this command is piped or redirected. There is no flag
// that takes the value.
//
// Before storing anything the key is used once, against the account's own
// database list. That call is the only thing that can tell the difference
// between a key that works, a key the platform refuses, and an account that
// cannot spend - and storing a key that does not work would move the failure
// to the next agent session, where the person who could fix it is not looking.

import { readFileSync } from "node:fs";
import { bold, dim, green, yellow } from "../core/output.js";
import { HostedError, isHostedUrl } from "../core/hosted.js";
import { listDatabases } from "../core/account-api.js";
import { API_KEY_ENV } from "../core/config.js";
import {
  accountFilePath,
  keyFilePath,
  readStoredAccount,
  removeStoredKey,
  writeStoredAccount,
  writeStoredKey,
  type StoredAccount,
} from "../core/keystore.js";

/** Longest plausible key, as a guard on stdin: anything larger is a file that
 * is not a key (a pasted log, a whole config) and reporting that beats writing
 * it and failing on the next call. */
const MAX_KEY_CHARS = 4096;

export interface LoginCmdOptions {
  /** The platform, `https://host`. A full `https://host/<database>` is
   * accepted too and the database segment ignored: an account holds many. */
  db?: string;
  /** File holding the key. Without it, the key is read from standard input. */
  apiKeyFile?: string;
  /** Where a human manages billing on this platform, stored for the message
   * shown when the account runs out of credit. */
  consoleUrl?: string;
  /** Forget the stored key. */
  logout?: boolean;
  /** Report what is stored and change nothing. */
  show?: boolean;
}

/** A failure the user can act on; the CLI prints `error: <message>`. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/** What the command did, returned so a test can assert it without reading the
 * terminal. */
export interface LoginResult {
  action: "stored" | "logged-out" | "shown" | "nothing-to-forget";
  baseUrl?: string;
  keyPath?: string;
  databases?: string[];
}

/** The platform's base URL from what the user gave: a bare origin, or a full
 * database URL whose trailing segment is dropped. */
export function baseUrlFrom(raw: string): string {
  if (!isHostedUrl(raw)) {
    throw new LoginError(`--db must be an http(s) URL naming the platform, e.g. https://host (got ${JSON.stringify(raw)})`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new LoginError(`--db is not a URL: ${(err as Error).message}`);
  }
  // A database URL is `https://host/<database>`; anything deeper is not one,
  // and silently keeping only the origin would sign in to a platform the user
  // did not name.
  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length > 1) {
    throw new LoginError(
      `--db names the platform, not a path inside it: got ${url.pathname}. Use ${url.origin}, or ` +
        `${url.origin}/<database> - one repository's database, whose name is ignored here.`,
    );
  }
  return url.origin;
}

/** The key, from a file or from standard input, never from an argument. */
function readKey(opts: LoginCmdOptions, stdin: () => string): string {
  if (opts.apiKeyFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(opts.apiKeyFile, "utf8");
    } catch (err) {
      throw new LoginError(`cannot read ${opts.apiKeyFile}: ${(err as Error).message}`);
    }
    const key = text.trim();
    if (key === "") throw new LoginError(`${opts.apiKeyFile} is empty - it should hold the API key and nothing else`);
    return key;
  }
  const piped = stdin().trim();
  if (piped === "") {
    throw new LoginError(
      `no key given. Pipe it in - \`cx login --db <url> < keyfile\`, or \`pbpaste | cx login --db <url>\` - ` +
        `or pass --api-key-file <path>. There is deliberately no flag that takes the key itself: ` +
        `arguments are visible to every process on this machine.`,
    );
  }
  if (piped.length > MAX_KEY_CHARS) {
    throw new LoginError(`what arrived on standard input is ${piped.length} characters - that is not an API key`);
  }
  if (/\s/.test(piped)) {
    throw new LoginError("what arrived on standard input has whitespace inside it - an API key does not");
  }
  return piped;
}

/** Read all of standard input, or "" when it is a terminal (nothing piped). */
function stdinText(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function loginCmd(
  opts: LoginCmdOptions,
  deps: { stdin?: () => string; fetch?: typeof fetch } = {},
): Promise<LoginResult> {
  if (opts.logout) {
    const had = removeStoredKey();
    if (!had) {
      console.log(`${yellow("nothing to forget")} - no key stored at ${keyFilePath()}`);
      return { action: "nothing-to-forget" };
    }
    console.log(`${green("signed out")} - removed ${keyFilePath()}`);
    console.log(dim(`${accountFilePath()} is kept: it holds the platform URL, not a secret.`));
    return { action: "logged-out" };
  }

  if (opts.show) {
    const account = readStoredAccount();
    if (!account) {
      console.log(`${yellow("not signed in")} - no account at ${accountFilePath()}`);
      return { action: "shown" };
    }
    console.log(`${bold("platform")}  ${account.baseUrl}`);
    if (account.consoleUrl) console.log(`${bold("console")}   ${account.consoleUrl}`);
    console.log(`${bold("key")}       ${keyFilePath()}`);
    if (account.storedAt) console.log(dim(`stored ${account.storedAt}`));
    return { action: "shown", baseUrl: account.baseUrl, keyPath: keyFilePath() };
  }

  const stored = readStoredAccount();
  const raw = opts.db ?? stored?.baseUrl;
  if (raw === undefined) {
    throw new LoginError("--db <url> names the platform to sign in to, e.g. --db https://host");
  }
  const baseUrl = baseUrlFrom(raw);
  const apiKey = readKey(opts, deps.stdin ?? stdinText);

  // Use the key before storing it, so a key that does not work fails here,
  // in front of the person who can fix it.
  let databases: string[];
  try {
    databases = (await listDatabases({ baseUrl, apiKey }, { fetch: deps.fetch })).map((d) => d.name);
  } catch (err) {
    throw new LoginError(explainVerifyFailure(err, baseUrl));
  }

  const keyPath = writeStoredKey(apiKey);
  const account: StoredAccount = {
    baseUrl,
    ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : stored?.consoleUrl ? { consoleUrl: stored.consoleUrl } : {}),
    storedAt: new Date().toISOString(),
  };
  writeStoredAccount(account);

  console.log(`${green("signed in")} to ${bold(baseUrl)}`);
  console.log(`  key   ${keyPath} ${dim("(mode 600)")}`);
  console.log(`  ${databases.length} database${databases.length === 1 ? "" : "s"} on this account${databases.length ? dim(`: ${databases.join(", ")}`) : ""}`);
  console.log(dim("Now run `cx install` in a repository - no flags, no URL, no key."));
  return { action: "stored", baseUrl, keyPath, databases };
}

/** Turn a failed check into the sentence that names the fix. The three that
 * matter are distinguishable on the wire and have nothing to do with each
 * other, so they are never collapsed into "login failed". */
function explainVerifyFailure(err: unknown, baseUrl: string): string {
  if (!(err instanceof HostedError)) return `could not reach ${baseUrl}: ${(err as Error).message}`;
  if (err.unauthenticated) {
    return (
      `${baseUrl} refused that key. It may be revoked, rotated out, or issued by a different ` +
      `platform. Nothing was stored - the previous key, if any, is untouched.`
    );
  }
  if (err.paymentRequired) {
    return (
      `${baseUrl} accepted that key, but the account behind it cannot be used yet: it has no ` +
      `billing details on file. Add them and a card in the console, then run this again. ` +
      `Nothing was stored.`
    );
  }
  if (err.status === 0) return `could not reach ${baseUrl}: ${err.message}`;
  return `${baseUrl} answered ${err.status}: ${err.message}. Nothing was stored.`;
}

/** The one-line hint printed where a key would have been needed and none is
 * stored. Lives here so `cx install` and this command word it the same. */
export function signInHint(): string {
  return `run \`cx login --db <platform-url> < keyfile\` once - it stores the key in ${keyFilePath()} (mode 600) and every repository after that needs no flags. Or set ${API_KEY_ENV} in the client's environment.`;
}
