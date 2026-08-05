// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The Claude Code plugin launches the MCP server via `npx` with an exact
// version pin. An unpinned spec lets `npx` prefer whatever copy is already
// installed on the machine, so a user with a stale global install silently
// gets old server behavior no matter what the plugin ships. The pin makes
// the plugin version decide what runs; these guards keep it (and the plugin
// manifest) in lockstep with the package version at each release.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("claude code plugin release lockstep", () => {
  const version = read("package.json").version as string;

  it(".mcp.json pins the published package to this release", () => {
    const args = read(".mcp.json").mcpServers["code-context"].args as string[];
    expect(args).toContain(`@infino-ai/code-context@${version}`);
  });

  it("plugin manifest version matches the package version", () => {
    expect(read(".claude-plugin/plugin.json").version).toBe(version);
  });
});
