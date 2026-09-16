// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors

// The permission guard for a PUBLICLY reachable demo.
//
// On the tailnet the lanes run under `bypassPermissions`, which is right there:
// every visitor is someone with a key to the tailnet, and the arms have to hold
// the tools a real developer session holds or the comparison is not the
// comparison. Opened to the internet the same session is a text box that runs
// tool calls on the demo host, and the corpora being public data does not make
// the HOST public — `~/.infino/key` and the model key in the run's environment
// are on it.
//
// So this is not a second, weaker demo. It is the same tools with two questions
// asked of every call: is the path inside the corpus, and is the command one the
// file-tools arm actually runs. A visitor still greps a real checkout; they
// cannot read outside it or start a process that isn't a search.
//
// OFF BY DEFAULT and opt-in through `DEMO_PUBLIC=1`, because the bench's
// recorded numbers were measured without it. A guard that silently changed what
// an arm could do would make every figure since incomparable with every figure
// before.

import { resolve, sep } from "node:path";

/// The shell binaries the file-tools arm genuinely uses to search a checkout.
/// Read-only, every one of them: nothing here writes, fetches, or executes
/// something else. `find` earns its place because the arm counts files with it,
/// and is the one that needs its arguments checked (`-exec` runs anything).
const READ_ONLY_COMMANDS = new Set([
  "grep",
  "rg",
  "ls",
  "find",
  "wc",
  "head",
  "tail",
  "cat",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "echo",
  "basename",
  "dirname",
  "file",
  "stat",
  "du",
]);

/// `find` predicates that run another program. The point of the allowlist is
/// that every command in it is read-only; these hand that property away.
const FIND_EXEC_PREDICATES = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf"];

/// Shell syntax that chains, substitutes or redirects. A pipeline of allowlisted
/// readers is fine and is how the arm counts things; everything else here either
/// runs a second command the allowlist never saw (`;`, `&&`, backticks, `$(`) or
/// writes (`>`), so the command is refused rather than parsed cleverly.
const FORBIDDEN_SHELL = [";", "&&", "||", "&", "`", "$(", "${", ">", "<", "\n"];

/// Tools that only ever read, and take their target as a path we can check.
const PATH_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/// Input fields those tools carry a path in, across SDK versions.
const PATH_FIELDS = ["file_path", "path", "notebook_path"];

/** Whether `candidate` sits inside `root` (or is `root`). */
export function insideRoot(root, candidate) {
  const realRoot = resolve(root);
  const abs = resolve(realRoot, String(candidate));
  return abs === realRoot || abs.startsWith(realRoot + sep);
}

/** Split a command line on pipes, ignoring pipes inside quotes. */
function pipelineSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** The bare words of a segment, quotes stripped. */
function words(segment) {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) =>
    w.replace(/^["']|["']$/g, ""),
  );
}

/**
 * Why `command` is refused, or `null` when it is allowed.
 *
 * Deliberately a whole-command verdict rather than a sanitiser: a command that
 * does not read as a pipeline of allowlisted readers over the corpus is refused
 * intact, never rewritten into something that looks safe.
 */
export function refuseBash(root, command) {
  const text = String(command ?? "");
  if (!text.trim()) return "an empty command";
  for (const token of FORBIDDEN_SHELL) {
    // `||` contains `|`, so the pipe split alone cannot catch these.
    if (text.includes(token)) {
      return `shell syntax ${JSON.stringify(token)}, which can run a command this demo has not allowed`;
    }
  }
  const segments = pipelineSegments(text);
  if (segments.length === 0) return "an empty command";
  for (const segment of segments) {
    const parts = words(segment);
    if (parts.length === 0) return "an empty pipeline stage";
    const binary = parts[0].split("/").pop();
    if (!READ_ONLY_COMMANDS.has(binary)) {
      return `\`${binary}\` is not one of the read-only search commands this demo allows`;
    }
    if (binary === "find" && parts.some((p) => FIND_EXEC_PREDICATES.includes(p))) {
      return "`find` with a predicate that runs or deletes";
    }
    // Any argument that looks like a filesystem path has to be inside the
    // corpus. A flag is not a path; a bare search term is resolved against the
    // corpus anyway and so is always inside it.
    for (const part of parts.slice(1)) {
      if (part.startsWith("-")) continue;
      if (!part.includes("/") && !part.startsWith("~")) continue;
      if (part.startsWith("~") || !insideRoot(root, part)) {
        return `the path ${JSON.stringify(part)} is outside the corpus`;
      }
    }
  }
  return null;
}

/**
 * A `canUseTool` callback that keeps a publicly reachable run inside `root`.
 *
 * Allows the code-context MCP tools outright — they are the product under
 * comparison and reach the index and the platform, never this host's
 * filesystem. Allows the read-only file tools when their path is inside the
 * corpus, and `Bash` when it reads as a pipeline of search commands over it.
 * Everything else is denied with a reason the model can act on, which matters:
 * a refusal it understands makes it try another way rather than spend the turn.
 */
export function publicGuard(root, { mcpPrefix = "mcp__" } = {}) {
  return async (toolName, input) => {
    const allow = { behavior: "allow", updatedInput: input };
    const deny = (message) => ({ behavior: "deny", message });

    if (toolName.startsWith(mcpPrefix)) return allow;

    if (PATH_TOOLS.has(toolName)) {
      for (const field of PATH_FIELDS) {
        const value = input?.[field];
        if (typeof value === "string" && value && !insideRoot(root, value)) {
          return deny(
            `this demo is public, so ${toolName} is limited to the corpus; ` +
              `${JSON.stringify(value)} is outside it.`,
          );
        }
      }
      return allow;
    }

    if (toolName === "Bash") {
      const refusal = refuseBash(root, input?.command);
      if (refusal) {
        return deny(
          `this demo is public, so Bash is limited to read-only searches of the ` +
            `corpus; this one used ${refusal}. Grep, Glob and Read are available, ` +
            `as are pipelines of the usual search commands over the checkout.`,
        );
      }
      return allow;
    }

    return deny(
      `${toolName} is not available in the public demo; it offers the read-only ` +
        `file tools over the corpus and the code-context tools.`,
    );
  };
}
