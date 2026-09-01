// Ad-hoc check that the local guard denies the stream editors and still
// allows ordinary commands. Cases live here rather than in a shell line
// so the guard does not (correctly) block the test invocation itself.
const { guardDecision } = require("./guard.cjs");

const bash = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

const DENY = [
  "awk '/x/{print}' f.log",
  "sed -n '1,5p' f.log",
  "cat f.log | awk '{print $2}'",
  "gawk -f s.awk f",
  "mawk '{print}' f",
  "/usr/bin/sed s/a/b/ f",
  "\\sed -i s/a/b/ f",
  "TMPDIR=/x awk '{print}' f",
  "xargs -0 sed -i s/a/b/",
  "echo $(awk '{print}' f)",
];

const ALLOW = [
  "cargo test --lib",
  "git log --grep=fix -5",
  "python3 gen.py",
  "ls -la /mnt/scratch",
  "cp a.log b.log",
];

let bad = 0;
for (const c of DENY) {
  const r = guardDecision(bash(c));
  if (!r) { console.log("MISS (should deny):", c); bad++; }
}
for (const c of ALLOW) {
  const r = guardDecision(bash(c));
  if (r) { console.log("FALSE POSITIVE (should allow):", c, "->", r.slice(0, 40)); bad++; }
}
console.log(bad === 0
  ? `all ${DENY.length + ALLOW.length} cases correct (${DENY.length} denied, ${ALLOW.length} allowed)`
  : `${bad} case(s) wrong`);
