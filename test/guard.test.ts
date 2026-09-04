// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors

import { describe, expect, it } from "vitest";
import { guardDecision } from "../src/core/guard.js";

const bash = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

describe("guardDecision", () => {
  it("denies the Grep tool outright", () => {
    expect(guardDecision({ hook_event_name: "PreToolUse", tool_name: "Grep" })).toMatch(/blocked/);
  });

  it("denies grep at command position", () => {
    expect(guardDecision(bash("grep -rn foo src/"))).toMatch(/grep is blocked/);
  });

  it("denies rg, egrep, fgrep", () => {
    for (const cmd of ["rg pattern", "egrep -c x f", "fgrep lit f"]) {
      expect(guardDecision(bash(cmd))).not.toBeNull();
    }
  });

  it("denies the stream editors, which are grep by another name", () => {
    for (const cmd of [
      "awk '/x/{print}' f.log",
      "gawk -f s.awk f",
      "mawk '{print}' f",
      "sed -n '1,5p' f.log",
      "cat f.log | awk '{print $2}'",
      "/usr/bin/sed s/a/b/ f",
      "\\sed -i s/a/b/ f",
      "TMPDIR=/x awk '{print}' f",
      "xargs -0 sed -i s/a/b/",
    ]) {
      expect(guardDecision(bash(cmd)), cmd).not.toBeNull();
    }
  });

  it("denies readers, pagers and text filters — anything that emits file contents", () => {
    for (const cmd of [
      "cat f.log",
      "head -20 f.log",
      "tail -5 f.log",
      "tac f.log",
      "nl f.log",
      "less f.log",
      "strings bin",
      "xxd -l 64 bin",
      "od -c bin",
      "cut -d, -f2 data.csv",
      "sort f.log | uniq -c",
      "tr -d ' ' < f",
      "jq '.rows[]' out.json",
      "cargo test | tail -20",
      "/usr/bin/head -1 f",
      "echo $(cat f)",
    ]) {
      expect(guardDecision(bash(cmd)), cmd).not.toBeNull();
    }
  });

  it("denies interpreters run inline, allows them run from a script file", () => {
    for (const cmd of [
      "python3 -c 'import re; print(1)'",
      "python -c 'print(1)'",
      "python3 - <<'EOF'\nprint(1)\nEOF",
      "node -e 'console.log(1)'",
      "perl -pe 's/a/b/' f",
      "ruby -e 'puts 1'",
    ]) {
      expect(guardDecision(bash(cmd)), cmd).not.toBeNull();
    }
    for (const cmd of ["python3 gen_chart.py", "node build.js", "bash run.sh"]) {
      expect(guardDecision(bash(cmd)), cmd).toBeNull();
    }
  });

  it("leaves the commands that do work alone", () => {
    for (const cmd of [
      "cargo test --lib",
      "cargo bench --bench bench -- vector-codec",
      "make ci",
      "git status --short",
      "git commit -F msg.txt",
      "ls -la /mnt/scratch",
      "cp a.log b.log",
      "mkdir -p /mnt/scratch/out",
      "cargo bench > /mnt/scratch/out.log 2>&1",
    ]) {
      expect(guardDecision(bash(cmd)), cmd).toBeNull();
    }
  });

  it("denies grep behind a pipe", () => {
    expect(guardDecision(bash("cat build.log | grep -i error"))).not.toBeNull();
  });

  it("denies grep behind wrappers, env assignments, paths, and alias escapes", () => {
    for (const cmd of [
      "FOO=1 grep x f",
      "env FOO=1 grep x f",
      "xargs -0 grep -l x",
      "command grep x f",
      "/usr/bin/grep x f",
      "\\grep x f",
      "timeout 5 rg x",
    ]) {
      expect(guardDecision(bash(cmd)), cmd).not.toBeNull();
    }
  });

  it("denies git grep but allows other git subcommands", () => {
    expect(guardDecision(bash("git grep -n foo"))).toMatch(/git grep/);
    expect(guardDecision(bash("git log --grep=fix -5"))).toBeNull();
    expect(guardDecision(bash("git -C /repo log --grep=fix"))).toBeNull();
  });

  it("denies grep inside command substitution", () => {
    expect(guardDecision(bash("echo $(grep -c x f)"))).not.toBeNull();
  });

  it("allows grep as a mere argument", () => {
    expect(guardDecision(bash("echo grep is blocked"))).toBeNull();
    expect(guardDecision(bash("man grep"))).toBeNull();
  });

  it("allows unrelated commands and tools", () => {
    expect(guardDecision(bash("cargo test --lib"))).toBeNull();
    expect(guardDecision({ hook_event_name: "PreToolUse", tool_name: "Read" })).toBeNull();
  });

  it("allows on missing or malformed input", () => {
    expect(guardDecision({})).toBeNull();
    expect(guardDecision({ tool_name: "Bash" })).toBeNull();
    expect(guardDecision({ tool_name: "Bash", tool_input: {} })).toBeNull();
  });

  it("ignores non-PreToolUse events", () => {
    expect(
      guardDecision({ hook_event_name: "PostToolUse", tool_name: "Grep" }),
    ).toBeNull();
  });
});
