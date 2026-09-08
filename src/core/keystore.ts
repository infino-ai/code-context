// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The account on this machine: a bearer key in a file only its owner can read,
// and beside it the plain facts needed to use it - which platform it belongs to
// and where its console is.
//
// It lives in the user's own `~/.infino/`, not in a repository's `.infino/`,
// because an account is per-person and a repository is not. One account holds
// every repository's database, so a copy in each repo would be the same secret
// written once per checkout - into directories that get committed, zipped,
// copied to a colleague, or synced to a backup. Once, in the home directory,
// with every repo's MCP entry naming that one path, is the same key with one
// place to protect and one place to revoke.
//
// The key is written at 0600 and the directory at 0700, on every write, not
// only on create: a file that already existed with looser permissions is
// tightened rather than trusted. Reading one that is still readable by anyone
// else warns - it is the user's file and refusing to work would be worse than
// telling them - but nothing here ever prints the key itself.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { yellow } from "./output.js";

/** Directory holding the account, under the user's home. Deliberately the same
 * name as a repository's index directory: one product, one dot-directory, and
 * the two never share a parent. */
export const ACCOUNT_DIR_NAME = ".infino";

/** The bearer key's file name inside that directory. */
export const KEY_FILE_NAME = "key";

/** The account's non-secret facts, beside the key. */
export const ACCOUNT_FILE_NAME = "account.json";

/** Mode the key file is held at: readable and writable by its owner, nothing
 * for group or other. */
export const KEY_FILE_MODE = 0o600;

/** Mode the account directory is held at: only its owner may even list it, so
 * the key's existence is not advertised. */
const ACCOUNT_DIR_MODE = 0o700;

/** Overrides the account directory, for tests and for a machine where several
 * accounts have to coexist. */
const ACCOUNT_DIR_ENV = "CX_ACCOUNT_DIR";

/** Suffix of the temp file a key write goes through. */
const TMP_SUFFIX = ".cx-tmp";

/** The bits that mean "someone other than the owner can read this". */
const GROUP_OR_OTHER = 0o077;

/** What is known about the account this machine is signed in to. Not secret -
 * the key is the secret, and it is in its own file. */
export interface StoredAccount {
  /** The platform's base URL, `https://host` - no database segment: one
   * account holds many databases, one per repository. */
  baseUrl: string;
  /** Where a human goes to see usage, add billing details and add a card.
   * Absent when the platform did not name one. */
  consoleUrl?: string;
  /** When this account was stored, ISO 8601, so `cx status` can say how old
   * the sign-in is without asking the platform. */
  storedAt: string;
}

/** The account directory: `$CX_ACCOUNT_DIR`, else `~/.infino`.
 *
 * `os.homedir()` answers `""` under `env -i`, systemd units and some CI
 * runners; joining that yields a relative path that lands in the current
 * working directory, which looks like success and is not - so an unusable home
 * is an error naming the fix rather than a key written into a repository. */
export function accountDir(): string {
  const override = process.env[ACCOUNT_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  const home = homedir();
  if (!isAbsolute(home)) {
    throw new Error(
      `cannot resolve your home directory - os.homedir() returned ${JSON.stringify(home)}, so there ` +
        `is nowhere to keep the account key. Set HOME to an absolute path, or set ${ACCOUNT_DIR_ENV}.`,
    );
  }
  return join(home, ACCOUNT_DIR_NAME);
}

/** Path of the bearer key's file. */
export function keyFilePath(): string {
  return join(accountDir(), KEY_FILE_NAME);
}

/** Path of the account's non-secret facts. */
export function accountFilePath(): string {
  return join(accountDir(), ACCOUNT_FILE_NAME);
}

/** The stored bearer key, or undefined when this machine has none. Whitespace
 * is trimmed, so a file written by `echo` works. An empty file reads as no key
 * rather than as an empty credential that would fail as an opaque 401. */
export function readStoredKey(): string | undefined {
  const path = keyFilePath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  warnIfReadableByOthers(path);
  const key = text.trim();
  return key === "" ? undefined : key;
}

/** Write the bearer key, creating the account directory if needed, and return
 * its path. The value never reaches a log, an error or argv: it is written
 * through a temp file created at 0600, so the key is never briefly world
 * readable, and the rename lands it atomically. */
export function writeStoredKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") throw new Error("refusing to store an empty API key");
  const dir = accountDir();
  mkdirSync(dir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  // A pre-existing directory keeps whatever mode it had, so tighten it too.
  tighten(dir, ACCOUNT_DIR_MODE);
  const path = keyFilePath();
  const tmp = `${path}.${process.pid}${TMP_SUFFIX}`;
  try {
    writeFileSync(tmp, `${trimmed}\n`, { mode: KEY_FILE_MODE });
    // `mode` is only honoured on create, and a umask can loosen it further, so
    // the mode is set explicitly before the file becomes reachable.
    chmodSync(tmp, KEY_FILE_MODE);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

/** Forget the stored key, returning whether there was one. The account facts
 * stay: they are not secret, and keeping them means a re-issued key needs no
 * URL typed again. */
export function removeStoredKey(): boolean {
  const path = keyFilePath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The stored account, or undefined when this machine has none. A file that is
 * not the shape this wrote reads as absent: it is regenerated by the next
 * sign-in, so refusing would strand the user on a file they never edited. */
export function readStoredAccount(): StoredAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(accountFilePath(), "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { baseUrl, consoleUrl, storedAt } = parsed as Record<string, unknown>;
  if (typeof baseUrl !== "string" || baseUrl === "") return undefined;
  return {
    baseUrl,
    ...(typeof consoleUrl === "string" && consoleUrl !== "" ? { consoleUrl } : {}),
    storedAt: typeof storedAt === "string" ? storedAt : "",
  };
}

/** Write the account's non-secret facts and return the path. */
export function writeStoredAccount(account: StoredAccount): string {
  const dir = accountDir();
  mkdirSync(dir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  tighten(dir, ACCOUNT_DIR_MODE);
  const path = accountFilePath();
  writeFileSync(path, `${JSON.stringify(account, null, 2)}\n`);
  return path;
}

/** Set a mode, ignoring a failure: a directory somebody else owns cannot be
 * chmod'ed, and that is their choice to have made, not a reason to refuse to
 * read a key out of it. */
function tighten(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* not ours to tighten */
  }
}

/** Warn once per read when the key file is readable beyond its owner. It is
 * the user's file and their machine, so this says what is wrong and how to fix
 * it rather than refusing; the message never contains the key. */
function warnIfReadableByOthers(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return;
  }
  if ((mode & GROUP_OR_OTHER) === 0) return;
  console.error(
    yellow(
      `! ${path} is readable by other users on this machine (mode ${(mode & 0o777).toString(8)}). ` +
        `It holds your Infino API key. Fix with: chmod 600 ${path}`,
    ),
  );
}
