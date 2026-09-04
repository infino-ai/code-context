#!/usr/bin/env node
// Local PreToolUse grep guard — standalone build of code-context's
// hook/block-grep branch, for use until the released plugin ships it.
const { guardDecision } = require("./guard.cjs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let reason = null;
  try { reason = guardDecision(JSON.parse(input)); } catch {}
  if (reason !== null) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }}));
  }
});
