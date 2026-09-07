// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` edits a file the user owns - their other MCP servers, their
// unrelated keys - and the entry it writes is what a client runs on every
// start. So the guards here are about not damaging that file (other servers
// survive, an unparseable config is refused rather than overwritten, a
// symlink stays a symlink) and about the one value that must never land in
// it: the API key travels as a path, never as a key.
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallError, installCmd, platformArgs, serverEntry } from "../src/commands/install-cmd.js";

const VERSION = "9.9.9";

let root: string;
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const configIn = (dir: string) => join(dir, ".mcp.json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-install-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cx install: writing the entry", () => {
  it("creates .mcp.json with the pinned npx entry", () => {
    installCmd({ path: root }, VERSION);
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", `@infino-ai/code-context@${VERSION}`, "mcp"]);
    expect(entry.alwaysLoad).toBe(true);
  });

  it("is idempotent - a second run leaves the same entry", () => {
    installCmd({ path: root }, VERSION);
    const first = readFileSync(configIn(root), "utf8");
    installCmd({ path: root }, VERSION);
    expect(readFileSync(configIn(root), "utf8")).toBe(first);
  });

  it("replaces our entry without touching other servers or unrelated keys", () => {
    writeFileSync(
      configIn(root),
      JSON.stringify({
        $schema: "https://example.invalid/schema.json",
        mcpServers: {
          "code-context": { command: "stale", args: ["old"] },
          other: { command: "keep-me", args: ["untouched"] },
        },
      }),
    );
    installCmd({ path: root }, VERSION);
    const cfg = read(configIn(root));
    expect(cfg.$schema).toBe("https://example.invalid/schema.json");
    expect(cfg.mcpServers.other).toEqual({ command: "keep-me", args: ["untouched"] });
    expect(cfg.mcpServers["code-context"].command).toBe("npx");
  });

  it("writes into an existing config that has no mcpServers block", () => {
    writeFileSync(configIn(root), JSON.stringify({ somethingElse: 1 }));
    installCmd({ path: root }, VERSION);
    const cfg = read(configIn(root));
    expect(cfg.somethingElse).toBe(1);
    expect(cfg.mcpServers["code-context"]).toBeDefined();
  });

  it("honours --name, leaving the default entry alone", () => {
    installCmd({ path: root }, VERSION);
    installCmd({ path: root, name: "supergrep" }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["code-context", "supergrep"]);
  });

  it("--config targets another file and leaves .mcp.json absent", () => {
    const other = join(root, "nested", "cursor.json");
    installCmd({ path: root, config: other }, VERSION);
    expect(read(other).mcpServers["code-context"]).toBeDefined();
    expect(existsSync(configIn(root))).toBe(false);
  });

  it("--local runs the checkout's build through an absolute node", () => {
    const entry = serverEntry({ local: true }, root, VERSION);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toBe(join(root, "dist", "cli.js"));
    expect(entry.args[1]).toBe("mcp");
  });

  it("--dry-run writes nothing", () => {
    installCmd({ path: root, dryRun: true }, VERSION);
    expect(existsSync(configIn(root))).toBe(false);
  });
});

describe("cx install: platform flags", () => {
  it("passes the platform flags through in the CLI's own order", () => {
    const args = platformArgs({
      db: "https://host/db",
      apiKeyFile: "/abs/key",
      embedProvider: "local",
      dbTimeoutMs: "5000",
      coldStartSecs: "90",
    });
    expect(args).toEqual([
      "--db",
      "https://host/db",
      "--api-key-file",
      "/abs/key",
      "--embed-provider",
      "local",
      "--db-timeout-ms",
      "5000",
      "--cold-start-secs",
      "90",
    ]);
  });

  it("omits every flag that was not given", () => {
    expect(platformArgs({})).toEqual([]);
  });

  it("refuses a relative --api-key-file, which the client would resolve elsewhere", () => {
    expect(() => platformArgs({ apiKeyFile: "key.txt" })).toThrow(InstallError);
    expect(() => platformArgs({ apiKeyFile: "./key.txt" })).toThrow(/absolute path/);
  });
});

describe("cx install: the key never reaches the file", () => {
  it("refuses a key handed over as a value instead of a path", () => {
    const looksLikeAKey = "sk-" + "a".repeat(40);
    expect(() => installCmd({ path: root, apiKeyFile: looksLikeAKey }, VERSION)).toThrow(InstallError);
    expect(existsSync(configIn(root))).toBe(false);
  });

  it("does not put the refused key in the error message", () => {
    const looksLikeAKey = "sk-" + "b".repeat(40);
    try {
      installCmd({ path: root, apiKeyFile: looksLikeAKey }, VERSION);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(looksLikeAKey);
    }
  });

  it("writes the path, so the config carries no secret", () => {
    installCmd({ path: root, db: "https://host/db", apiKeyFile: "/home/me/.infino/key" }, VERSION);
    const text = readFileSync(configIn(root), "utf8");
    expect(text).toContain("/home/me/.infino/key");
    expect(text).toContain("--api-key-file");
  });
});

describe("cx install: refusing what it cannot understand", () => {
  it("refuses a config that is not valid JSON rather than overwriting it", () => {
    const path = configIn(root);
    writeFileSync(path, "{ not json, // comments\n");
    expect(() => installCmd({ path: root }, VERSION)).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ not json, // comments\n");
  });

  it("refuses a config whose top level is not an object", () => {
    writeFileSync(configIn(root), JSON.stringify(["an", "array"]));
    expect(() => installCmd({ path: root }, VERSION)).toThrow(/not a JSON object/);
  });

  it("refuses an mcpServers block that is not an object", () => {
    writeFileSync(configIn(root), JSON.stringify({ mcpServers: [] }));
    expect(() => installCmd({ path: root }, VERSION)).toThrow(/not an object of servers/);
  });

  it("treats an empty file as no config at all", () => {
    writeFileSync(configIn(root), "   \n");
    installCmd({ path: root }, VERSION);
    expect(read(configIn(root)).mcpServers["code-context"]).toBeDefined();
  });
});

describe("cx install: not damaging the user's file", () => {
  it("writes through a symlink, leaving it a symlink", () => {
    const real = join(root, "real.json");
    const link = join(root, "link.json");
    writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    symlinkSync(real, link);
    installCmd({ path: root, config: link }, VERSION);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real).mcpServers["code-context"]).toBeDefined();
    expect(read(real).mcpServers.other).toEqual({ command: "keep" });
  });

  it("leaves no temp file behind", () => {
    installCmd({ path: root }, VERSION);
    const strays = readFileSync(configIn(root), "utf8");
    expect(strays).toBeTruthy();
    expect(existsSync(`${configIn(root)}.${process.pid}.cx-tmp`)).toBe(false);
  });
});

describe("cx install --uninstall", () => {
  it("removes our entry and keeps the others", () => {
    writeFileSync(
      configIn(root),
      JSON.stringify({ mcpServers: { "code-context": { command: "npx" }, other: { command: "keep" } } }),
    );
    installCmd({ path: root, uninstall: true }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(servers["code-context"]).toBeUndefined();
    expect(servers.other).toEqual({ command: "keep" });
  });

  it("is a no-op when there is nothing of ours to remove", () => {
    writeFileSync(configIn(root), JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    const before = readFileSync(configIn(root), "utf8");
    installCmd({ path: root, uninstall: true }, VERSION);
    expect(readFileSync(configIn(root), "utf8")).toBe(before);
  });

  it("removes only the named entry", () => {
    installCmd({ path: root }, VERSION);
    installCmd({ path: root, name: "supergrep" }, VERSION);
    installCmd({ path: root, name: "supergrep", uninstall: true }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(servers["code-context"]).toBeDefined();
    expect(servers.supergrep).toBeUndefined();
  });
});

describe("cx install: version lockstep", () => {
  // The published version now lives in a fourth place - cli.ts pins it into
  // the npx entry this command writes - so a release that misses it would
  // configure clients to fetch a version that does not exist.
  it("cli.ts CLI_VERSION matches the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const pinned = /const CLI_VERSION = "([^"]+)"/.exec(cli);
    expect(pinned?.[1]).toBe(pkg.version);
  });
});
