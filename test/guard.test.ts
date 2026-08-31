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
