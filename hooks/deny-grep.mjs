#!/usr/bin/env node
// PreToolUse hook (Bash matcher): deny standalone grep/rg/git-grep commands
// and redirect the agent to the code-context search/sql tools. Pipelines that
// merely filter other command output through grep are allowed - filtering
// logs or test output is a job the index does not do.
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(data)?.tool_input?.command ?? "";
  } catch {
    // Unparseable payload: allow (emit nothing) rather than break the tool call.
  }
  if (/^\s*(rg|grep|git\s+grep)\s/.test(command)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "code-context: standalone grep/rg for code search is disabled. Use the search MCP tool to find or understand code, or sql for counts and rankings across the repo. Piping other command output through grep is still allowed.",
        },
      }),
    );
  }
});
