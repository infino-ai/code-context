// Ad-hoc check that the local guard denies every route by which file
// contents could reach the agent through a shell, and still allows the
// commands that do work. Cases live here rather than in a shell line so
// the guard does not (correctly) block the test invocation itself.
const { guardDecision } = require("./guard.cjs");

const bash = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

const DENY = [
  // grep family
  "grep -rn foo src/",
  "rg pattern",
  "egrep -c x f",
  "fgrep lit f",
  "git grep -n foo",
  // stream editors
  "awk '/x/{print}' f.log",
  "gawk -f s.awk f",
  "sed -n '1,5p' f.log",
  "\\sed -i s/a/b/ f",
  // readers and pagers
  "cat f.log",
  "head -20 f.log",
  "tail -5 f.log",
  "tac f.log",
  "less f.log",
  "strings bin",
  "xxd -l 64 bin",
  // text filters
  "cut -d, -f2 data.csv",
  "sort f.log | uniq -c",
  "tr -d ' ' < f",
  "jq '.rows[]' out.json",
  // through pipes, wrappers, env prefixes and paths
  "cargo test | tail -20",
  "TMPDIR=/x awk '{print}' f",
  "xargs -0 sed -i s/a/b/",
  "/usr/bin/head -1 f",
  "echo $(cat f)",
  // inline interpreters
  "python3 -c 'import re; print(1)'",
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "node -e 'console.log(1)'",
  "perl -pe 's/a/b/' f",
  "ruby -e 'puts 1'",
];

const ALLOW = [
  // building, testing, benchmarking
  "cargo test --lib",
  "cargo bench --bench bench -- vector-codec",
  "make ci",
  // scripts from a file, not one-liners
  "python3 gen_chart.py",
  "node build.js",
  "bash run-sweep.sh",
  // git, including its own filtering flags
  "git status --short",
  "git log --grep=fix -5",
  "git -C /repo log --oneline -3",
  "git commit -F msg.txt",
  // file and process management
  "ls -la /mnt/scratch",
  "cp a.log b.log",
  "mkdir -p /mnt/scratch/out",
  "pgrep -af cargo",
  "cargo bench > /mnt/scratch/out.log 2>&1",
  // the words appear, but not as commands
  "echo grep is blocked",
  "man awk",
];

let bad = 0;
for (const c of DENY) {
  if (!guardDecision(bash(c))) { console.log("MISS (should deny):", JSON.stringify(c)); bad++; }
}
for (const c of ALLOW) {
  const r = guardDecision(bash(c));
  if (r) { console.log("FALSE POSITIVE (should allow):", JSON.stringify(c), "->", r.slice(0, 50)); bad++; }
}
console.log(bad === 0
  ? `all ${DENY.length + ALLOW.length} cases correct (${DENY.length} denied, ${ALLOW.length} allowed)`
  : `${bad} case(s) wrong`);
