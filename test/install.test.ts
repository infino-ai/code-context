// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` edits a settings file the user shares with every other hook
// they own, so most of what matters here is what it must NOT do: stack a
// second copy of itself on reinstall, drop a foreign hook (including one that
// merely shares an entry with ours), lose an unrelated top-level key, truncate
// the file if it dies mid-write, or write machine-specific paths into a
// project's shareable settings file. --uninstall has the mirror obligations,
// plus leaving no empty "hooks" husk when ours were the only entries, and
// leaving the hook script in place while a sibling settings file still runs it.
//
// The load-bearing assertion is the hook command. It has to carry the
// absolute `process.execPath` and the absolute hook path: a bare "node"
// resolves against the client's PATH, and a client launched from a GUI often
// has none - the hook then fails silently, which is indistinguishable from
// enforcement that simply does not work. An unresolvable home directory is
// the same failure by another route, so it has to be an error.
//
// Every case points HOME and --settings at a temp directory, so the real
// ~/.claude is never touched.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallError, installCmd } from "../src/commands/install-cmd.js";

/** Where install puts the hook, relative to the settings file's directory. */
const HOOK_REL_PATH = join("hooks", "cx-deny-grep.mjs");

/** The packaged hook install copies from - the source of truth for content. */
const PACKAGED_HOOK = new URL("../hooks/deny-grep.mjs", import.meta.url);

/** The PreToolUse matcher the entry must carry (mirrors hooks/hooks.json):
 * the built-in search tools plus the legacy code-context `search` tool. */
const PRE_TOOL_MATCHER = "Grep|Bash|mcp__.*code[-_]context.*__search";

/** `"<node>" "<hook>"` - both halves absolute, quoted, nothing else. */
const COMMAND_SHAPE = /^"([^"]+)" "([^"]+)"$/;

interface HookCommand {
  type: string;
  command: string;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

/** Hooks that belong to somebody else: one on an event we never touch, one
 * sharing SessionStart with ours. Both must survive install and uninstall. */
const FOREIGN_POST_TOOL: HookEntry = {
  matcher: "Write|Edit",
  hooks: [{ type: "command", command: "node /home/someone/.claude/hooks/prettier.mjs" }],
};
const FOREIGN_SESSION_START: HookEntry = {
  hooks: [{ type: "command", command: "/usr/local/bin/greet-me" }],
};

/** A hook of the user's that sits inside the same entry as ours - the entry is
 * shared, so ownership has to be decided per hook and not per entry. */
const AUDIT_HOOK: HookCommand = {
  type: "command",
  command: "node /home/someone/.claude/hooks/audit-log.mjs",
};

/** Name the dotfile-managed copy of the settings carries. Deliberately not
 * `settings.json`: the temp file and the rename have to follow the link to
 * wherever it points, not reuse the name of the link. */
const TRACKED_SETTINGS = "claude-settings.json";

/** Modes for the settings directory: one the user cannot write - enough to
 * fail the settings replace after the hook has already been copied in - and
 * the one it is restored to so the sandbox can be removed. */
const READ_ONLY_DIR = 0o500;
const WRITABLE_DIR = 0o700;

/** A wrapper of the user's that merely names our script on its command line.
 * Matching on the basename would delete it; matching on the resolved path we
 * wrote does not. */
const WRAPPER_HOOK: HookEntry = {
  hooks: [
    { type: "command", command: "node /home/someone/my-wrapper.mjs --hook cx-deny-grep.mjs" },
  ],
};

describe("cx install", () => {
  let dir: string;
  let settingsPath: string;
  let hookPath: string;
  let realHome: string | undefined;

  const read = (path = settingsPath): Settings =>
    JSON.parse(readFileSync(path, "utf8")) as Settings;
  const seed = (settings: Settings): void => seedText(JSON.stringify(settings, null, 2) + "\n");
  const seedText = (text: string): void => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, text);
  };
  /** `settings.json` as a symlink into a version-controlled directory - the
   * shape every dotfile manager (stow, chezmoi, a hand-rolled Makefile)
   * leaves behind. Returns the link target, which is the file that has to
   * receive the merged settings. */
  const seedSymlinked = (settings: Settings): string => {
    const tracked = join(dir, "dotfiles", TRACKED_SETTINGS);
    mkdirSync(dirname(tracked), { recursive: true });
    writeFileSync(tracked, JSON.stringify(settings, null, 2) + "\n");
    mkdirSync(dirname(settingsPath), { recursive: true });
    symlinkSync(tracked, settingsPath);
    return tracked;
  };
  /** Run `body` with the settings directory read-only, so the settings replace
   * fails where a real EACCES would: after the hook script is on disk. */
  const withUnwritableDir = (body: () => void): void => {
    chmodSync(dirname(settingsPath), READ_ONLY_DIR);
    try {
      body();
    } finally {
      chmodSync(dirname(settingsPath), WRITABLE_DIR);
    }
  };
  /** The hook command install writes, as a pre-existing entry would hold it. */
  const ourHook = (): HookCommand => ({
    type: "command",
    command: `"${process.execPath}" "${hookPath}"`,
  });
  const runsOurs = (entry: HookEntry): boolean =>
    entry.hooks.some((hook) => hook.command.endsWith(`"${hookPath}"`));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cx-install-"));
    // Point HOME at the sandbox: install refuses a .claude directory that is
    // not the user's own, and every case here targets <sandbox>/.claude.
    realHome = process.env.HOME;
    process.env.HOME = dir;
    settingsPath = join(dir, ".claude", "settings.json");
    hookPath = join(dir, ".claude", HOOK_REL_PATH);
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("install", () => {
    it("creates the settings file with both events and the packaged hook", () => {
      expect(existsSync(settingsPath)).toBe(false);
      installCmd({ settings: settingsPath });

      const settings = read();
      expect(settings.hooks?.SessionStart).toHaveLength(1);
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
      expect(settings.hooks?.PreToolUse?.[0].matcher).toBe(PRE_TOOL_MATCHER);
      expect(settings.hooks?.SessionStart?.[0].matcher).toBeUndefined();

      // The hook lands beside the settings file and is a byte copy of the
      // packaged one - a stale or rewritten copy would enforce old rules.
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(hookPath)).toEqual(readFileSync(PACKAGED_HOOK));
    });

    it("embeds the absolute node binary and the absolute hook path", () => {
      installCmd({ settings: settingsPath });

      const settings = read();
      const commands = [
        settings.hooks?.SessionStart?.[0].hooks[0],
        settings.hooks?.PreToolUse?.[0].hooks[0],
      ];
      for (const hook of commands) {
        expect(hook?.type).toBe("command");
        const parts = COMMAND_SHAPE.exec(hook?.command ?? "");
        expect(parts).not.toBeNull();
        const [, node, script] = parts ?? [];
        expect(node).toBe(process.execPath);
        expect(script).toBe(hookPath);
        expect(isAbsolute(node)).toBe(true);
        expect(isAbsolute(script)).toBe(true);
        // A bare interpreter name is the silent-failure mode we guard against.
        expect(hook?.command).not.toMatch(/^"?node"?\s/);
      }
    });

    it("defaults to the settings file in the home directory", () => {
      installCmd({});

      expect(existsSync(settingsPath)).toBe(true);
      expect(read().hooks?.PreToolUse).toHaveLength(1);
      expect(existsSync(hookPath)).toBe(true);
    });

    it("installs twice without stacking duplicate entries", () => {
      installCmd({ settings: settingsPath });
      installCmd({ settings: settingsPath });

      const settings = read();
      expect(settings.hooks?.SessionStart).toHaveLength(1);
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
    });

    it("keeps foreign hooks, on our events and on events we never touch", () => {
      seed({ hooks: { PostToolUse: [FOREIGN_POST_TOOL], SessionStart: [FOREIGN_SESSION_START] } });
      installCmd({ settings: settingsPath });

      const settings = read();
      expect(settings.hooks?.PostToolUse).toEqual([FOREIGN_POST_TOOL]);
      expect(settings.hooks?.SessionStart).toContainEqual(FOREIGN_SESSION_START);
      expect(settings.hooks?.SessionStart).toHaveLength(2);
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
    });

    it("keeps a foreign hook that shares an entry with ours", () => {
      // The user added their audit hook next to ours, in one entry with their
      // own matcher. Reinstalling replaces our hook, not their entry.
      seed({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [AUDIT_HOOK, ourHook()] }] } });
      installCmd({ settings: settingsPath });

      const entries = read().hooks?.PreToolUse ?? [];
      expect(entries).toHaveLength(2);
      const shared = entries.find((entry) => entry.matcher === "Bash");
      expect(shared?.hooks).toEqual([AUDIT_HOOK]);
      const ours = entries.filter(runsOurs);
      expect(ours).toHaveLength(1);
      expect(ours[0].matcher).toBe(PRE_TOOL_MATCHER);
    });

    it("leaves a wrapper of the user's that merely names our script", () => {
      seed({ hooks: { SessionStart: [WRAPPER_HOOK] } });
      installCmd({ settings: settingsPath });
      expect(read().hooks?.SessionStart).toContainEqual(WRAPPER_HOOK);

      installCmd({ uninstall: true, settings: settingsPath });
      expect(read().hooks?.SessionStart).toEqual([WRAPPER_HOOK]);
    });

    it("leaves unrelated top-level settings keys untouched", () => {
      const permissions = { allow: ["Bash(git status)"], deny: [] };
      const env = { CX_MAX_FILE_BYTES: "2097152" };
      seed({ permissions, env, model: "opus" });
      installCmd({ settings: settingsPath });

      const settings = read();
      expect(settings.permissions).toEqual(permissions);
      expect(settings.env).toEqual(env);
      expect(settings.model).toBe("opus");
    });

    it("replaces the settings file atomically and leaves no temp file", () => {
      seed({ model: "opus" });
      const before = statSync(settingsPath).ino;
      installCmd({ settings: settingsPath });

      // A rename swaps the inode; an in-place truncate-then-write keeps it and
      // is exactly the window where a crash costs the user every setting.
      expect(statSync(settingsPath).ino).not.toBe(before);
      expect(readdirSync(dirname(settingsPath)).sort()).toEqual(["hooks", "settings.json"]);

      installCmd({ uninstall: true, settings: settingsPath });
      expect(readdirSync(dirname(settingsPath)).sort()).toEqual(["hooks", "settings.json"]);
    });

    it("writes through a symlinked settings file and leaves the link a link", () => {
      const tracked = seedSymlinked({ model: "opus" });
      installCmd({ settings: settingsPath });

      // Renaming onto the link replaces it with a regular file: the tracked
      // copy keeps the old bytes and the user's settings silently stop
      // applying, which is the same as losing them.
      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      const settings = read(tracked);
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
      expect(settings.model).toBe("opus");
      // The temp file belongs beside the real target, and must not survive it.
      expect(readdirSync(dirname(tracked))).toEqual([TRACKED_SETTINGS]);
      expect(readdirSync(dirname(settingsPath)).sort()).toEqual(["hooks", "settings.json"]);
    });

    it("creates the target of a settings symlink that does not point at a file yet", () => {
      // The link is in place but the dotfiles repo is not checked out; writing
      // a regular file at the link's own path would break the setup the moment
      // it is.
      const tracked = join(dir, "dotfiles", TRACKED_SETTINGS);
      mkdirSync(dirname(settingsPath), { recursive: true });
      symlinkSync(tracked, settingsPath);
      installCmd({ settings: settingsPath });

      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(read(tracked).hooks?.PreToolUse).toHaveLength(1);
      expect(readdirSync(dirname(tracked))).toEqual([TRACKED_SETTINGS]);
    });

    it("removes the hook it just copied when the settings write fails", () => {
      seed({ model: "opus" });
      mkdirSync(dirname(hookPath), { recursive: true });
      withUnwritableDir(() => {
        expect(() => installCmd({ settings: settingsPath })).toThrow();
      });

      // The script is copied before the settings that reference it, so an
      // aborted write leaves a file nothing runs.
      expect(existsSync(hookPath)).toBe(false);
      expect(read()).toEqual({ model: "opus" });
    });

    it("keeps a hook script from an earlier install when the write fails", () => {
      installCmd({ settings: settingsPath });
      const copied = readFileSync(hookPath);
      withUnwritableDir(() => {
        expect(() => installCmd({ settings: settingsPath })).toThrow();
      });

      // This one is still wired up by the settings written before; deleting it
      // would break every tool call in the next session.
      expect(readFileSync(hookPath)).toEqual(copied);
      expect(readFileSync(settingsPath, "utf8")).toContain(hookPath);
    });

    it("reports Claude Code and the settings file it wrote", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      installCmd({ settings: settingsPath });

      const out = log.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(out).toContain("Claude Code");
      expect(out).toContain(settingsPath);
      expect(out).toContain(hookPath);
    });
  });

  describe("target resolution", () => {
    it("refuses to install when the home directory is not absolute", () => {
      // os.homedir() answers "" under `env -i` and some CI runners; joining
      // that writes .claude into the current working directory instead.
      const cwdClaude = join(process.cwd(), ".claude");
      const existed = existsSync(cwdClaude);

      process.env.HOME = "";
      expect(() => installCmd({})).toThrow(InstallError);
      expect(() => installCmd({})).toThrow(/home directory/i);
      process.env.HOME = "relative/home";
      expect(() => installCmd({})).toThrow(/home directory/i);

      expect(existsSync(cwdClaude)).toBe(existed);
    });

    it("refuses a project-scoped .claude settings file", () => {
      const project = join(dir, "repo", ".claude", "settings.json");

      expect(() => installCmd({ settings: project })).toThrow(InstallError);
      expect(() => installCmd({ settings: project })).toThrow(/project-scoped/);
      // Nothing written, not even the directory: the shareable file would
      // carry this machine's node path and a hook copy inside the repo.
      expect(existsSync(dirname(project))).toBe(false);
    });

    it("accepts the home settings file reached through a symlinked HOME", () => {
      // A relocated or symlinked home (/home/you -> /mnt/home/you, macOS
      // /tmp -> /private/tmp) still names the user's own .claude directory,
      // so scope has to be decided on resolved paths, not on the spelling.
      const home = join(dir, "home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      const linked = join(dir, "home-link");
      symlinkSync(home, linked);
      process.env.HOME = linked;
      const target = join(home, ".claude", "settings.json");

      expect(() => installCmd({ settings: target })).not.toThrow();
      expect(read(target).hooks?.PreToolUse).toHaveLength(1);
    });

    it("installs into a project-scoped file under --force, and uninstalls without it", () => {
      const project = join(dir, "repo", ".claude", "settings.json");
      installCmd({ settings: project, force: true });
      expect(read(project).hooks?.PreToolUse).toHaveLength(1);

      // Undoing a --force install must not need --force, or it would be a
      // one-way door.
      installCmd({ uninstall: true, settings: project });
      expect(readFileSync(project, "utf8")).not.toContain("cx-deny-grep");
      expect(existsSync(join(dirname(project), HOOK_REL_PATH))).toBe(false);
    });
  });

  describe("unreadable settings", () => {
    /** A settings file we refuse must come back byte-identical, and no hook
     * may be copied in on the way. */
    const expectRefusal = (text: string, message: RegExp): void => {
      seedText(text);
      expect(() => installCmd({ settings: settingsPath })).toThrow(message);
      expect(() => installCmd({ uninstall: true, settings: settingsPath })).toThrow(message);
      expect(readFileSync(settingsPath, "utf8")).toBe(text);
      expect(existsSync(hookPath)).toBe(false);
    };

    it("refuses a settings file that is not valid JSON", () => {
      expectRefusal('{\n  // JSONC is not JSON\n  "hooks": {}\n}\n', /not valid JSON/);
    });

    it("refuses a settings file that does not hold an object", () => {
      expectRefusal("null\n", /holds null, not a JSON object/);
    });

    it("refuses a hooks block that is not an object of events", () => {
      expectRefusal('{\n  "hooks": []\n}\n', /"hooks".*is an array/);
    });

    it("refuses an event whose entries are not an array", () => {
      expectRefusal('{\n  "hooks": {\n    "PreToolUse": "Grep"\n  }\n}\n', /PreToolUse.*a string/);
    });
  });

  describe("uninstall", () => {
    it("removes our entries and the copied hook file", () => {
      installCmd({ settings: settingsPath });
      installCmd({ uninstall: true, settings: settingsPath });

      expect(existsSync(hookPath)).toBe(false);
      expect(readFileSync(settingsPath, "utf8")).not.toContain("cx-deny-grep");
    });

    it("leaves no empty hooks husk when ours were the only entries", () => {
      installCmd({ settings: settingsPath });
      installCmd({ uninstall: true, settings: settingsPath });

      expect(read().hooks).toBeUndefined();
    });

    it("keeps the hooks block and its foreign entries when others remain", () => {
      seed({ hooks: { PostToolUse: [FOREIGN_POST_TOOL], SessionStart: [FOREIGN_SESSION_START] } });
      installCmd({ settings: settingsPath });
      installCmd({ uninstall: true, settings: settingsPath });

      const settings = read();
      expect(settings.hooks?.PostToolUse).toEqual([FOREIGN_POST_TOOL]);
      expect(settings.hooks?.SessionStart).toEqual([FOREIGN_SESSION_START]);
      expect(settings.hooks?.PreToolUse).toBeUndefined();
    });

    it("keeps the other hooks of an entry it shares with us", () => {
      seed({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [AUDIT_HOOK, ourHook()] }] } });
      installCmd({ uninstall: true, settings: settingsPath });

      const entries = read().hooks?.PreToolUse ?? [];
      expect(entries).toEqual([{ matcher: "Bash", hooks: [AUDIT_HOOK] }]);
    });

    it("keeps the hook file while a sibling settings file still runs it", () => {
      // settings.json and settings.local.json share one hooks/ directory, so
      // the script is shared too: deleting it out from under the survivor
      // turns every tool call into MODULE_NOT_FOUND.
      const localPath = join(dir, ".claude", "settings.local.json");
      installCmd({ settings: settingsPath });
      installCmd({ settings: localPath });

      installCmd({ uninstall: true, settings: settingsPath });
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(localPath, "utf8")).toContain(hookPath);

      installCmd({ uninstall: true, settings: localPath });
      expect(existsSync(hookPath)).toBe(false);
    });

    it("keeps the hook file while a custom-named settings file still runs it", () => {
      // --settings takes any path, so the survivor need not be named
      // settings.local.json for its hook command to be live.
      const custom = join(dirname(settingsPath), "my-settings.json");
      installCmd({ settings: settingsPath });
      installCmd({ settings: custom });

      installCmd({ uninstall: true, settings: settingsPath });
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(custom, "utf8")).toContain(hookPath);

      installCmd({ uninstall: true, settings: custom });
      expect(existsSync(hookPath)).toBe(false);
    });

    it("writes through a symlinked settings file and leaves the link a link", () => {
      const tracked = seedSymlinked({ model: "opus" });
      installCmd({ settings: settingsPath });
      installCmd({ uninstall: true, settings: settingsPath });

      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      const settings = read(tracked);
      expect(settings.hooks).toBeUndefined();
      expect(settings.model).toBe("opus");
      expect(existsSync(hookPath)).toBe(false);
      expect(readdirSync(dirname(tracked))).toEqual([TRACKED_SETTINGS]);
    });

    it("is a no-op on a settings file that was never installed into", () => {
      const before: Settings = {
        permissions: { allow: ["Read(**)"] },
        hooks: { PostToolUse: [FOREIGN_POST_TOOL] },
      };
      seed(before);
      expect(() => installCmd({ uninstall: true, settings: settingsPath })).not.toThrow();

      expect(read()).toEqual(before);
    });

    it("is a no-op when the settings file does not exist", () => {
      installCmd({ uninstall: true, settings: settingsPath });

      // A removal that conjures a settings file (and a .claude directory) to
      // prove it holds no hooks has made the user's machine messier, not
      // cleaner.
      expect(existsSync(settingsPath)).toBe(false);
      expect(existsSync(dirname(settingsPath))).toBe(false);
      expect(existsSync(hookPath)).toBe(false);
    });
  });
});

/** The repo root plus the two ends of `cx --version`: the manifest that owns
 * the version, and the built entry point that has to report it. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const CLI_BUILT = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/** tsc on this project takes a couple of seconds; leave the build room. */
const BUILD_TIMEOUT_MS = 120_000;

describe("cx --version", () => {
  it(
    "reports the version from package.json",
    () => {
      buildCli();
      expect(existsSync(CLI_BUILT)).toBe(true);
      const { version } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
      const printed = execFileSync(process.execPath, [CLI_BUILT, "--version"], {
        encoding: "utf8",
      });

      // A literal in cli.ts drifted from the published version once already;
      // reading package.json at runtime is what keeps the two in lockstep.
      expect(printed.trim()).toBe(version);
    },
    BUILD_TIMEOUT_MS,
  );
});

/** `--version` is only observable from the built CLI, so compile it here
 * rather than trust whatever is in dist/ - a build left over from other work
 * can be newer than the source and still print the wrong thing. A failing
 * compile is not this case's business (`tsc --noEmit` is the gate for that)
 * and tsc emits anyway, so the assertions decide. */
function buildCli(): void {
  try {
    execFileSync(process.execPath, [TSC], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    /* fall through: the version assertion reports whatever landed in dist/ */
  }
}
