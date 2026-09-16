// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors

// The public demo's permission guard. A hand-written command filter is exactly
// the kind of thing that is wrong in ways nobody notices until it matters, so
// the escapes are the tests: the interesting cases here are all the ones that
// LOOK like a search and are not.
//
//   node --test bench/public-guard-tests.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { insideRoot, publicGuard, refuseBash } from "./public-guard.mjs";

const ROOT = "/corpus/repo";

test("a plain search of the corpus is allowed", () => {
  assert.equal(refuseBash(ROOT, "grep -rn 'shard allocation' ."), null);
  assert.equal(refuseBash(ROOT, "rg --count TODO"), null);
  assert.equal(refuseBash(ROOT, "find . -name '*.java'"), null);
});

test("a pipeline of readers is allowed, because counting is what the arm does", () => {
  assert.equal(refuseBash(ROOT, "grep -rn class . | wc -l"), null);
  assert.equal(refuseBash(ROOT, "find . -name '*.md' | sort | uniq | head -20"), null);
});

test("chaining is refused however it is spelled", () => {
  for (const command of [
    "grep -r x . ; cat /home/ubuntu/.infino/key",
    "grep -r x . && env",
    "grep -r x . || env",
    "grep -r x . & env",
    "echo `cat /home/ubuntu/.infino/key`",
    "echo $(env)",
    "echo ${HOME}",
    "grep -r x . > /tmp/out",
    "grep -r x . < /etc/passwd",
  ]) {
    assert.notEqual(refuseBash(ROOT, command), null, command);
  }
});

test("a command outside the allowlist is refused even with no shell syntax", () => {
  for (const command of ["env", "curl https://example.test", "bash", "sh -c ls", "python3 -c pass", "node -e 1"]) {
    assert.notEqual(refuseBash(ROOT, command), null, command);
  }
});

test("an allowlisted reader is still refused a path outside the corpus", () => {
  assert.notEqual(refuseBash(ROOT, "cat /home/ubuntu/.infino/key"), null);
  assert.notEqual(refuseBash(ROOT, "grep -r token /home/ubuntu"), null);
  assert.notEqual(refuseBash(ROOT, "ls ~/.ssh"), null);
  // The classic: a relative path that climbs out.
  assert.notEqual(refuseBash(ROOT, "cat ../../home/ubuntu/.infino/key"), null);
});

test("a reader hidden behind its absolute path is still matched by its name", () => {
  assert.equal(refuseBash(ROOT, "/usr/bin/grep -rn x ."), null);
  assert.notEqual(refuseBash(ROOT, "/usr/bin/env"), null);
});

test("find cannot be turned into an exec", () => {
  for (const command of [
    "find . -name '*.md' -exec cat {} ;",
    "find . -execdir env ;",
    "find . -delete",
    "find . -fprintf /tmp/x %p",
  ]) {
    assert.notEqual(refuseBash(ROOT, command), null, command);
  }
});

test("insideRoot holds the boundary, including a sibling with a shared prefix", () => {
  assert.equal(insideRoot(ROOT, "src/main.java"), true);
  assert.equal(insideRoot(ROOT, "."), true);
  assert.equal(insideRoot(ROOT, "/corpus/repo/src"), true);
  assert.equal(insideRoot(ROOT, "/corpus/repo-secrets/key"), false);
  assert.equal(insideRoot(ROOT, "../elsewhere"), false);
  assert.equal(insideRoot(ROOT, "/etc/passwd"), false);
});

test("the guard allows the product's own tools and the scoped file tools", async () => {
  const guard = publicGuard(ROOT);
  assert.equal((await guard("mcp__code-context__search", { query: "x" })).behavior, "allow");
  assert.equal((await guard("Grep", { pattern: "x", path: "src" })).behavior, "allow");
  assert.equal((await guard("Read", { file_path: "/corpus/repo/README.md" })).behavior, "allow");
});

test("the guard denies a read outside the corpus, and says why", async () => {
  const guard = publicGuard(ROOT);
  const result = await guard("Read", { file_path: "/home/ubuntu/.infino/key" });
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /outside it/);
});

test("the guard denies a tool it was never given", async () => {
  const guard = publicGuard(ROOT);
  for (const tool of ["Write", "Edit", "WebFetch", "NotebookEdit"]) {
    assert.equal((await guard(tool, {})).behavior, "deny", tool);
  }
});
