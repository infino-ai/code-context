#!/usr/bin/env node
// code-context enforcement hook: steer code search to the sql tool without
// trapping the agent.
//
// Grep (the tool, or a standalone grep/rg/git-grep Bash command) is denied
// with a redirect to the sql TVFs ONLY when all of these hold:
//   - the repo's index is fully live: manifest present, vectors "ready",
//     nothing truncated by the file cap, and the table actually on disk
//     (a manifest orphaned by a deleted table fails open);
//   - every explicit grep target is something the index covers - a target
//     outside the repo, gitignored, over the byte cap, a dot-path, or
//     nonexistent is auto-allowed, because sql could not answer it anyway;
//   - the command does not carry the CX_GREP_FALLBACK=1 marker - with the
//     marker the decision is "ask", the human-approved fallback for when an
//     index search genuinely came up short.
// Pipe-filter grep (cargo test | grep FAILED) never matches; CX_NO_ENFORCE=1
// disables the hook entirely. Every ambiguity fails open (allow).
//
// One script serves SessionStart and the PreToolUse matchers, dispatching on
// the payload. The legacy `search` tool (pre-0.2 servers) is denied with a
// redirect to sql.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";

const INDEX_FORMAT_VERSION = 2;
/** Mirror of the indexer's default byte cap (CX_MAX_FILE_BYTES). */
const MAX_FILE_BYTES = Number(process.env.CX_MAX_FILE_BYTES ?? 1024 * 1024);

/** A grep-like launch: optional fallback marker, then rg | grep | git grep. */
const GREP_LAUNCH = /^\s*(CX_GREP_FALLBACK=1\s+)?(rg|grep|git\s+grep)\s/;

/** Locate the index for cwd (CX_INDEX_DIR override, else walk up to .infino)
 * and classify it. Only "ready" enforces; everything else fails open. */
function indexInfo(cwd) {
  let manifestFile;
  let root = cwd || process.cwd();
  if (process.env.CX_INDEX_DIR) {
    manifestFile = join(process.env.CX_INDEX_DIR, "codecontext.json");
  } else {
    for (let dir = root; ; dir = dirname(dir)) {
      const candidate = join(dir, ".infino", "codecontext.json");
      if (existsSync(candidate)) {
        manifestFile = candidate;
        root = dir;
        break;
      }
      if (dirname(dir) === dir) return { state: "none", root };
    }
  }
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (m.version !== INDEX_FORMAT_VERSION) return { state: "none", root };
    if (m.truncatedFiles) return { state: "partial", root };
    if (m.vectors !== "ready") return { state: "building", root };
    // A "ready" manifest orphaned by a deleted/moved table would deny grep
    // while sql also errors - losing both paths. Confirm the table exists.
    const indexDir = dirname(manifestFile);
    const hasTable = readdirSync(indexDir).some((n) => n.startsWith(`${m.table}-`));
    return { state: hasTable ? "ready" : "none", root };
  } catch {
    return { state: "none", root };
  }
}

/** Explicit path targets of a grep-like command, heuristically: bare tokens
 * after the first (the pattern). isSearch is false for pattern-less
 * invocations like `grep --version`. Misparses fail open downstream. */
function grepTargets(command) {
  const toks = command.trim().split(/\s+/);
  let i = 0;
  if (/^CX_GREP_FALLBACK=1$/.test(toks[i])) i++;
  i += toks[i] === "git" ? 2 : 1;
  const targets = [];
  let sawPattern = false;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") continue;
    if (t.startsWith("-")) continue;
    if (!sawPattern) {
      sawPattern = true;
      continue;
    }
    targets.push(t.replace(/^['"]|['"]$/g, ""));
  }
  return { targets, isSearch: sawPattern };
}

/** True when the index cannot cover this target, so grep must be allowed:
 * outside the repo, a dot-path, nonexistent, over the byte cap, or
 * gitignored. Inconclusive signals count as covered (the policy applies). */
function uncoveredTarget(target, cwd, root) {
  const p = isAbsolute(target) ? target : resolve(cwd || root, target);
  const rel = relative(root, p);
  if (rel.startsWith("..") || isAbsolute(rel)) return true;
  if (rel.split(sep).some((part) => part.startsWith(".") && part !== ".")) return true;
  let st;
  try {
    st = statSync(p);
  } catch {
    return true;
  }
  if (st.isFile() && st.size > MAX_FILE_BYTES) return true;
  try {
    const r = spawnSync("git", ["-C", root, "check-ignore", "-q", p], { timeout: 3000 });
    if (r.status === 0) return true;
  } catch {
    // git unavailable - skip this signal
  }
  return false;
}

const decision = (permissionDecision, permissionDecisionReason) =>
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
    }),
  );

const DENY_REASON =
  "code-context: the index fully covers this repo, so grep/rg for code search is disabled. " +
  "Use the sql MCP tool - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for " +
  "ranked retrieval, GROUP BY over it for counts/rankings. Piping other command output through " +
  "grep is still allowed. If an index search genuinely came up short, re-run this command " +
  "prefixed with CX_GREP_FALLBACK=1 to request it; CX_NO_ENFORCE=1 in the environment disables " +
  "enforcement entirely.";

const ASK_REASON =
  "code-context fallback: the agent signals an index search came up short and asks to grep " +
  "directly. Allow this grep?";

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    return; // unparseable payload: do nothing rather than break the call
  }

  if (input.hook_event_name === "SessionStart") {
    const note =
      process.env.CX_NO_ENFORCE === "1"
        ? "code-context is available: search the code with the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, bm25_search for keyword-only, GROUP BY for counts/rankings."
        : indexInfo(input.cwd).state === "ready"
          ? "code-context is active and the index fully covers this repo: all code search goes through the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval (embed map {\"q\":...}), bm25_search for keyword-only, GROUP BY over either for counts/rankings. The Grep tool and standalone grep/rg commands are disabled (grep as a pipe filter on other command output still works; if an index search genuinely came up short, prefix the grep with CX_GREP_FALLBACK=1 to request it)."
          : "code-context is available: search the code with the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, bm25_search for keyword-only, GROUP BY for counts/rankings (the index builds as the server starts). grep stays enabled until the index fully covers the repo.";
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note },
      }),
    );
    return;
  }

  const toolName = input.tool_name ?? "";

  // Legacy `search` tool (pre-0.2 servers): sql is the search surface.
  if (/code[-_]context.*__search$/.test(toolName)) {
    decision(
      "deny",
      'code-context: search goes through the sql tool. Ranked retrieval: SELECT path, start_line, end_line, symbol, content FROM hybrid_search(\'chunks\',\'content\',\'<terms>\',\'embedding\', {{q}}, 10) with embed {"q":"<your question>"} - or bm25_search(\'chunks\',\'content\',\'<terms>\', 10) while vectors are backfilling. Rank + aggregate composes via GROUP BY.',
    );
    return;
  }

  if (process.env.CX_NO_ENFORCE === "1") return;

  if (toolName === "Grep") {
    const info = indexInfo(input.cwd);
    if (info.state !== "ready") return;
    const target = input.tool_input?.path;
    if (target && uncoveredTarget(target, input.cwd, info.root)) return;
    decision("deny", DENY_REASON);
    return;
  }

  if (toolName === "Bash") {
    const command = input.tool_input?.command ?? "";
    const m = GREP_LAUNCH.exec(command);
    if (!m) return;
    const info = indexInfo(input.cwd);
    if (info.state !== "ready") return;
    const { targets, isSearch } = grepTargets(command);
    if (!isSearch) return; // pattern-less: grep --version etc.
    if (targets.some((t) => uncoveredTarget(t, input.cwd, info.root))) return;
    if (m[1]) {
      decision("ask", ASK_REASON);
      return;
    }
    decision("deny", DENY_REASON);
  }
});
