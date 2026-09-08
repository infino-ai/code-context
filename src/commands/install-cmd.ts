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
import { createDatabase, databaseNameFor } from "../core/account-api.js";
import { readStoredAccount, readStoredKey } from "../core/keystore.js";
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
  deps: { fetch?: typeof fetch },
): Promise<PlatformSetup> {
  if (opts.db) return { db: opts.db, notes: [] };
  if (opts.localOnly) {
    return { notes: ["Local tools only (find / search / sql), as asked: nothing about this repository leaves it."] };
  }

  const account = readStoredAccount();
  const apiKey = readStoredKey();
  if (!account || apiKey === undefined) {
    return { notes: [`Local tools only (find / search / sql). For ask and explore, ${signInHint()}`] };
  }

  const baseUrl = account.baseUrl.replace(/\/+$/, "");
  const database = databaseNameFor(root);
  const db = `${baseUrl}/${database}`;

  if (opts.dryRun) {
    return { db, notes: [`would register the database ${database} on ${baseUrl} if it is not there yet`] };
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
  deps: { fetch?: typeof fetch } = {},
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
