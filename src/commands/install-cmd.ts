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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { bold, dim, green, yellow } from "../core/output.js";
import { API_KEY_ENV } from "../core/config.js";

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

export interface InstallCmdOptions {
  /** Remove our server entry instead of writing it. */
  uninstall?: boolean;
  /** Config file to write, instead of `<root>/.mcp.json`. */
  config?: string;
  /** Name of the server entry (default `code-context`). */
  name?: string;
  /** Repo root whose `.mcp.json` is written (default: current directory). */
  path?: string;
  /** Run the checked-out build (`node <root>/dist/cli.js`) instead of `npx`. */
  local?: boolean;
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

/** The server entry to write. `npx` with a pinned version by default, so the
 * client resolves the same build every start; `--local` runs this checkout's
 * own `dist/cli.js` through the absolute node running this install, because a
 * client's process often has no node on PATH.
 *
 * `--local` is the right choice from a source build, and not only a
 * preference: the pinned `npx` spec names this package's version, which is
 * not on the registry until it is released, so an unreleased build that wrote
 * an `npx` entry would hand the client a version it cannot fetch. */
export function serverEntry(opts: InstallCmdOptions, version: string): ServerEntry {
  const tail = ["mcp", ...platformArgs(opts)];
  if (opts.local) {
    return { command: process.execPath, args: [ownCliPath(), ...tail], alwaysLoad: true };
  }
  return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${version}`, ...tail], alwaysLoad: true };
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

export function installCmd(opts: InstallCmdOptions, version: string): void {
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

  const entry = serverEntry(opts, version);
  const existed = name in servers;
  const next: Config = { ...config, mcpServers: { ...servers, [name]: entry } };

  if (opts.dryRun) {
    console.log(`${dim(existed ? "would replace" : "would write")} ${bold(name)} in ${configPath}:`);
    console.log(JSON.stringify(entry, null, CONFIG_INDENT));
    return;
  }

  writeConfig(configPath, next);
  console.log(`${green(existed ? "updated" : "installed")} ${bold(name)} in ${configPath}`);
  console.log(`  ${dim(entry.command)} ${dim(entry.args.join(" "))}`);
  if (!opts.db) {
    console.log(dim("Local tools only (find / search / sql). Add --db and --api-key-file for ask and explore."));
  }
  console.log(dim("Restart the client to pick the server up."));
}
