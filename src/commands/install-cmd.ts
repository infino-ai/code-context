// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` - write this server's MCP entry into a client's config, for
// users who reach code-context as a plain MCP server rather than through the
// Claude Code plugin. It writes the entry the plugin would otherwise supply:
// the command, the `mcp` subcommand, and whichever platform flags were asked
// for. Nothing else about the client is touched.
//
// The default target is `.mcp.json` in the repo root - project-scoped, so a
// colleague who opens the repo gets the server without setup, and shareable
// because it names a key *file* rather than a key. `--config` targets any
// client config using the same `mcpServers` shape (Cursor, Windsurf, a
// user-scoped Claude Code file).
//
// The API key is never written here. `--api-key-file` records the path the
// server reads at startup; the key itself stays in that file, out of argv and
// out of a config that may be committed. Passing a key value to this command
// is refused rather than quietly written.
//
// With no flags at all, this command uses the account `cx login` stored on
// this machine: it registers the repository's own database if it is not there
// yet, and writes an entry naming that database and nothing else. No key, and
// no path under anybody's home directory - the server finds the key itself, so
// the same `.mcp.json` works for every colleague who has signed in, and a
// second repository is again one command with no arguments.
//
// Three rules hold throughout, carried over from the enforcement installer
// this replaces: ownership is decided per server *name*, so other servers are
// never rewritten or removed; the replace is a temp file plus rename beside
// the real file the path resolves to, so a crash cannot truncate a config and
// a dotfile symlink survives it; and a config we cannot parse is refused
// rather than overwritten.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bold, dim, green, yellow } from "../core/output.js";
import { API_KEY_ENV } from "../core/config.js";
import { HostedError } from "../core/hosted.js";
import { createDatabase, databaseNameFor, requestTrial, type Trial } from "../core/account-api.js";
import { readStoredAccount, readStoredKey, writeStoredAccount, writeStoredKey } from "../core/keystore.js";
import { askUploadConsent, hasUploadConsent, recordUploadConsent, type ConsentDeps, type ConsentOutcome } from "../core/consent.js";
import { signInHint } from "./login-cmd.js";

/** Package this command installs, and the pinned spelling `npx` resolves. */
const PACKAGE_NAME = "@infino-ai/code-context";

/** Default name of the server entry we own inside `mcpServers`. */
const DEFAULT_SERVER_NAME = "code-context";

/** Default config file, relative to the repo root: Claude Code's
 * project-scoped MCP config, which is also what this repo itself ships. */
const PROJECT_CONFIG = ".mcp.json";

/** Indent for the config we write back, matching the shipped `.mcp.json`. */
const CONFIG_INDENT = 2;

/** Suffix of the temp file the atomic replace goes through. */
const TMP_SUFFIX = ".cx-tmp";

/** Depth of symlink hops followed before giving up, so a link cycle cannot
 * spin here forever. */
const MAX_LINK_HOPS = 40;

/** The key authenticated but may not address this database - its pattern
 * excludes the name, or the account lacks the entitlement. A repeated
 * decision, not a failed call. */
const HTTP_FORBIDDEN = 403;

/** This client's address has already taken its free trial. */
const HTTP_CONFLICT = 409;

/** This platform does not offer free accounts. Not a fault - a deployment
 * decision, and the client says so rather than reporting an error. */
const HTTP_NOT_IMPLEMENTED = 501;

/** Where a first install asks for an account.
 *
 * Deliberately unset in the source. A no-flag install has to know where to go,
 * and that address is the one thing that cannot be derived from anything on
 * the machine - so it is named by `--platform`, or by CX_PLATFORM_URL, or it
 * is not named and the install stays local. Shipping a default here would mean
 * a published client contacts one particular host, and creates an account
 * there, for anyone who runs `cx install` with no arguments: a release
 * decision, not a source default. Set it at release. */
const DEFAULT_PLATFORM_URL: string | undefined = undefined;

/** Environment override for the platform a first install asks, for a shell
 * installing into several repositories against one stack. */
const PLATFORM_URL_ENV = "CX_PLATFORM_URL";

export interface InstallCmdOptions {
  /** Remove our server entry instead of writing it. */
  uninstall?: boolean;
  /** Config file to write, instead of `<root>/.mcp.json`. */
  config?: string;
  /** Name of the server entry (default `code-context`). */
  name?: string;
  /** Repo root whose `.mcp.json` is written (default: current directory). */
  path?: string;
  /** Force an entry that runs this build directly, when the default would
   * have written `npx`. */
  local?: boolean;
  /** Force an `npx` entry pinned to this version, when the default would have
   * run this build directly. */
  npx?: boolean;
  /** Platform database URL, passed through to the server as `--db`. */
  db?: string;
  /** Path to the API key file, passed through as `--api-key-file`. */
  apiKeyFile?: string;
  /** Passed through as `--embed-provider`. */
  embedProvider?: string;
  /** Passed through as `--db-timeout-ms`. */
  dbTimeoutMs?: string;
  /** Passed through as `--cold-start-secs`. */
  coldStartSecs?: string;
  /** Print the entry that would be written and change nothing. */
  dryRun?: boolean;
  /** Write a local-tools-only entry even when this machine has an account:
   * for a repository whose contents must not leave it. */
  localOnly?: boolean;
  /** Agree to uploading this repository's contents without being asked, for a
   * script or a CI job that has no terminal to answer on. */
  yes?: boolean;
  /** The platform a first install asks for a free account, when this machine
   * has none. Overrides CX_PLATFORM_URL. */
  platform?: string;
}

/** Injected for tests: the platform, and the person at the terminal. */
export interface InstallDeps {
  fetch?: typeof fetch;
  consent?: ConsentDeps;
}

/** What the platform half of an install resolved to. */
interface PlatformSetup {
  /** The `--db` value to write, or undefined for a local-tools-only entry. */
  db?: string;
  /** Lines to print after the entry, explaining what was or was not set up. */
  notes: string[];
}

interface ServerEntry {
  command: string;
  args: string[];
  alwaysLoad?: boolean;
}

type Config = Record<string, unknown> & { mcpServers?: unknown };

/** A failure the user can act on. The CLI layer prints `error: <message>` and
 * sets the exit code; nothing here calls `process.exit`, so every branch stays
 * reachable from a test. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** `null`, `an array`, `a string`: enough for the user to see what they have. */
function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** The user's home directory, as an absolute path. `os.homedir()` answers ""
 * under `env -i`, systemd units, and some CI runners, and joining that yields
 * a relative config path that lands in the current working directory - which
 * looks like success and is not, so this fails loudly instead. */
function resolveHome(): string {
  const home = homedir();
  if (!isAbsolute(home)) {
    throw new InstallError(
      `cannot resolve your home directory - os.homedir() returned ${JSON.stringify(home)}. ` +
        `Set HOME to an absolute path, e.g. HOME=/home/you cx install, and re-run.`,
    );
  }
  return home;
}

/** Expand a leading `~` so `--config ~/.claude.json` works even when the
 * shell did not expand it (quoted, or passed through another tool). */
function expandHome(path: string): string {
  if (path === "~") return resolveHome();
  if (path.startsWith("~/")) return join(resolveHome(), path.slice(2));
  return path;
}

/** The real file a path names, following symlinks. A path whose parents exist
 * but whose leaf does not resolves to the leaf itself, so a first write lands
 * where the user pointed. */
function realTarget(path: string): string {
  let current = resolve(path);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      let parentReal: string;
      try {
        parentReal = realpathSync(parent);
      } catch {
        return current;
      }
      const candidate = join(parentReal, basename(current));
      let link: string;
      try {
        link = readlinkSync(candidate);
      } catch {
        return candidate;
      }
      current = isAbsolute(link) ? link : join(dirname(candidate), link);
    }
  }
  throw new InstallError(`too many symlinks to resolve ${path}`);
}

/** Parse the config, or `{}` when there is none. A file we cannot read as a
 * JSON object is the user's to fix: overwriting a config we did not understand
 * would cost them every server in it, not just ours. */
function readConfig(configPath: string): Config {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InstallError(
      `${configPath} is not valid JSON: ${(err as Error).message}. MCP config files are plain ` +
        `JSON - no comments, no trailing commas. Fix the file (or move it aside) and re-run.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstallError(
      `${configPath} holds ${describeJson(parsed)}, not a JSON object. ` +
        `Fix the file (or move it aside) and re-run.`,
    );
  }
  return parsed as Config;
}

/** The `mcpServers` block, validated far enough that our edit cannot fail
 * halfway through. Other servers in it pass through unread. */
function readServers(config: Config, configPath: string): Record<string, unknown> {
  const raw = config.mcpServers;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstallError(
      `"mcpServers" in ${configPath} is ${describeJson(raw)}, not an object of servers. ` +
        `Fix the file and re-run.`,
    );
  }
  return raw as Record<string, unknown>;
}

/** Replace the config in one filesystem step. A plain write truncates first,
 * so a crash - or a client reading while we write - can leave an empty config,
 * losing every server the user has. The rename lands on the real file behind
 * any symlink, and the temp file sits in that file's own directory so the
 * rename cannot cross a filesystem boundary. */
function writeConfig(configPath: string, config: Config): void {
  const target = realTarget(configPath);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(config, null, CONFIG_INDENT) + "\n";
  // A hardlinked config must be written in place: the rename swaps in a new
  // inode, quietly unlinking the file from its other name, so a dotfiles copy
  // would keep the old bytes forever. realpath cannot see a hardlink, so this
  // is decided on the link count, trading the atomic replace for keeping both
  // names one file.
  let links = 0;
  try {
    links = statSync(target).nlink;
  } catch {
    // No file yet - the rename path below creates it.
  }
  if (links > 1) {
    writeFileSync(target, json);
    return;
  }
  const tmp = join(dir, `${basename(target)}.${process.pid}${TMP_SUFFIX}`);
  try {
    writeFileSync(tmp, json);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Flags appended to the served `mcp` command, in the CLI's own order. A key
 * *value* here would end up in argv and in a possibly-committed file, so it is
 * refused: the flag takes a path. */
export function platformArgs(opts: InstallCmdOptions): string[] {
  const args: string[] = [];
  if (opts.db) args.push("--db", opts.db);
  if (opts.apiKeyFile) {
    const keyFile = expandHome(opts.apiKeyFile);
    if (!isAbsolute(keyFile)) {
      throw new InstallError(
        `--api-key-file must be an absolute path (got ${JSON.stringify(opts.apiKeyFile)}). The ` +
          `client resolves it from its own working directory, not yours, so a relative path ` +
          `would be written successfully and never read.`,
      );
    }
    args.push("--api-key-file", keyFile);
  }
  if (opts.embedProvider) args.push("--embed-provider", opts.embedProvider);
  if (opts.dbTimeoutMs) args.push("--db-timeout-ms", opts.dbTimeoutMs);
  if (opts.coldStartSecs) args.push("--cold-start-secs", opts.coldStartSecs);
  return args;
}

/** This build's own CLI entry point: `dist/cli.js`, one directory up from the
 * compiled copy of this module. Resolved from here rather than from the
 * repository being installed into, which is usually somewhere else entirely -
 * a checkout is built once and then installed into each repo you want to
 * search, so a path relative to the target would name a file that does not
 * exist there. */
function ownCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

/** Is the copy of the CLI running this install an installed package rather
 * than a source build? An installed one lives under a `node_modules`
 * directory - a project dependency, a global install, or npx's own cache all
 * do - while a clone that was built does not. */
function runningFromPackage(): boolean {
  return ownCliPath().split(sep).includes("node_modules");
}

/** The server entry to write.
 *
 * Which command it names is decided by where this CLI is running from, not by
 * a flag, because getting it wrong writes an entry that cannot start and the
 * default has to be the one that works:
 *
 * - an installed package (a dependency, a global install, npx's cache) writes
 *   an `npx` entry pinned to this version, so the client resolves the same
 *   published build on every start;
 * - a source build writes that build's own `dist/cli.js`, run through the
 *   absolute node running this install, because a client's process often has
 *   no node on PATH. Pinning `npx` here would name this package's version,
 *   which is not on the registry until it is released.
 *
 * `--local` and `--npx` force either, for the cases the check cannot know
 * about: a source build of a version that *is* published and meant to be
 * fetched, or an installed copy being used to write an entry for a checkout. */
export function serverEntry(opts: InstallCmdOptions, version: string): ServerEntry {
  const tail = ["mcp", ...platformArgs(opts)];
  const npx = opts.npx ?? (opts.local ? false : runningFromPackage());
  if (npx) {
    return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${version}`, ...tail], alwaysLoad: true };
  }
  return { command: process.execPath, args: [ownCliPath(), ...tail], alwaysLoad: true };
}

/** Refuse a key that was handed over as a value. Catching it here keeps the
 * secret out of the config file and out of the error message. */
function refuseInlineKey(opts: InstallCmdOptions): void {
  const looksLikeKey = (v: string | undefined) => v !== undefined && !v.includes("/") && v.length > 24;
  if (looksLikeKey(opts.apiKeyFile)) {
    throw new InstallError(
      `--api-key-file takes the path to a file holding the key, not the key itself. Write the key ` +
        `to a file (chmod 600) and pass that path, or leave the flag off and set ${API_KEY_ENV} ` +
        `in the client's environment.`,
    );
  }
}

/** The platform half of an install, in one place because there are three ways
 * to arrive at it and only one of them is a flag.
 *
 * `--db` given: exactly what was asked for, unchanged.
 * No flags, an account stored: this repository's own database on that account,
 *   registered here if it is not there yet. The entry names the database and
 *   nothing else - not the key, not a path to it - because the server resolves
 *   the key from the same stored account at startup. That is what makes the
 *   config shareable and the second repository flag-free.
 * No flags, no account: the three local tools, and the one line that says how
 *   to get the other two.
 *
 * A create that fails does not always cancel the platform half. A network
 * blip or a 5xx is transient and the entry is still the right one to write; a
 * refused key or an unpayable account is not, and writing a database entry
 * that can never answer would hand the user a config that fails every session
 * with no clue why. So those write a local-only entry and say so. */
async function resolvePlatform(
  opts: InstallCmdOptions,
  root: string,
  deps: InstallDeps,
): Promise<PlatformSetup> {
  if (opts.db) return { db: opts.db, notes: [] };
  if (opts.localOnly) {
    return { notes: ["Local tools only (find / search / sql), as asked: nothing about this repository leaves it."] };
  }

  const account = readStoredAccount();
  const apiKey = readStoredKey();
  if (!account || apiKey === undefined) {
    return await firstRun(opts, root, deps);
  }

  const baseUrl = account.baseUrl.replace(/\/+$/, "");
  const database = databaseNameFor(root);
  const db = `${baseUrl}/${database}`;

  if (opts.dryRun) {
    return { db, notes: [`would register the database ${database} on ${baseUrl} if it is not there yet`] };
  }

  // Consent before the first upload, not after. Registering the database is
  // the step that commits this repository to the platform, so the question
  // comes before it - and a no leaves a working local-only install rather
  // than a half-configured one.
  const consent = opts.yes ? grantWithoutAsking() : await askUploadConsent(baseUrl, database, root, deps.consent);
  if (consent === "declined") {
    return { notes: ["Local tools only (find / search / sql), as you asked: nothing about this repository leaves it."] };
  }
  if (consent === "no-terminal") {
    return {
      notes: [
        `Local tools only (find / search / sql): enabling ask and explore uploads this repository's contents, and there is no terminal here to ask.`,
        `Re-run \`cx install\` from a terminal, or pass --yes to agree without being asked.`,
      ],
    };
  }

  try {
    const outcome = await createDatabase({ baseUrl, apiKey }, database, { fetch: deps.fetch });
    return {
      db,
      notes: [
        outcome === "created"
          ? `registered the database ${database} on ${baseUrl} for this repository`
          : `using the database ${database} already on ${baseUrl}`,
      ],
    };
  } catch (err) {
    return accountUnusable(err)
      ? { notes: [`Local tools only (find / search / sql): ${unusableReason(err, baseUrl)}`] }
      : {
          db,
          notes: [
            `could not register the database ${database} on ${baseUrl}: ${(err as Error).message}`,
            `The entry is written anyway - the first \`cx index\` retries. If it keeps failing, the database has to exist before ask and explore work.`,
          ],
        };
  }
}

/** The first install on a machine with no account: ask, then get one.
 *
 * This is the only path that creates an account, so the question comes before
 * the request and covers both halves - an account will be made, and this
 * repository's contents will be uploaded. A no, or no terminal, leaves a
 * working local-only install and no account anywhere.
 *
 * Three answers from the platform are ordinary rather than broken, and each
 * one leaves the local tools working:
 *
 * - `501`: this platform does not offer a trial. Nothing is wrong; a key has
 *   to come from somewhere else, so say where.
 * - `409`: this address has already had its free trial. Also not broken -
 *   sign in to the account it made.
 * - anything else: report it as the failure it is, and do not pretend a
 *   local-only install was what was asked for.
 */
async function firstRun(
  opts: InstallCmdOptions,
  root: string,
  deps: InstallDeps,
): Promise<PlatformSetup> {
  const named = opts.platform ?? process.env[PLATFORM_URL_ENV] ?? DEFAULT_PLATFORM_URL;
  if (named === undefined || named === "") {
    return {
      notes: [
        `Local tools only (find / search / sql). ask and explore need an Infino account, and this build names no platform to get one from.`,
        `Point it at one: \`cx install --platform https://host\` (or set ${PLATFORM_URL_ENV}). Or, with a key already, ${signInHint()}`,
      ],
    };
  }
  const baseUrl = named.replace(/\/+$/, "");
  const database = databaseNameFor(root);

  if (opts.dryRun) {
    return { db: `${baseUrl}/${database}`, notes: [`would ask ${baseUrl} for a free account and register ${database}`] };
  }

  const consent = opts.yes
    ? "granted"
    : await askUploadConsent(baseUrl, database, root, { ...deps.consent, newAccount: true });
  if (consent === "declined") {
    return { notes: ["Local tools only (find / search / sql), as you asked: no account was created and nothing left this machine."] };
  }
  if (consent === "no-terminal") {
    return {
      notes: [
        `Local tools only (find / search / sql): ask and explore need an Infino account, and creating one uploads this repository's contents - there is no terminal here to ask.`,
        `Re-run \`cx install\` from a terminal, or pass --yes to agree without being asked.`,
      ],
    };
  }

  let trial: Trial;
  try {
    trial = await requestTrial(baseUrl, database, { fetch: deps.fetch });
  } catch (err) {
    return { notes: trialRefusalNotes(err, baseUrl) };
  }

  const keyPath = writeStoredKey(trial.apiKey);
  writeStoredAccount({
    baseUrl,
    ...(trial.consoleUrl ? { consoleUrl: trial.consoleUrl } : {}),
    storedAt: new Date().toISOString(),
    uploadConsentAt: new Date().toISOString(),
  });

  return {
    db: `${baseUrl}/${trial.database}`,
    notes: [
      `created a free Infino account on ${baseUrl} with ${formatCredit(trial.creditCents)} of credit`,
      `  key   ${keyPath} (mode 600) - no email, no password, no card`,
      `  db    ${trial.database}`,
      `Every other repository is now one flag-free \`cx install\`.`,
    ],
  };
}

/** Cents as a person reads money, so a receipt does not say "1000". */
function formatCredit(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What to print when a trial was not granted. Each of the three cases has a
 * different next step, and none of them is "something went wrong". */
function trialRefusalNotes(err: unknown, baseUrl: string): string[] {
  const local = "Local tools only (find / search / sql)";
  if (err instanceof HostedError && err.status === HTTP_NOT_IMPLEMENTED) {
    return [`${local}: ${baseUrl} does not offer free accounts.`, `For ask and explore, ${signInHint()}`];
  }
  if (err instanceof HostedError && err.status === HTTP_CONFLICT) {
    return [
      `${local}: this machine's network has already used its free trial on ${baseUrl}.`,
      `For ask and explore, ${signInHint()}`,
    ];
  }
  return [
    `${local}: could not get an account from ${baseUrl} - ${(err as Error).message}`,
    `Re-run \`cx install\` to try again, or ${signInHint()}`,
  ];
}

/** `--yes`: a script agreeing on its user's behalf. Recorded like any other
 * agreement, so a later interactive run does not ask again and the account
 * file says when consent was given either way. */
function grantWithoutAsking(): ConsentOutcome {
  if (hasUploadConsent()) return "already-given";
  recordUploadConsent(new Date().toISOString());
  return "granted";
}

/** Whether a failed create means this account cannot serve this repository at
 * all, as opposed to a call that happened to fail. A refused key, an account
 * with no billing details, and a key whose pattern excludes this database are
 * all decisions the platform will repeat; everything else may not be. */
function accountUnusable(err: unknown): err is HostedError {
  return err instanceof HostedError && (err.unauthenticated || err.paymentRequired || err.status === HTTP_FORBIDDEN);
}

/** Why the account cannot serve this repository, as a sentence naming the fix
 * rather than the status code that carried it. */
function unusableReason(err: HostedError, baseUrl: string): string {
  if (err.paymentRequired) {
    return `${baseUrl} has no billing details on file for this account, so it will not open a database. Add them and a card in the console, then re-run \`cx install\`.`;
  }
  if (err.unauthenticated) {
    return `${baseUrl} refused the key stored on this machine. Run \`cx login --db ${baseUrl} < keyfile\` with a current one, then re-run \`cx install\`.`;
  }
  return `${baseUrl} will not let this key open a database for this repository (${err.message}). Re-run \`cx install\` once that is sorted.`;
}

export async function installCmd(
  opts: InstallCmdOptions,
  version: string,
  deps: InstallDeps = {},
): Promise<void> {
  refuseInlineKey(opts);
  const root = resolve(opts.path ?? process.cwd());
  const configPath = opts.config ? resolve(expandHome(opts.config)) : join(root, PROJECT_CONFIG);
  const name = opts.name ?? DEFAULT_SERVER_NAME;

  const config = readConfig(configPath);
  const servers = readServers(config, configPath);

  if (opts.uninstall) {
    if (!(name in servers)) {
      console.log(`${yellow("nothing to remove")} - no ${bold(name)} server in ${configPath}`);
      return;
    }
    const { [name]: _removed, ...rest } = servers;
    const next: Config = { ...config, mcpServers: rest };
    if (opts.dryRun) {
      console.log(`${dim("would remove")} ${bold(name)} from ${configPath}`);
      return;
    }
    writeConfig(configPath, next);
    console.log(`${green("removed")} ${bold(name)} from ${configPath}`);
    console.log(dim("Restart the client to drop the server."));
    return;
  }

  const setup = await resolvePlatform(opts, root, deps);
  const entry = serverEntry({ ...opts, db: setup.db }, version);
  const existed = name in servers;
  const next: Config = { ...config, mcpServers: { ...servers, [name]: entry } };

  if (opts.dryRun) {
    console.log(`${dim(existed ? "would replace" : "would write")} ${bold(name)} in ${configPath}:`);
    console.log(JSON.stringify(entry, null, CONFIG_INDENT));
    for (const note of setup.notes) console.log(dim(note));
    return;
  }

  writeConfig(configPath, next);
  console.log(`${green(existed ? "updated" : "installed")} ${bold(name)} in ${configPath}`);
  console.log(`  ${dim(entry.command)} ${dim(entry.args.join(" "))}`);
  for (const note of setup.notes) console.log(dim(note));
  console.log(dim("Restart the client to pick the server up."));
}
