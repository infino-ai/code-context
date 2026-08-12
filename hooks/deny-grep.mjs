#!/usr/bin/env node
// code-context enforcement hook, gated on index readiness.
//
// Grep (the tool, or standalone grep/rg/git-grep in Bash) is denied with a
// redirect to the search/sql tools ONLY once the repo's index fully covers
// the code: manifest present, vectors "ready", nothing truncated by the file
// cap. Until then grep passes through - agents are never forced onto an
// index that doesn't exist yet or can't answer semantically. Pipelines that
// merely filter other command output through grep are always allowed.
//
// One script serves three hook bindings (SessionStart, PreToolUse/Grep,
// PreToolUse/Bash), dispatching on the payload.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const INDEX_FORMAT_VERSION = 2;

/** Walk up from cwd to the index manifest (CX_INDEX_DIR overrides, matching
 * the cx CLI). Returns "ready" | "partial" | "building" | "none". */
function indexState(cwd) {
  let manifestFile;
  if (process.env.CX_INDEX_DIR) {
    manifestFile = join(process.env.CX_INDEX_DIR, "codecontext.json");
  } else {
    for (let dir = cwd || process.cwd(); ; dir = dirname(dir)) {
      const candidate = join(dir, ".infino", "codecontext.json");
      if (existsSync(candidate)) {
        manifestFile = candidate;
        break;
      }
      if (dirname(dir) === dir) return "none";
    }
  }
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (m.version !== INDEX_FORMAT_VERSION) return "none";
    if (m.truncatedFiles) return "partial";
    return m.vectors === "ready" ? "ready" : "building";
  } catch {
    return "none";
  }
}

const GREP_LAUNCH = /^\s*(rg|grep|git\s+grep)\s/;

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
      indexState(input.cwd) === "ready"
        ? "code-context is active and the index fully covers this repo: all code search goes through the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval (embed map {\"q\":...}), bm25_search for keyword-only, GROUP BY over either for counts/rankings. The Grep tool and standalone grep/rg commands are disabled (grep as a pipe filter on other command output still works)."
        : "code-context is available: search the code with the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, bm25_search for keyword-only, GROUP BY for counts/rankings (the first call builds the index). grep stays enabled until the index fully covers the repo.";
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note },
      }),
    );
    return;
  }

  // Policy: sql-with-TVFs is the only search surface. The search tool (still
  // registered by older server builds) and raw vector_search are both denied
  // with a redirect; bm25_search/hybrid_search are the sanctioned TVFs.
  const toolName = input.tool_name ?? "";
  if (/code[-_]context.*__search$/.test(toolName)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            'code-context: search goes through the sql tool. Ranked retrieval: SELECT path, start_line, end_line, symbol, content FROM hybrid_search(\'chunks\',\'content\',\'<terms>\',\'embedding\', {{q}}, 10) with embed {"q":"<your question>"} - or bm25_search(\'chunks\',\'content\',\'<terms>\', 10) before vectors are ready. Rank + aggregate composes via GROUP BY.',
        },
      }),
    );
    return;
  }
  if (/code[-_]context.*__sql$/.test(toolName) && /\bvector_search\s*\(/i.test(input.tool_input?.query ?? "")) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "code-context: vector_search is not exposed - use hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) with the embed map (keyword + semantic fused), or bm25_search before vectors are ready.",
        },
      }),
    );
    return;
  }

  const isGrep =
    toolName === "Grep" ||
    (toolName === "Bash" && GREP_LAUNCH.test(input.tool_input?.command ?? ""));
  if (!isGrep || indexState(input.cwd) !== "ready") return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "code-context: the index fully covers this repo, so grep/rg for code search is disabled. Use the sql MCP tool - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, GROUP BY over it for counts/rankings. Piping other command output through grep is still allowed.",
      },
    }),
  );
});
