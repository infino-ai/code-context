// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The grep guard: decide whether a PreToolUse event is a grep-family
// invocation that should be denied in favor of the ranked index.
//
// Why block at all: an agent that greps a codebase reasons from match
// fragments, and fragments produce confident wrong claims about code it
// never read. The index answers the same lookups with ranked chunks that
// carry their content, and `bm25_search` covers the exact-identifier case
// grep was kept around for. Blocking is deliberate policy, not a
// capability gap - the repo owner opts in by shipping the hook.
//
// The decision is a pure function of the hook payload so it can be tested
// without a process boundary. The hook wrapper around it must never fail
// the session: unparseable input allows, silently.

/** The PreToolUse payload subset the guard reads. */
export interface GuardPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

/** Programs whose invocation is denied, matched as the executed program
 * (command position), never as a substring - `git log --grep=x` filters
 * history and stays allowed; `\grep`, `/usr/bin/grep`, `env grep`, and
 * `... | grep` are all still grep and denied.
 *
 * The line to hold is not "no grep", it is **no file content reaching the
 * agent through a shell**. Blocking one program at a time loses: with grep
 * denied an agent reaches for `awk`, then `sed`, then `cut`, then an
 * inline interpreter, and answers from the handful of lines whichever one
 * printed. So the whole family of utilities whose job is to emit file
 * contents is denied together - readers and pagers, the text filters, and
 * the interpreters run as one-liners.
 *
 * Nothing here blocks doing work. Builds, tests, benchmarks, git,
 * file moves, and scripts run from a file are all untouched; only "show me
 * the bytes" is redirected to Read and the index, which answer over a
 * corpus of any size and carry the surrounding context a fragment does
 * not. */
const BLOCKED_PROGRAMS = new Set([
  // grep family
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  // stream editors
  "awk", "gawk", "mawk", "nawk", "sed", "ed",
  // readers and pagers
  "cat", "tac", "head", "tail", "nl", "less", "more", "strings",
  "od", "xxd", "hexdump",
  // text filters
  "cut", "tr", "sort", "uniq", "paste", "join", "comm", "column",
  "fold", "rev", "expand", "unexpand", "jq", "yq",
]);

/** Interpreters that are only denied when run as a one-liner: `python3 -c`,
 * `node -e`, `perl -pe`, or a heredoc/stdin script are a text filter wearing
 * a different name, while `python3 script.py` is running a program someone
 * can read. */
const INLINE_INTERPRETERS = new Set([
  "python", "python3", "node", "perl", "ruby", "php", "deno", "bun",
]);

/** Flags that make an interpreter evaluate source from the command line. */
const INLINE_EVAL_FLAG = /^-[A-Za-z]*[ce]$/;

/** Wrapper programs that execute their argument: the token after them is
 * still in command position. */
const WRAPPERS = new Set(["command", "sudo", "env", "xargs", "nice", "time", "timeout", "stdbuf"]);

/** `VAR=value` prefixes before a command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strip a token down to the program it names: drop a leading backslash
 * (alias escape) and any directory path. */
function programName(token: string): string {
  const unescaped = token.startsWith("\\") ? token.slice(1) : token;
  const base = unescaped.slice(unescaped.lastIndexOf("/") + 1);
  return base;
}

/** Whether one pipeline segment invokes a blocked program. */
function segmentBlocked(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip env assignments and wrappers to reach the effective program.
  // Wrapper flags (e.g. `xargs -0`, `timeout 5`) are skipped as
  // non-program tokens: anything starting with `-` or looking like a
  // bare number keeps scanning.
  while (i < tokens.length) {
    const tok = tokens[i];
    if (ENV_ASSIGNMENT.test(tok)) {
      i++;
      continue;
    }
    const prog = programName(tok);
    if (WRAPPERS.has(prog)) {
      i++;
      continue;
    }
    if (prog.startsWith("-") || /^\d+[smh]?$/.test(prog)) {
      i++;
      continue;
    }
    if (BLOCKED_PROGRAMS.has(prog)) return prog;
    // An interpreter is denied only when it evaluates source given on the
    // command line or read from stdin - `python3 -c '...'`, `node -e`,
    // `python3 -` and `python3 <<EOF`. Running a script file is allowed.
    if (INLINE_INTERPRETERS.has(prog)) {
      const args = tokens.slice(i + 1);
      const inline =
        args.some((a) => INLINE_EVAL_FLAG.test(a)) ||
        args.includes("-") ||
        /<<-?\s*['"]?\w+/.test(segment);
      return inline ? `${prog} run inline` : null;
    }
    // `git grep` is grep over the worktree; other `git <sub>` is not.
    if (prog === "git") {
      const sub = tokens
        .slice(i + 1)
        .find((t) => !t.startsWith("-"));
      return sub === "grep" ? "git grep" : null;
    }
    return null; // some other program owns this segment
  }
  return null;
}

/** Split a shell command into pipeline/subshell segments. Coarse on
 * purpose: quoting is not modeled, which can split inside a quoted
 * string - that only ever inspects MORE segments, so quoting cannot be
 * used to smuggle a grep past the guard, and a false positive requires a
 * quoted string whose content itself invokes grep at command position. */
function segments(command: string): string[] {
  return command.split(/(?:\|\|?|&&|;|\n|\$\(|`|\(|\))/);
}

/** The denial message: what was blocked and what to use instead. */
export function denyReason(program: string): string {
  return (
    `${program} is blocked here by code-context: file contents do not reach ` +
    `you through a shell. To read a file, use Read (it takes an offset, so ` +
    `size is not a reason to filter). To find something, use the ` +
    `code-context MCP: bm25_search('chunks','content','<terms>', k) via the ` +
    `sql tool for exact identifiers and strings, hybrid_search to add ` +
    `meaning. Both answer over a corpus of any size and return the ` +
    `surrounding context, which a matched line does not.`
  );
}

/** Decide a PreToolUse event: a deny reason, or null to allow. Pure. */
export function guardDecision(payload: GuardPayload): string | null {
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== "PreToolUse") return null;
  if (payload.tool_name === "Grep") return denyReason("grep (the Grep tool)");
  if (payload.tool_name !== "Bash") return null;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return null;
  for (const seg of segments(command)) {
    const hit = segmentBlocked(seg);
    if (hit) return denyReason(hit);
  }
  return null;
}
