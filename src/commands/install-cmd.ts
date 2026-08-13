// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` - wire index-first enforcement into Claude Code, for users who
// reach code-context as a plain MCP server (`npx`, `claude mcp add-json`)
// rather than through the Claude Code plugin. The plugin ships the same hooks
// in its own `hooks/` directory; this command is the path for a hand-wired
// server, and it is the only path that survives a client restart without
// per-session setup.
//
// Claude Code only. The hook schema written here and `~/.claude/settings.json`
// are Claude Code's; other MCP clients (Cursor, Windsurf, ...) run the same
// `sql` and `reindex` tools but expose no hook surface, so there is nothing
// for this command to configure there and it does not pretend otherwise.
//
// What it writes, all idempotent and reversible with --uninstall:
//   ~/.claude/hooks/cx-deny-grep.mjs   the hook itself, copied from the package
//   ~/.claude/settings.json            SessionStart + PreToolUse entries
//
// The hook command embeds `process.execPath` - the absolute node that is
// running this install - because the client's process often has no node on
// PATH (a hand-wired MCP entry with an absolute node path is the common case),
// and a hook that cannot find node fails silently, which reads exactly like
// "enforcement isn't working". The same reasoning makes every path absolute
// and makes an unresolvable home directory an error: a relative settings or
// script path resolves against whatever directory the client happens to be
// in, so it would be written successfully and never run.
//
// The settings file belongs to the user - their other hooks, their unrelated
// keys - so three rules hold everywhere below: ownership is decided per hook
// *command* (the resolved script path we copied in) and never per entry; the
// rewrite is a temp file plus rename beside the *real* file the path resolves
// to, so a crash cannot truncate it and a dotfile symlink survives it; and
// anything we cannot parse is refused rather than overwritten.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

/** Name the packaged hook is copied to, inside the settings directory. */
const HOOK_BASENAME = "cx-deny-grep.mjs";

/** Subdirectory of the settings directory that holds hook scripts. */
const HOOK_DIR = "hooks";

/** Claude Code's settings directory and its default settings file. */
const CLAUDE_DIR = ".claude";
const SETTINGS_BASENAME = "settings.json";

/** Tool names the PreToolUse hook inspects: the built-in search tools plus a
 * legacy code-context `search` tool from a pre-2.0 server. */
const PRE_TOOL_MATCHER = "Grep|Bash|mcp__.*code[-_]context.*__search";

/** The hook events this command owns. Every other event in the file, and
 * every hook in these two that is not ours, is left exactly as found. */
const OUR_EVENTS = ["SessionStart", "PreToolUse"] as const;

/** Files beside the target a live hook command can hide in. Claude Code loads
 * `settings.json` and `settings.local.json` from one directory and `--settings`
 * takes any name at all, so the sibling scan reads every JSON file there
 * rather than guessing at names: they share one hooks/ directory, and the
 * script we would delete is the one the survivor runs. */
const JSON_FILE = /\.json$/i;

/** Trailing argument of a hook command, quoted or bare - where our entries
 * carry the script path. */
const QUOTED_TAIL = /"([^"]*)"\s*$/;
const BARE_TAIL = /(\S+)\s*$/;

/** Indent for the settings file we write back, matching Claude Code's own. */
const SETTINGS_INDENT = 2;

/** Suffix of the temp file the atomic settings replace goes through. */
const TMP_SUFFIX = ".cx-tmp";

export interface InstallCmdOptions {
  /** Remove the hook and its settings entries instead of installing. */
  uninstall?: boolean;
  /** Target a settings file other than ~/.claude/settings.json. */
  settings?: string;
  /** Install into a project-scoped `.claude` directory anyway - only sensible
   * for a settings file that stays on this machine (a gitignored
   * settings.local.json); see the refusal in `installCmd`. */
  force?: boolean;
}

interface HookCommand {
  type: string;
  command: string;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

type Settings = Record<string, unknown> & { hooks?: unknown };

/** A failure the user can act on. The CLI layer prints `error: <message>` and
 * sets the exit code; nothing in here calls `process.exit`, so every branch
 * stays reachable from a test. */
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
 * under `env -i`, systemd units, and some CI runners; joining that yields a
 * relative settings path that lands in the current working directory and a
 * relative script path in the hook command. Both look like success and
 * neither works, so this fails loudly instead. */
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

/** Parse the settings file, or `{}` when there is none. A file we cannot read
 * as a JSON object is the user's to fix: Claude Code settings are plain JSON
 * (no comments, no trailing commas), and overwriting a file we did not
 * understand would cost them every setting in it, not just our hooks. */
function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {};
  const text = readFileSync(settingsPath, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InstallError(
      `${settingsPath} is not valid JSON: ${(err as Error).message}. Claude Code settings are plain ` +
        `JSON - no comments, no trailing commas. Fix the file (or move it aside) and re-run.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstallError(
      `${settingsPath} holds ${describeJson(parsed)}, not a JSON object of settings. ` +
        `Fix the file (or move it aside) and re-run.`,
    );
  }
  return parsed as Settings;
}

/** The `hooks` block, validated far enough that our edits cannot fail halfway
 * through: the block must be an object, and each event we touch must be an
 * array of entries. Events we do not touch pass through unread. */
function readHooks(settings: Settings, settingsPath: string): Record<string, HookEntry[]> {
  const raw = settings.hooks;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstallError(
      `"hooks" in ${settingsPath} is ${describeJson(raw)}, not an object of hook events. ` +
        `Fix the file and re-run.`,
    );
  }
  const hooks = raw as Record<string, HookEntry[]>;
  for (const event of OUR_EVENTS) {
    const entries: unknown = hooks[event];
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new InstallError(
        `"hooks.${event}" in ${settingsPath} is ${describeJson(entries)}, not an array of hook ` +
          `entries. Fix the file and re-run.`,
      );
    }
  }
  return hooks;
}

/** The trailing argument of a hook command, without its quotes. */
function trailingArg(command: string): string {
  const quoted = QUOTED_TAIL.exec(command);
  if (quoted) return quoted[1];
  const bare = BARE_TAIL.exec(command);
  return bare ? bare[1] : "";
}

/** Does this hook run the script we copied in? Keyed on the resolved path we
 * wrote, not on the basename: a wrapper of the user's own that merely names
 * `cx-deny-grep.mjs` on its command line is not ours to remove. */
function runsOurHook(hook: unknown, hookPath: string): boolean {
  const command = (hook as HookCommand | null)?.command;
  return typeof command === "string" && trailingArg(command) === hookPath;
}

/** One event's entries with our hook taken out. The filter runs at the inner
 * level: an entry the user shares with us keeps its matcher and its own
 * hooks, and only disappears when ours was the last hook in it. Entries that
 * are not the shape we write pass through untouched. */
function withoutOurHook(entries: HookEntry[], hookPath: string): HookEntry[] {
  const kept: HookEntry[] = [];
  for (const entry of entries) {
    const inner = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(inner)) {
      kept.push(entry);
      continue;
    }
    const others = inner.filter((hook) => !runsOurHook(hook, hookPath));
    if (others.length === inner.length) kept.push(entry);
    else if (others.length > 0) kept.push({ ...entry, hooks: others });
  }
  return kept;
}

/** Does this settings text still run `hookPath`? A file we cannot parse counts
 * as a reference when it names our script at all: keeping a hook file nothing
 * runs is harmless, deleting one that is still wired up breaks every tool call
 * in that session with MODULE_NOT_FOUND. */
function referencesHook(text: string, hookPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.includes(HOOK_BASENAME);
  }
  const hooks = (parsed as Settings | null)?.hooks;
  if (hooks === null || typeof hooks !== "object") return false;
  return Object.values(hooks as Record<string, unknown>).some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some((entry) => {
        const inner = (entry as { hooks?: unknown } | null)?.hooks;
        return Array.isArray(inner) && inner.some((hook) => runsOurHook(hook, hookPath));
      }),
  );
}

/** Settings files beside `settingsPath` that still run `hookPath`. Claude Code
 * loads settings.json and settings.local.json from the same directory and the
 * hook path we write is identical for both, so uninstalling one must not
 * delete the script the other still points at. The file we are uninstalling is
 * skipped by real path, so a link to it does not count as a second user. */
function siblingsUsingHook(settingsDir: string, settingsPath: string, hookPath: string): string[] {
  let names: string[];
  try {
    names = readdirSync(settingsDir);
  } catch {
    return [];
  }
  const self = realTarget(settingsPath);
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(settingsDir, name);
    if (!JSON_FILE.test(name) || realTarget(candidate) === self) continue;
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    if (referencesHook(text, hookPath)) found.push(candidate);
  }
  return found;
}

/** The file a path really names: the link target when it is a symlink, the
 * path itself when it is not or does not exist yet. Dotfile managers make
 * `~/.claude/settings.json` a symlink into a version-controlled directory, so
 * every step that replaces or identifies the file has to follow the link -
 * writing a new file at the link's own path would leave the tracked copy
 * holding stale bytes, with the user's settings silently no longer applying. */
function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // realpath fails on a link whose target does not exist yet - a dotfiles
    // checkout that has not happened. Follow the link by hand so the write
    // creates the tracked file instead of replacing the link with a copy.
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      // Not a link, or nothing there at all: the path is its own target.
      return path;
    }
  }
}

/** Replace the settings file in one filesystem step. A plain write truncates
 * first, so a crash - or a client reading while we write - can leave an empty
 * settings.json, losing every setting the user has. The rename lands on the
 * real file behind any symlink, and the temp file sits in that file's own
 * directory so the rename cannot cross a filesystem boundary. */
function writeSettings(settingsPath: string, settings: Settings): void {
  const target = realTarget(settingsPath);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(settings, null, SETTINGS_INDENT) + "\n";
  // A hardlinked settings file must be written in place: the rename swaps in a
  // new inode, quietly unlinking the file from its other name, so a dotfiles
  // copy keeps the old bytes forever. realpath cannot see a hardlink, so this
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

/** Does this settings file belong to a project checkout rather than the user?
 * A `.claude` directory anywhere but the home one is a repo's: that file is
 * shareable and usually version-controlled. The home lookup runs only for a
 * `.claude` target, so any other --settings path stays usable without one.
 * The comparison is on real paths: a relocated or symlinked home (HOME as a
 * link, macOS /tmp -> /private/tmp) spells the same directory two ways, and
 * refusing the user's own settings file over spelling is a false alarm. */
function isProjectScoped(settingsDir: string): boolean {
  if (basename(settingsDir) !== CLAUDE_DIR) return false;
  const homeClaude = join(resolveHome(), CLAUDE_DIR);
  if (settingsDir === homeClaude) return false;
  return realTarget(settingsDir) !== realTarget(homeClaude);
}

/** The packaged hook source: `<package root>/hooks/deny-grep.mjs`, resolved
 * from this module's location so it works from a global install, an npx
 * cache, or a local checkout alike. */
function packagedHook(): string {
  // dist/commands/install-cmd.js -> package root is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", HOOK_DIR, "deny-grep.mjs");
}

/** Remove our hooks from one settings file, then the script - but only once no
 * sibling settings file in that directory still runs it. */
function uninstall(settingsPath: string, settingsDir: string, hookPath: string): void {
  if (!existsSync(settingsPath)) {
    // Creating a settings file (and a .claude directory) to prove it holds
    // none of our hooks would be a strange thing for a removal to do.
    console.log(`${dim("nothing to remove")} - ${settingsPath} does not exist`);
    return;
  }

  const settings = readSettings(settingsPath);
  const hooks = readHooks(settings, settingsPath);
  const before = JSON.stringify(hooks);
  for (const event of OUR_EVENTS) {
    const rest = withoutOurHook(hooks[event] ?? [], hookPath);
    if (rest.length > 0) hooks[event] = rest;
    else delete hooks[event];
  }
  const changed = JSON.stringify(hooks) !== before;

  if (changed) {
    // Ours were the only entries: leave no empty "hooks" husk behind.
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
    writeSettings(settingsPath, settings);
    console.log(`${green("removed")} code-context enforcement from ${bold(settingsPath)}`);
    console.log(dim("  start a new Claude Code session for the removal to take effect"));
  } else {
    console.log(`${dim("nothing to remove")} - no code-context hooks in ${settingsPath}`);
  }

  if (existsSync(hookPath)) {
    const stillUsed = siblingsUsingHook(settingsDir, settingsPath, hookPath);
    if (stillUsed.length === 0) rmSync(hookPath, { force: true });
    else console.log(dim(`  kept ${hookPath} - still run by ${stillUsed.join(", ")}`));
  }
}

export function installCmd(opts: InstallCmdOptions): void {
  const settingsPath = opts.settings
    ? resolve(opts.settings)
    : join(resolveHome(), CLAUDE_DIR, SETTINGS_BASENAME);
  const settingsDir = dirname(settingsPath);
  const hookPath = join(settingsDir, HOOK_DIR, HOOK_BASENAME);
  // `resolve` and the home join both produce absolute paths; assert it before
  // the path reaches a hook command, where a relative script would resolve
  // against the client's working directory and quietly never run.
  if (!isAbsolute(hookPath)) {
    throw new InstallError(
      `refusing to write the relative hook path ${hookPath} into a hook command - ` +
        `pass an absolute path to --settings.`,
    );
  }

  if (opts.uninstall) {
    uninstall(settingsPath, settingsDir, hookPath);
    return;
  }

  // Everything we write is specific to this machine, so a settings file meant
  // to be shared is the one place it must not go. Uninstall stays allowed
  // above, so a --force install can always be undone.
  if (isProjectScoped(settingsDir) && !opts.force) {
    throw new InstallError(
      [
        `${settingsPath} looks like a project-scoped Claude Code settings file, not your own.`,
        `Its entries would carry absolute paths from this machine (${process.execPath}, plus a hook` +
          ` file copied inside the project), so a teammate who checks the file out gets` +
          ` MODULE_NOT_FOUND on every tool call instead of enforcement.`,
        `To share enforcement with a team, use the code-context plugin for Claude Code - it resolves` +
          ` the hook from the plugin root on each machine.`,
        `To install it for yourself, run \`cx install\` with no --settings. Add --force only for a` +
          ` settings file that stays on this machine, such as a gitignored settings.local.json.`,
      ].join("\n"),
    );
  }

  const source = packagedHook();
  if (!existsSync(source)) {
    throw new InstallError(
      `packaged hook not found at ${source} - this copy of the package is missing its hooks/ ` +
        `directory. Reinstall it (npm i -g @infino-ai/code-context) and re-run.`,
    );
  }
  // Parse and validate before writing anything, so a settings file we refuse
  // does not leave a freshly copied hook behind.
  const settings = readSettings(settingsPath);
  const hooks = readHooks(settings, settingsPath);
  // A script already there was put there by an install that also wrote the
  // settings entries running it, so it stays whatever happens below; one we
  // copy in now is only ever reachable through the settings we are about to
  // write, and has to go with them if that write fails.
  const hookExisted = existsSync(hookPath);
  mkdirSync(dirname(hookPath), { recursive: true });
  copyFileSync(source, hookPath);

  // Absolute node + absolute hook path: no PATH assumptions, no cwd assumptions.
  const command = `"${process.execPath}" "${hookPath}"`;
  hooks.SessionStart = [
    ...withoutOurHook(hooks.SessionStart ?? [], hookPath),
    { hooks: [{ type: "command", command }] },
  ];
  hooks.PreToolUse = [
    ...withoutOurHook(hooks.PreToolUse ?? [], hookPath),
    { matcher: PRE_TOOL_MATCHER, hooks: [{ type: "command", command }] },
  ];
  settings.hooks = hooks;
  try {
    writeSettings(settingsPath, settings);
  } catch (err) {
    if (!hookExisted) rmSync(hookPath, { force: true });
    throw err;
  }

  console.log(`${bold("code-context")} enforcement installed for ${bold("Claude Code")}`);
  console.log(`  wrote      ${settingsPath}`);
  console.log(`  hook       ${hookPath}`);
  console.log(`  node       ${process.execPath}`);
  console.log("");
  console.log("Once a repo's index fully covers it (vectors ready, nothing over the file cap),");
  console.log("the Grep tool and standalone grep/rg are denied with a redirect to the sql tool.");
  console.log(dim("  grep as a pipe filter on other output always passes"));
  console.log(dim("  a target the index cannot cover (gitignored, oversized, outside the repo) passes"));
  console.log(dim("  CX_GREP_FALLBACK=1 <cmd> asks instead of denying; CX_NO_ENFORCE=1 disables"));
  console.log(dim("  Claude Code only - Cursor, Windsurf and other MCP clients have no hook surface"));
  console.log("");
  console.log(yellow("start a new Claude Code session to load the hooks"));
  console.log(dim("  reverse with: cx install --uninstall"));
}
