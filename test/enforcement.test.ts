// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The enforcement hook is the one place where being wrong costs the agent a
// capability: a deny it should not have issued leaves the target reachable by
// neither grep nor sql. So the cases below are mostly about what must stay
// ALLOWED - every file class the indexer skips (lockfiles, `.csv`, `LICENSE`,
// `vendor/`, symlinks, anything not yet synced), every file it fingerprinted
// without chunking a row out of, and every index state short of fully live.
//
// The other half is parsing: the hook reads a Bash command as shell, so a
// pipeline (`| head`), a trailing comment, a heredoc body, a wrapper
// (`timeout 5`, `command`, `xargs -a`), an absolute launcher path and git's
// global flags all have to land on the same decision the bare command would.
//
// The hook is driven the way the client drives it: a fresh node process with
// the payload on stdin, reading a real index directory. Silence on stdout is
// "allow" - the hook only speaks to deny or ask.
//
// Fixture indexes are hand-written (manifest + filestate + an empty table
// directory) rather than produced by the indexer: what the hook reads is those
// two files, and building them by hand keeps the suite in milliseconds. The
// real-indexer block at the bottom pins the agreement those fixtures assume.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect } from "@infino-ai/infino";
import { indexRepo, syncRepo } from "../src/core/indexer.js";
import { readFileState } from "../src/core/filestate.js";
import { readManifest } from "../src/core/manifest.js";
import type { Embedder } from "../src/core/embedder.js";

/** The hook as published (and as `cx install` copies it). */
const HOOK = new URL("../hooks/deny-grep.mjs", import.meta.url).pathname;

/** Files the fixture records in filestate - the index's own account of what it
 * holds. `.pre-commit-config.yaml` is there on purpose: real indexes do carry
 * dotfiles, which the old dot-path rule wrongly waved through. */
const INDEXED = ["src/a.rs", "src/auth.rs", "README.md", ".pre-commit-config.yaml"];

/** A filestate key as `writeIndex` writes it. A bare path records rows
 * (`chunks: DEFAULT_FIXTURE_CHUNKS`); a tuple pins the count - `0` for a file
 * the indexer fingerprinted but chunked nothing out of, `undefined` for state
 * written before the field existed. */
type FileFixture = string | [path: string, chunks: number | undefined];

/** Rows a fixture file records unless the case pins its own count. */
const DEFAULT_FIXTURE_CHUNKS = 3;

/** A Python package the indexer fingerprints whole but can chunk only one file
 * of: the empty `__init__.py` and the NUL-carrying module yield no rows. */
const PKG_EMPTY_INIT = "pkg/__init__.py";
const PKG_BINARY = "pkg/blob.py";
const PKG_SOURCE = "pkg/thing.py";

/** A package whose every file is chunk-less, i.e. a directory the table holds
 * nothing at all for. */
const HOLLOW_INIT = "hollow/__init__.py";

/** Files that exist in the tree but not in the index: the classes the indexer
 * skips, plus one (`notes.txt`) that simply has not been synced yet. */
const UNINDEXED = ["package-lock.json", "data.csv", "LICENSE", "vendor/lib.js", "notes.txt"];

/** A fully live index: vectors ready, nothing truncated. */
const READY_MANIFEST = {
  version: 2,
  table: "chunks",
  vectors: "ready",
  files: INDEXED.length,
  chunks: 9,
  languages: { rust: 6, markdown: 3 },
  indexedAt: "2026-01-01T00:00:00.000Z",
  indexMs: 12,
};

/** Stand-in for the engine's table directory next to the manifest. */
const TABLE_DIR = "chunks-0123456789ab-0";

/** The developer's own shell must not decide a case, so the CX knobs the hook
 * reads are cleared and set per invocation. */
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env };
delete BASE_ENV.CX_NO_ENFORCE;
delete BASE_ENV.CX_INDEX_DIR;
delete BASE_ENV.CX_MAX_FILE_BYTES;

interface IndexShape {
  /** Manifest fields layered over READY_MANIFEST. */
  manifest?: Record<string, unknown>;
  /** filestate keys; null writes no filestate at all. */
  files?: FileFixture[] | null;
  /** false leaves the manifest orphaned (no table on disk). */
  table?: boolean;
}

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A tree carrying every file class, with a symlinked directory (the walker
 * never descends into one, so nothing under it is ever indexed). */
function buildTree(): string {
  const repo = tempDir("cx-enforce-repo-");
  for (const rel of [...INDEXED, ...UNINDEXED]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), "let auth = 1;\n");
  }
  const outside = tempDir("cx-enforce-outside-");
  writeFileSync(join(outside, "x.rs"), "let auth = 2;\n");
  symlinkSync(outside, join(repo, "shared"), "dir");
  return repo;
}

function writeIndex(indexDir: string, shape: IndexShape = {}): void {
  const { manifest = {}, files = INDEXED, table = true } = shape;
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "codecontext.json"), JSON.stringify({ ...READY_MANIFEST, ...manifest }));
  if (files) {
    const entries = files.map((f) => {
      const [path, chunks] = typeof f === "string" ? [f, DEFAULT_FIXTURE_CHUNKS] : f;
      return [path, { size: 14, mtimeMs: 1, hash: "abc", ...(chunks === undefined ? {} : { chunks }) }];
    });
    writeFileSync(join(indexDir, "filestate.json"), JSON.stringify({ version: 1, files: Object.fromEntries(entries) }));
  }
  if (table) mkdirSync(join(indexDir, TABLE_DIR), { recursive: true });
}

interface HookResult {
  decision: "allow" | "deny" | "ask";
  context?: string;
}

/** One hook run. Empty stdout means the hook said nothing, which the client
 * reads as allow. */
function hook(payload: unknown, env: NodeJS.ProcessEnv = {}): HookResult {
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...BASE_ENV, ...env },
  });
  if (run.status !== 0) throw new Error(`hook exited ${run.status}: ${run.stderr}`);
  const out = run.stdout.trim();
  if (out === "") return { decision: "allow" };
  const emitted = JSON.parse(out).hookSpecificOutput as {
    permissionDecision?: HookResult["decision"];
    additionalContext?: string;
  };
  return { decision: emitted.permissionDecision ?? "allow", context: emitted.additionalContext };
}

describe("grep enforcement", () => {
  let repo: string;
  let indexDir: string;

  beforeEach(() => {
    repo = buildTree();
    indexDir = join(repo, ".infino");
    writeIndex(indexDir, { manifest: { root: repo } });
  });

  afterEach(() => {
    while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
  });

  const bash = (command: string, env: NodeJS.ProcessEnv = {}): string =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: repo, tool_input: { command } }, env).decision;

  const grepTool = (toolInput: Record<string, string>, env: NodeJS.ProcessEnv = {}): string =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Grep", cwd: repo, tool_input: toolInput }, env).decision;

  describe("coverage comes from the index, not from re-derived skip rules", () => {
    it("allows a lockfile the chunker never indexes", () => {
      expect(bash("grep -n commander package-lock.json")).toBe("allow");
    });

    it("allows an extension outside the language allowlist", () => {
      expect(bash("grep -n 1 data.csv")).toBe("allow");
    });

    it("allows an extensionless file that is not a known basename", () => {
      expect(bash("grep -n Apache LICENSE")).toBe("allow");
    });

    it("allows a skipped directory even though it is not gitignored", () => {
      expect(bash("grep -rn Foo vendor/")).toBe("allow");
    });

    it("allows a symlinked directory the walker never descends into", () => {
      expect(bash("grep -rn x shared/")).toBe("allow");
    });

    it("allows a file that is on disk but absent from filestate", () => {
      expect(bash("grep -n auth notes.txt")).toBe("allow");
    });

    it("allows when any one of several targets is uncovered", () => {
      expect(bash("grep -n auth src/a.rs data.csv")).toBe("allow");
    });

    it("denies an indexed source file", () => {
      expect(bash("grep -n auth src/a.rs")).toBe("deny");
    });

    it("denies an indexed dotfile", () => {
      expect(bash("grep -n repos .pre-commit-config.yaml")).toBe("deny");
    });

    it("denies an indexed directory, by relative and absolute path alike", () => {
      expect(bash("grep -rn auth src")).toBe("deny");
      expect(bash(`grep -rn auth ${join(repo, "src")}`)).toBe("deny");
    });

    it("allows a path outside the repo", () => {
      expect(bash("grep -n auth /etc/hosts")).toBe("allow");
    });
  });

  // filestate fingerprints every readable candidate, including files it then
  // chunks nothing out of - so its key set is a superset of the table's paths,
  // and only the recorded row count separates the two.
  describe("a fingerprinted file with no chunk rows is not covered", () => {
    beforeEach(() => {
      for (const rel of [PKG_EMPTY_INIT, PKG_BINARY, PKG_SOURCE, HOLLOW_INIT]) {
        mkdirSync(dirname(join(repo, rel)), { recursive: true });
        writeFileSync(join(repo, rel), rel === PKG_SOURCE ? "def thing():\n    return 1\n" : "");
      }
      writeIndex(indexDir, {
        manifest: { root: repo },
        files: [
          ...INDEXED,
          [PKG_EMPTY_INIT, 0],
          [PKG_BINARY, 0],
          [PKG_SOURCE, 4],
          [HOLLOW_INIT, 0],
        ],
      });
    });

    it("allows an empty __init__.py and a NUL-carrying module, denies their real sibling", () => {
      expect(bash(`rg -n main ${PKG_EMPTY_INIT}`)).toBe("allow");
      expect(bash(`rg -n main ${PKG_BINARY}`)).toBe("allow");
      expect(bash(`rg -n main ${PKG_SOURCE}`)).toBe("deny");
    });

    it("covers a package directory only through the file that produced rows", () => {
      expect(bash("rg -n main pkg/")).toBe("deny");
      expect(bash("rg -n main pkg")).toBe("deny");
      // Every key under this one is chunk-less: sql has nothing to answer with.
      expect(bash("rg -n main hollow/")).toBe("allow");
      expect(bash("rg -n main hollow")).toBe("allow");
    });

    it("applies the same rule to globs", () => {
      expect(grepTool({ pattern: "main", glob: "*.py" })).toBe("deny");
      expect(grepTool({ pattern: "main", glob: "pkg/thing.py" })).toBe("deny");
      expect(grepTool({ pattern: "main", glob: "hollow/*.py" })).toBe("allow");
      expect(grepTool({ pattern: "main", glob: "**/__init__.py" })).toBe("allow");
      expect(grepTool({ pattern: "main", path: HOLLOW_INIT })).toBe("allow");
    });

    it("covers a count-less entry only in a mixed (mid-upgrade) state", () => {
      // A wholly pre-upgrade state fails open (see the round-2 case below);
      // once any entry carries a count, the unstamped rest keeps the
      // back-compatible covered reading until the next sync stamps it.
      writeIndex(indexDir, { manifest: { root: repo }, files: [["src/a.rs", undefined], "README.md"] });
      expect(bash("grep -n auth src/a.rs")).toBe("deny");
    });

    it("fails open when nothing in the state produced a row", () => {
      writeIndex(indexDir, { manifest: { root: repo }, files: [["src/a.rs", 0], ["README.md", 0]] });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
      expect(bash("rg foo")).toBe("allow");
    });
  });

  describe("command shapes", () => {
    it("denies a repo-wide search with no explicit target", () => {
      expect(bash("rg foo")).toBe("deny");
    });

    it("denies a grep launched after another command in the same line", () => {
      expect(bash("cd src && rg -n auth")).toBe("deny");
      expect(bash("cd src ; rg -n auth")).toBe("deny");
      expect(bash("test -d src || rg -n auth")).toBe("deny");
    });

    it("denies a multi-word quoted pattern over an indexed directory", () => {
      expect(bash('grep -rn "let auth" src/')).toBe("deny");
      expect(bash("grep -rn 'let auth' src/")).toBe("deny");
    });

    it("denies through env-assignment and env/sudo/time/nice wrappers", () => {
      expect(bash("env FOO=1 grep -n x src/a.rs")).toBe("deny");
      expect(bash("sudo grep -n x src/a.rs")).toBe("deny");
      expect(bash("time grep -n x src/a.rs")).toBe("deny");
      expect(bash("FOO=1 grep -n x src/a.rs")).toBe("deny");
    });

    it("denies git grep", () => {
      expect(bash("git grep -n auth src/a.rs")).toBe("deny");
    });

    it("allows grep as a pipe filter, never splitting on |", () => {
      expect(bash("cargo test 2>&1 | grep FAILED")).toBe("allow");
      expect(bash("ls | grep foo")).toBe("allow");
      expect(bash("rg --version | grep ripgrep")).toBe("allow");
    });

    it("allows a pattern-less invocation", () => {
      expect(bash("grep --version")).toBe("allow");
    });

    it("reads a redirection as a destination, not as a target", () => {
      expect(bash("rg foo > hits.txt")).toBe("deny");
      expect(bash("rg foo >hits.txt")).toBe("deny");
      expect(bash("grep -rn auth src/ 2>&1")).toBe("deny");
      expect(bash("grep -n 1 data.csv > hits.txt")).toBe("allow");
      // An input redirection searches a stream the index cannot speak for.
      expect(bash("grep -n auth < notes.txt")).toBe("allow");
    });

    it("treats a quoted token as pattern text, not as shell syntax", () => {
      // Reading the `>` as a redirection would drop the pattern and make the
      // unindexed file look like a repo-wide search.
      expect(bash('grep -n "> TODO" notes.txt')).toBe("allow");
      expect(bash('grep -n "> TODO" src/a.rs')).toBe("deny");
      expect(bash('grep -n -- "-n" src/a.rs')).toBe("deny");
    });

    it("asks when the fallback marker prefixes the grep", () => {
      expect(bash("CX_GREP_FALLBACK=1 grep -n auth src/a.rs")).toBe("ask");
      expect(bash("cd src && CX_GREP_FALLBACK=1 rg -n auth")).toBe("ask");
    });
  });

  // A search's own operands end at the pipeline: the words of `| head -5` are
  // another command's, and reading them as targets nothing covers turned the
  // most common grep idiom there is into an allow.
  describe("a search whose output is piped onward", () => {
    it("denies the search regardless of the filter behind the pipe", () => {
      expect(bash("rg -n auth src | head -5")).toBe("deny");
      expect(bash("rg -n auth src/a.rs | head")).toBe("deny");
      expect(bash("rg -n auth | head -20")).toBe("deny");
      expect(bash("rg -n auth src | wc -l")).toBe("deny");
      expect(bash("grep -rn auth src | sort")).toBe("deny");
      expect(bash("rg -n auth src|head")).toBe("deny");
      expect(bash("rg --files-with-matches auth src | xargs cat")).toBe("deny");
    });

    it("denies a search with a trailing comment", () => {
      expect(bash("rg -n auth src # note")).toBe("deny");
      expect(bash("rg -n auth src #note")).toBe("deny");
    });

    it("still allows a grep that filters another command's output", () => {
      expect(bash("cargo test | grep FAILED")).toBe("allow");
      expect(bash("cargo test 2>&1 | grep -i error")).toBe("allow");
      expect(bash("ps aux | grep node")).toBe("allow");
      expect(bash("env | grep PATH")).toBe("allow");
      expect(bash("git log --oneline | grep fix")).toBe("allow");
      expect(bash("cat /etc/hosts | grep -v '#' | grep local")).toBe("allow");
      expect(bash("rg --version | grep ripgrep")).toBe("allow");
    });

    it("keeps a quoted pipe inside the pattern literal", () => {
      expect(bash('grep -rn "a|b" src/')).toBe("deny");
      expect(bash("rg -n '#include' src")).toBe("deny");
      expect(bash("grep -rn 'a|b' data.csv")).toBe("allow");
    });

    it("asks when the fallback marker prefixes a piped search", () => {
      expect(bash("CX_GREP_FALLBACK=1 rg -n auth src | head")).toBe("ask");
    });
  });

  // A heredoc body is data: an agent writing a script or a doc that mentions a
  // search must not be told to use sql instead.
  describe("heredoc bodies", () => {
    it("allows a script whose body merely contains a search line", () => {
      expect(bash("cat > run.sh <<'SH'\nrg -n auth src\nSH")).toBe("allow");
      expect(bash("cat > run.sh <<SH\nrg -n auth src\nSH")).toBe("allow");
      expect(bash("cat > run.sh <<-SH\n\trg -n auth src\n\tSH")).toBe("allow");
      expect(bash('cat >> notes.md <<"MD"\ngrep -rn auth src is the old way\nMD')).toBe("allow");
    });

    it("still reads the commands around the body", () => {
      expect(bash("cat <<'EOF' > /dev/null\nx\nEOF\nrg -n auth src")).toBe("deny");
      expect(bash("rg -n auth src\ncat > run.sh <<'SH'\nls\nSH")).toBe("deny");
    });

    it("allows a search line quoted into another command", () => {
      expect(bash("echo 'rg -n auth src'")).toBe("allow");
      expect(bash("git commit -m 'prefer sql over rg -n auth src'")).toBe("allow");
    });
  });

  // Each of these hid the launcher from the scan: a path, a wrapper that takes
  // its own operand, or git's global flags in front of the subcommand.
  describe("launcher shapes", () => {
    it("denies through git's global flags", () => {
      expect(bash("git -C . grep auth")).toBe("deny");
      expect(bash("git --no-pager grep auth")).toBe("deny");
      expect(bash("git -c core.pager=cat grep auth")).toBe("deny");
      expect(bash("git -C src grep auth")).toBe("deny");
    });

    it("allows git grep aimed at another tree", () => {
      expect(bash("git -C /etc grep auth")).toBe("allow");
    });

    it("denies behind timeout, an absolute path, command, and xargs", () => {
      expect(bash("timeout 5 rg -n auth src")).toBe("deny");
      expect(bash("timeout 30s rg -n auth src")).toBe("deny");
      expect(bash("/usr/bin/rg -n auth src")).toBe("deny");
      expect(bash("command grep -rn auth src")).toBe("deny");
      expect(bash("xargs -a /dev/null rg -n auth src")).toBe("deny");
      expect(bash("nice -n 5 rg -n auth src")).toBe("deny");
    });

    it("leaves a launcher lookup alone", () => {
      expect(bash("command -v rg")).toBe("allow");
      expect(bash("which grep")).toBe("allow");
    });
  });

  describe("index state short of fully live", () => {
    it("allows while vectors are still building", () => {
      writeIndex(indexDir, { manifest: { root: repo, vectors: "building" } });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows when the index is partial (files over the cap)", () => {
      writeIndex(indexDir, { manifest: { root: repo, truncatedFiles: 3, maxFiles: 2 } });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows when the manifest is orphaned by a missing table", () => {
      rmSync(join(indexDir, TABLE_DIR), { recursive: true, force: true });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows when filestate is missing", () => {
      rmSync(join(indexDir, "filestate.json"), { force: true });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows when filestate is unparseable or records no files", () => {
      writeFileSync(join(indexDir, "filestate.json"), "{ not json");
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
      writeIndex(indexDir, { manifest: { root: repo }, files: [] });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows when there is no index at all", () => {
      rmSync(indexDir, { recursive: true, force: true });
      expect(bash("grep -n auth src/a.rs")).toBe("allow");
    });

    it("allows on an unparseable payload", () => {
      const run = spawnSync(process.execPath, [HOOK], { input: "{ not json", encoding: "utf8", env: BASE_ENV });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("");
    });
  });

  describe("the CX_NO_ENFORCE kill switch", () => {
    const off = { CX_NO_ENFORCE: "1" };

    it("allows a grep that would otherwise be denied", () => {
      expect(bash("grep -n auth src/a.rs", off)).toBe("allow");
      expect(grepTool({ pattern: "auth", path: "src" }, off)).toBe("allow");
    });

    it("allows the legacy search tool, which used to be denied above it", () => {
      const payload = { hook_event_name: "PreToolUse", tool_name: "mcp__code-context__search", cwd: repo, tool_input: { query: "auth" } };
      expect(hook(payload, off).decision).toBe("allow");
      expect(hook(payload).decision).toBe("deny");
    });

    it("still describes the index at SessionStart", () => {
      const note = hook({ hook_event_name: "SessionStart", cwd: repo }, off).context;
      expect(note).toContain("hybrid_search");
      expect(note).not.toContain("are disabled");
    });
  });

  describe("the Grep tool", () => {
    it("denies an indexed path, and a repo-wide search with no path", () => {
      expect(grepTool({ pattern: "auth", path: "src" })).toBe("deny");
      expect(grepTool({ pattern: "auth" })).toBe("deny");
    });

    it("allows an uncovered path", () => {
      expect(grepTool({ pattern: "Foo", path: "vendor" })).toBe("allow");
      expect(grepTool({ pattern: "1", path: "data.csv" })).toBe("allow");
    });

    it("allows a glob that matches nothing indexed, denies one that matches", () => {
      expect(grepTool({ pattern: "auth", glob: "*.py" })).toBe("allow");
      expect(grepTool({ pattern: "auth", glob: "src/**/*.go" })).toBe("allow");
      expect(grepTool({ pattern: "auth", glob: "*.rs" })).toBe("deny");
      expect(grepTool({ pattern: "auth", glob: "src/*.rs" })).toBe("deny");
    });
  });

  describe("the repo root the manifest records", () => {
    it("enforces on an index kept outside the repo (CX_INDEX_DIR)", () => {
      const external = tempDir("cx-enforce-index-");
      const elsewhere = tempDir("cx-enforce-cwd-");
      rmSync(indexDir, { recursive: true, force: true });
      writeIndex(external, { manifest: { root: repo } });
      const env = { CX_INDEX_DIR: external };
      const payload = (command: string) => ({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: elsewhere,
        tool_input: { command },
      });
      // Without manifest.root the hook would call cwd the root, read the repo
      // as a sibling "outside the repo", and allow both of these.
      expect(hook(payload(`grep -n auth ${join(repo, "src", "a.rs")}`), env).decision).toBe("deny");
      expect(hook(payload(`grep -n auth ${join(repo, "data.csv")}`), env).decision).toBe("allow");
    });

    it("falls back to the walked-up index directory when the manifest has no root", () => {
      writeIndex(indexDir, {});
      expect(bash("grep -n auth src/a.rs")).toBe("deny");
      expect(bash("grep -n 1 data.csv")).toBe("allow");
    });

    it("prefers the walked-up root over a stale one (a copied checkout)", () => {
      // What `cp -a repo repo2` leaves behind: an index found inside repo2
      // whose manifest still names repo. Trusting that root resolves every
      // target "outside the repo" and silently stops enforcing, while sql
      // answers repo2's queries fine.
      const copy = buildTree();
      const copyIndex = join(copy, ".infino");
      writeIndex(copyIndex, { manifest: { root: repo } });
      const at = (command: string) =>
        hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: copy, tool_input: { command } }).decision;
      expect(at("grep -n auth src/a.rs")).toBe("deny");
      expect(at("grep -rn auth src")).toBe("deny");
      expect(at(`grep -n auth ${join(copy, "src", "a.rs")}`)).toBe("deny");
      expect(at("grep -n 1 data.csv")).toBe("allow");
      // The same stale root loses when CX_INDEX_DIR names the copy's own index.
      const env = { CX_INDEX_DIR: copyIndex };
      expect(
        hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: copy, tool_input: { command: "grep -n auth src/a.rs" } }, env)
          .decision,
      ).toBe("deny");
    });
  });

  describe("round-2 hardening (verifier findings N1-N6)", () => {
    it("answers a wildcard-flooded glob promptly instead of backtracking (N1)", () => {
      // 40 stars used to compile to stacked `.*`s and wedge past the hook
      // timeout; the vitest case timeout is the regression tripwire here.
      expect(bash(`rg -n auth ${"*".repeat(40)}.ts`)).toBe("allow");
      expect(grepTool({ pattern: "auth", glob: `${"*".repeat(40)}.rs` })).toBe("deny");
    });

    it("reads a bare operand glob the way the shell does, not against basenames (N2)", () => {
      // The shell expands `*.rs` in the cwd before rg runs; no root-level file
      // matches, so nothing indexed is searched. Basename matching read it as
      // "src/a.rs, somewhere" and denied a search sql could not answer.
      expect(bash("rg -n zzz *.rs")).toBe("allow");
      expect(bash("rg -n zzz src/*.rs")).toBe("deny");
      // The Grep tool's glob IS recursive; basename matching is right there.
      expect(grepTool({ pattern: "zzz", glob: "*.rs" })).toBe("deny");
    });

    it("sees through shell control words and group openers (N3)", () => {
      expect(bash("if rg -q auth src/a.rs; then echo y; fi")).toBe("deny");
      expect(bash("while rg -q auth src/a.rs; do :; done")).toBe("deny");
      expect(bash("for f in 1; do rg -n auth src/a.rs; done")).toBe("deny");
      expect(bash("{ rg -n auth src/a.rs; }")).toBe("deny");
      expect(bash("( rg -n auth src/a.rs )")).toBe("deny");
      expect(bash("(rg -n auth src/a.rs)")).toBe("deny");
      expect(bash("! rg -q auth src/a.rs")).toBe("deny");
    });

    it("treats backgrounding as a launch and redirections as text (N3)", () => {
      expect(bash("rg -n auth src/a.rs &")).toBe("deny");
      expect(bash("rg -n auth src/a.rs & wait")).toBe("deny");
      // `>&` is a redirection, not a control operator - still one segment.
      expect(bash("cargo build 2>&1 | grep error")).toBe("allow");
      expect(bash("echo done & wait")).toBe("allow");
    });

    it("fails open on a wholly pre-upgrade filestate, covered on a mixed one (N5)", () => {
      // No entry anywhere carries a count: the state cannot distinguish a
      // chunk-less file, so nothing is denied until a rebuild stamps counts.
      writeIndex(indexDir, {
        manifest: { root: repo },
        files: INDEXED.map((f) => [f, undefined] as [string, undefined]),
      });
      expect(bash("rg -n auth src/a.rs")).toBe("allow");
      // One stamped entry makes it a mixed (mid-upgrade) state: the unstamped
      // rest keeps the back-compatible covered reading.
      writeIndex(indexDir, {
        manifest: { root: repo },
        files: [["src/a.rs", undefined], "src/auth.rs"],
      });
      expect(bash("rg -n auth src/a.rs")).toBe("deny");
    });

    it("steps over env -i and the other value-less wrapper flags (N6)", () => {
      expect(bash("env -i rg -n auth src/a.rs")).toBe("deny");
      expect(bash("nohup rg -n auth src/a.rs")).toBe("deny");
      expect(bash("stdbuf -o0 rg -n auth src/a.rs")).toBe("deny");
      // xargs -I really does take a value; its launcher is still found.
      expect(bash("xargs -I {} rg -n auth src/a.rs")).toBe("deny");
      // env's -u takes a value too - the launcher must not be eaten.
      expect(bash("env -u PAGER rg -n auth src/a.rs")).toBe("deny");
    });
  });

  describe("SessionStart context", () => {
    it("announces enforcement when the index is fully live", () => {
      const note = hook({ hook_event_name: "SessionStart", cwd: repo }).context;
      expect(note).toContain("are disabled");
      expect(note).toContain("CX_GREP_FALLBACK=1");
    });

    it("says grep stays enabled while the index is not live", () => {
      writeIndex(indexDir, { manifest: { root: repo, vectors: "building" } });
      expect(hook({ hook_event_name: "SessionStart", cwd: repo }).context).toContain("grep stays enabled");
    });
  });
});

// The hand-written fixtures above pin the hook's rules; this one pins the
// agreement they assume - that what the indexer records is what the hook reads.
// A real build over a tree the indexer partly skips is the case the old
// re-derived coverage got wrong, so it is worth the one real index a run costs.
const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map((t) => new Array(16).fill(t.length / 100)),
  dim: async () => 16,
  provider: "fake",
  model: "fake-16d",
};

/** A `.py` the walker takes and the chunker then refuses: an indexable
 * extension over bytes with a NUL in them. */
const NUL_MODULE = Buffer.from("print('x')\u0000binary tail\n", "latin1");

describe("against an index the indexer actually built", () => {
  let root: string;
  let dir: string;
  let db: ReturnType<typeof connect>;

  /** Paths the table actually holds rows for - the ground truth the hook's
   * covered set has to equal. (Read as a GROUP BY: the binding cannot decode
   * a bare DISTINCT projection.) */
  const tablePaths = (): string[] =>
    (db.querySql("SELECT path, COUNT(*) AS n FROM chunks GROUP BY path") as Array<{ path: string }>)
      .map((r) => r.path)
      .sort();

  const bash = (command: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command } }).decision;

  /** Every path the index fingerprinted, split by what the hook decides for
   * it. A denied path is one the hook claims sql can answer. */
  const coveredByHook = (): string[] =>
    Object.keys(readFileState(dir)?.files ?? {})
      .filter((p) => bash(`grep -n zzz ${p}`) === "deny")
      .sort();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cx-enforce-real-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "alpha.ts"), "export function alphaThing() { return 'quokka'; }\n");
    writeFileSync(join(root, "data.csv"), "a,b\n1,2\n");
    writeFileSync(join(root, "package-lock.json"), '{"name":"x","lockfileVersion":3}\n');
    // The two shapes filestate records but the table has no row for.
    writeFileSync(join(root, "pkg", "__init__.py"), "");
    writeFileSync(join(root, "pkg", "blob.py"), NUL_MODULE);
    writeFileSync(join(root, "pkg", "thing.py"), "def thing():\n    return 'wombat'\n");
    dir = join(root, ".infino");
    db = connect(dir);
    await indexRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("records the repo root in the manifest", () => {
    expect(readManifest(join(root, ".infino"))?.root).toBe(root);
  });

  it("denies what the build indexed and allows what it skipped", () => {
    expect(bash("grep -n alphaThing src/alpha.ts")).toBe("deny");
    expect(bash("grep -n 1 data.csv")).toBe("allow");
    expect(bash("grep -n lockfileVersion package-lock.json")).toBe("allow");
  });

  it("records a row count for every fingerprinted file, zero included", () => {
    const files = readFileState(dir)?.files ?? {};
    expect(files["pkg/__init__.py"]?.chunks).toBe(0);
    expect(files["pkg/blob.py"]?.chunks).toBe(0);
    expect(files["pkg/thing.py"]?.chunks).toBeGreaterThan(0);
    // Fingerprinted-but-rowless files stay in the state (dropping them would
    // make every later sync re-hash them), which is why the count is the only
    // thing separating the state from the table.
    expect(Object.keys(files).sort()).not.toEqual(tablePaths());
  });

  it("covers exactly the paths the table holds rows for", () => {
    expect(coveredByHook()).toEqual(tablePaths());
    // Which is to say: the rowless siblings are grep-able, the real one is not.
    expect(bash("grep -n thing pkg/thing.py")).toBe("deny");
    expect(bash("grep -n x pkg/__init__.py")).toBe("allow");
    expect(bash("grep -n x pkg/blob.py")).toBe("allow");
    expect(bash("grep -rn thing pkg")).toBe("deny");
  });

  it("keeps the counts (and so the covered set) right across a sync", async () => {
    writeFileSync(join(root, "pkg", "late.py"), "def late():\n    return 'axolotl'\n");
    writeFileSync(join(root, "pkg", "late_empty.py"), "");
    writeFileSync(join(root, "pkg", "late_blob.py"), NUL_MODULE);
    const outcome = await syncRepo({ root, db, indexDirPath: dir, embedder: fakeEmbedder });
    expect(outcome.action).toBe("synced");

    const files = readFileState(dir)?.files ?? {};
    expect(files["pkg/late.py"]?.chunks).toBeGreaterThan(0);
    expect(files["pkg/late_empty.py"]?.chunks).toBe(0);
    expect(files["pkg/late_blob.py"]?.chunks).toBe(0);
    // The full-build entries survive the sync with their counts intact.
    expect(files["pkg/__init__.py"]?.chunks).toBe(0);
    expect(coveredByHook()).toEqual(tablePaths());
    expect(bash("grep -n late pkg/late.py")).toBe("deny");
    expect(bash("grep -n x pkg/late_empty.py")).toBe("allow");
    expect(bash("grep -n x pkg/late_blob.py")).toBe("allow");
  });
});
