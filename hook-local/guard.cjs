"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.denyReason = denyReason;
exports.guardDecision = guardDecision;
/** Programs whose invocation is denied, matched as the executed program
 * (command position), never as a substring - `git log --grep=x` filters
 * history and stays allowed; `\grep`, `/usr/bin/grep`, `env grep`, and
 * `... | grep` are all still grep and denied.
 *
 * `awk` and `sed` are here for the same reason as grep, learned the hard
 * way: with grep blocked, a pattern-matching agent reaches for the next
 * line-filter to hand rather than reading the file, and answers from the
 * three lines it printed. Whatever the tool, extracting a fragment and
 * reasoning from it is the failure being blocked - so the stream editors
 * that make it easy are blocked too. In-place edits belong to Edit, and
 * reading belongs to Read or the index. */
const BLOCKED_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "awk", "gawk", "mawk", "sed"]);
/** Wrapper programs that execute their argument: the token after them is
 * still in command position. */
const WRAPPERS = new Set(["command", "sudo", "env", "xargs", "nice", "time", "timeout", "stdbuf"]);
/** `VAR=value` prefixes before a command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Strip a token down to the program it names: drop a leading backslash
 * (alias escape) and any directory path. */
function programName(token) {
    const unescaped = token.startsWith("\\") ? token.slice(1) : token;
    const base = unescaped.slice(unescaped.lastIndexOf("/") + 1);
    return base;
}
/** Whether one pipeline segment invokes a blocked program. */
function segmentBlocked(segment) {
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
        if (BLOCKED_PROGRAMS.has(prog))
            return prog;
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
function segments(command) {
    return command.split(/(?:\|\|?|&&|;|\n|\$\(|`|\(|\))/);
}
/** The denial message: what was blocked and what to use instead. */
function denyReason(program) {
    return (`${program} is blocked here by code-context. Use the code-context MCP instead: ` +
        `bm25_search('chunks','content','<terms>', k) via the sql tool for exact ` +
        `identifiers and strings, hybrid_search to add meaning, then Read the ` +
        `located file for full context.`);
}
/** Decide a PreToolUse event: a deny reason, or null to allow. Pure. */
function guardDecision(payload) {
    if (payload.hook_event_name !== undefined && payload.hook_event_name !== "PreToolUse")
        return null;
    if (payload.tool_name === "Grep")
        return denyReason("grep (the Grep tool)");
    if (payload.tool_name !== "Bash")
        return null;
    const command = payload.tool_input?.command;
    if (typeof command !== "string" || command.length === 0)
        return null;
    for (const seg of segments(command)) {
        const hit = segmentBlocked(seg);
        if (hit)
            return denyReason(hit);
    }
    return null;
}
