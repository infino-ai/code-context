// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx install` edits a file the user owns - their other MCP servers, their
// unrelated keys - and the entry it writes is what a client runs on every
// start. So the guards here are about not damaging that file (other servers
// survive, an unparseable config is refused rather than overwritten, a
// symlink stays a symlink) and about the one value that must never land in
// it: the API key travels as a path, never as a key.
//
// Every test here points CX_ACCOUNT_DIR at an empty temp directory, so no test
// can see the account of whoever is running the suite. Without that, `cx
// install` with no flags would pick up a real key and try to register a
// database on a real platform - the suite would pass or fail depending on
// whose laptop it ran on, and it would make network calls nobody asked for.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallError, installCmd, platformArgs, serverEntry } from "../src/commands/install-cmd.js";

const VERSION = "9.9.9";

let root: string;
let accountDir: string;
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const configIn = (dir: string) => join(dir, ".mcp.json");

/** Give the run a stored account: a key at 0600 and the platform beside it.
 * `consented` is what `cx login` plus one interactive `cx install` leaves
 * behind; without it the upload gate refuses, which is its own set of tests
 * below rather than a precondition of the entry-writing ones. */
const signIn = (baseUrl: string, consented = true) => {
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, "key"), "inf_deadbeef_secret\n", { mode: 0o600 });
  writeFileSync(
    join(accountDir, "account.json"),
    JSON.stringify({
      baseUrl,
      storedAt: "2026-09-08T00:00:00.000Z",
      ...(consented ? { uploadConsentAt: "2026-09-08T00:00:00.000Z" } : {}),
    }),
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-install-"));
  accountDir = mkdtempSync(join(tmpdir(), "cx-account-"));
  process.env.CX_ACCOUNT_DIR = accountDir;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
  vi.restoreAllMocks();
});

describe("cx install: writing the entry", () => {
  it("creates .mcp.json with an entry that starts the server", async () => {
    await installCmd({ path: root }, VERSION);
    const entry = read(configIn(root)).mcpServers["code-context"];
    // The command depends on where this CLI runs from, and the suite runs
    // from the checkout, so the shape asserted here is the source-build one.
    // `serverEntry` owns which shape is chosen and is tested for both.
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toMatch(/cli\.js$/);
    expect(entry.args[1]).toBe("mcp");
    expect(entry.alwaysLoad).toBe(true);
  });

  it("writes the pinned npx entry when asked for one", async () => {
    await installCmd({ path: root, npx: true }, VERSION);
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", `@infino-ai/code-context@${VERSION}`, "mcp"]);
    expect(entry.alwaysLoad).toBe(true);
  });

  it("is idempotent - a second run leaves the same entry", async () => {
    await installCmd({ path: root }, VERSION);
    const first = readFileSync(configIn(root), "utf8");
    await installCmd({ path: root }, VERSION);
    expect(readFileSync(configIn(root), "utf8")).toBe(first);
  });

  it("replaces our entry without touching other servers or unrelated keys", async () => {
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
    await installCmd({ path: root }, VERSION);
    const cfg = read(configIn(root));
    expect(cfg.$schema).toBe("https://example.invalid/schema.json");
    expect(cfg.mcpServers.other).toEqual({ command: "keep-me", args: ["untouched"] });
    expect(cfg.mcpServers["code-context"].command).not.toBe("stale");
  });

  it("writes into an existing config that has no mcpServers block", async () => {
    writeFileSync(configIn(root), JSON.stringify({ somethingElse: 1 }));
    await installCmd({ path: root }, VERSION);
    const cfg = read(configIn(root));
    expect(cfg.somethingElse).toBe(1);
    expect(cfg.mcpServers["code-context"]).toBeDefined();
  });

  it("honours --name, leaving the default entry alone", async () => {
    await installCmd({ path: root }, VERSION);
    await installCmd({ path: root, name: "supergrep" }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["code-context", "supergrep"]);
  });

  it("--config targets another file and leaves .mcp.json absent", async () => {
    const other = join(root, "nested", "cursor.json");
    await installCmd({ path: root, config: other }, VERSION);
    expect(read(other).mcpServers["code-context"]).toBeDefined();
    expect(existsSync(configIn(root))).toBe(false);
  });

  it("defaults to running this build, because these tests run from a source tree", () => {
    // The default is decided by where the CLI is running from, not by a flag:
    // the test suite runs from the checkout, so the entry must name this
    // build. Writing an npx entry here would pin a version that is not on the
    // registry until release, and the client could not start it.
    const entry = serverEntry({}, VERSION);
    expect(entry.command).toBe(process.execPath);
    // This build's own cli.js, not one under the repository being installed
    // into: a checkout is built once and installed into many repos, so a path
    // relative to the target names a file that is not there.
    expect(entry.args[0]).toMatch(/cli\.js$/);
    expect(entry.args[0]).not.toContain(root);
    expect(entry.args[1]).toBe("mcp");
  });

  it("--local and --npx force either shape", () => {
    expect(serverEntry({ local: true }, VERSION).command).toBe(process.execPath);
    const pinned = serverEntry({ npx: true }, VERSION);
    expect(pinned.command).toBe("npx");
    expect(pinned.args).toEqual(["-y", `@infino-ai/code-context@${VERSION}`, "mcp"]);
    // --npx wins when both are passed, so the forced published entry is never
    // silently downgraded to a local path.
    expect(serverEntry({ local: true, npx: true }, VERSION).command).toBe("npx");
  });

  it("--dry-run writes nothing", async () => {
    await installCmd({ path: root, dryRun: true }, VERSION);
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
  it("refuses a key handed over as a value instead of a path", async () => {
    const looksLikeAKey = "sk-" + "a".repeat(40);
    await expect(installCmd({ path: root, apiKeyFile: looksLikeAKey }, VERSION)).rejects.toThrow(InstallError);
    expect(existsSync(configIn(root))).toBe(false);
  });

  it("does not put the refused key in the error message", async () => {
    const looksLikeAKey = "sk-" + "b".repeat(40);
    try {
      await installCmd({ path: root, apiKeyFile: looksLikeAKey }, VERSION);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(looksLikeAKey);
    }
  });

  it("writes the path, so the config carries no secret", async () => {
    await installCmd({ path: root, db: "https://host/db", apiKeyFile: "/home/me/.infino/key" }, VERSION);
    const text = readFileSync(configIn(root), "utf8");
    expect(text).toContain("/home/me/.infino/key");
    expect(text).toContain("--api-key-file");
  });
});

describe("cx install: refusing what it cannot understand", () => {
  it("refuses a config that is not valid JSON rather than overwriting it", async () => {
    const path = configIn(root);
    writeFileSync(path, "{ not json, // comments\n");
    await expect(installCmd({ path: root }, VERSION)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ not json, // comments\n");
  });

  it("refuses a config whose top level is not an object", async () => {
    writeFileSync(configIn(root), JSON.stringify(["an", "array"]));
    await expect(installCmd({ path: root }, VERSION)).rejects.toThrow(/not a JSON object/);
  });

  it("refuses an mcpServers block that is not an object", async () => {
    writeFileSync(configIn(root), JSON.stringify({ mcpServers: [] }));
    await expect(installCmd({ path: root }, VERSION)).rejects.toThrow(/not an object of servers/);
  });

  it("treats an empty file as no config at all", async () => {
    writeFileSync(configIn(root), "   \n");
    await installCmd({ path: root }, VERSION);
    expect(read(configIn(root)).mcpServers["code-context"]).toBeDefined();
  });
});

describe("cx install: not damaging the user's file", () => {
  it("writes through a symlink, leaving it a symlink", async () => {
    const real = join(root, "real.json");
    const link = join(root, "link.json");
    writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    symlinkSync(real, link);
    await installCmd({ path: root, config: link }, VERSION);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real).mcpServers["code-context"]).toBeDefined();
    expect(read(real).mcpServers.other).toEqual({ command: "keep" });
  });

  it("leaves no temp file behind", async () => {
    await installCmd({ path: root }, VERSION);
    const strays = readFileSync(configIn(root), "utf8");
    expect(strays).toBeTruthy();
    expect(existsSync(`${configIn(root)}.${process.pid}.cx-tmp`)).toBe(false);
  });
});

describe("cx install --uninstall", () => {
  it("removes our entry and keeps the others", async () => {
    writeFileSync(
      configIn(root),
      JSON.stringify({ mcpServers: { "code-context": { command: "npx" }, other: { command: "keep" } } }),
    );
    await installCmd({ path: root, uninstall: true }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(servers["code-context"]).toBeUndefined();
    expect(servers.other).toEqual({ command: "keep" });
  });

  it("is a no-op when there is nothing of ours to remove", async () => {
    writeFileSync(configIn(root), JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    const before = readFileSync(configIn(root), "utf8");
    await installCmd({ path: root, uninstall: true }, VERSION);
    expect(readFileSync(configIn(root), "utf8")).toBe(before);
  });

  it("removes only the named entry", async () => {
    await installCmd({ path: root }, VERSION);
    await installCmd({ path: root, name: "supergrep" }, VERSION);
    await installCmd({ path: root, name: "supergrep", uninstall: true }, VERSION);
    const servers = read(configIn(root)).mcpServers;
    expect(servers["code-context"]).toBeDefined();
    expect(servers.supergrep).toBeUndefined();
  });
});

describe("cx install: no flags, with an account stored", () => {
  /** A platform that answers `POST /v1/databases`, recording what it was asked. */
  const platform = (status: number, body = "{}") => {
    const calls: Array<{ url: string; method: string; auth: string | undefined; body: string | undefined }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.get("authorization") ?? undefined,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  it("registers the repository's own database and writes only --db", async () => {
    signIn("https://platform.example");
    const { impl, calls } = platform(201);
    await installCmd({ path: root }, VERSION, { fetch: impl });

    // The database is the repo's directory name, and it was created for us.
    const database = root.split("/").pop()!.replace(/[^A-Za-z0-9_-]/g, "-");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://platform.example/v1/databases");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe(JSON.stringify({ name: database }));
    expect(calls[0].auth).toBe("Bearer inf_deadbeef_secret");

    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.args).toContain("--db");
    expect(entry.args[entry.args.indexOf("--db") + 1]).toBe(`https://platform.example/${database}`);
    // The whole point: no key, and no path to one, in a file that gets
    // committed. The server resolves the key from the stored account itself.
    expect(entry.args).not.toContain("--api-key-file");
    expect(JSON.stringify(entry)).not.toContain("inf_deadbeef");
  });

  it("treats a database that already exists as success, not an error", async () => {
    signIn("https://platform.example");
    const { impl } = platform(409, JSON.stringify({ message: "database already exists" }));
    await installCmd({ path: root }, VERSION, { fetch: impl });
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.args).toContain("--db");
  });

  it("falls back to local tools when the account cannot pay, rather than writing an entry that always fails", async () => {
    signIn("https://platform.example");
    const { impl } = platform(402, JSON.stringify({ message: "onboarding required" }));
    await installCmd({ path: root }, VERSION, { fetch: impl });
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.args).not.toContain("--db");
  });

  it("still writes the platform entry when the call merely failed", async () => {
    signIn("https://platform.example");
    // A 503 is transient: the database may well be registrable a minute later,
    // and the first `cx index` retries. Refusing the entry would be worse.
    const { impl } = platform(503, JSON.stringify({ message: "starting" }));
    await installCmd({ path: root }, VERSION, { fetch: impl });
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.args).toContain("--db");
  });

  it("writes a local-only entry and makes no call when nothing is signed in", async () => {
    const { impl, calls } = platform(201);
    await installCmd({ path: root }, VERSION, { fetch: impl });
    expect(calls).toHaveLength(0);
    expect(read(configIn(root)).mcpServers["code-context"].args).not.toContain("--db");
  });

  it("--local-only ignores the stored account and contacts nothing", async () => {
    signIn("https://platform.example");
    const { impl, calls } = platform(201);
    await installCmd({ path: root, localOnly: true }, VERSION, { fetch: impl });
    expect(calls).toHaveLength(0);
    expect(read(configIn(root)).mcpServers["code-context"].args).not.toContain("--db");
  });

  it("an explicit --db wins over the stored account and registers nothing", async () => {
    signIn("https://platform.example");
    const { impl, calls } = platform(201);
    await installCmd({ path: root, db: "https://other.example/mine" }, VERSION, { fetch: impl });
    expect(calls).toHaveLength(0);
    const entry = read(configIn(root)).mcpServers["code-context"];
    expect(entry.args[entry.args.indexOf("--db") + 1]).toBe("https://other.example/mine");
  });

  it("--dry-run with an account writes nothing and registers nothing", async () => {
    signIn("https://platform.example");
    const { impl, calls } = platform(201);
    await installCmd({ path: root, dryRun: true }, VERSION, { fetch: impl });
    expect(calls).toHaveLength(0);
    expect(existsSync(configIn(root))).toBe(false);
  });
});

describe("cx install: nothing is uploaded without consent", () => {
  const platform = () => {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };
  const dbOf = (dir: string) => {
    const args: string[] = read(configIn(dir)).mcpServers["code-context"].args;
    return args.includes("--db") ? args[args.indexOf("--db") + 1] : undefined;
  };

  it("registers nothing and enables nothing when the answer is no", async () => {
    signIn("https://platform.example", false);
    const { impl, calls } = platform();
    await installCmd({ path: root }, VERSION, {
      fetch: impl,
      consent: { interactive: true, ask: async () => "n" },
    });
    expect(calls).toEqual([]);
    expect(dbOf(root)).toBeUndefined();
  });

  it("registers the database once the answer is yes", async () => {
    signIn("https://platform.example", false);
    const { impl, calls } = platform();
    await installCmd({ path: root }, VERSION, {
      fetch: impl,
      consent: { interactive: true, ask: async () => "y", now: () => new Date("2026-09-08T12:00:00Z") },
    });
    expect(calls).toEqual(["POST https://platform.example/v1/databases"]);
    expect(dbOf(root)).toContain("https://platform.example/");
  });

  it("with no terminal, stays local and says how to proceed rather than uploading", async () => {
    signIn("https://platform.example", false);
    const { impl, calls } = platform();
    await installCmd({ path: root }, VERSION, { fetch: impl, consent: { interactive: false } });
    expect(calls).toEqual([]);
    expect(dbOf(root)).toBeUndefined();
  });

  it("--yes agrees without a terminal, and records it so nothing asks again", async () => {
    signIn("https://platform.example", false);
    const { impl, calls } = platform();
    await installCmd({ path: root, yes: true }, VERSION, { fetch: impl, consent: { interactive: false } });
    expect(calls).toEqual(["POST https://platform.example/v1/databases"]);
    expect(JSON.parse(readFileSync(join(accountDir, "account.json"), "utf8")).uploadConsentAt).toBeTruthy();
  });

  it("asks nothing when an explicit --db was given: naming a database is the decision", async () => {
    signIn("https://platform.example", false);
    let asked = false;
    await installCmd({ path: root, db: "https://other.example/mine" }, VERSION, {
      consent: {
        interactive: true,
        ask: async () => {
          asked = true;
          return "n";
        },
      },
    });
    expect(asked).toBe(false);
    expect(dbOf(root)).toBe("https://other.example/mine");
  });

  it("asks nothing on --dry-run, which uploads nothing by definition", async () => {
    signIn("https://platform.example", false);
    let asked = false;
    await installCmd({ path: root, dryRun: true }, VERSION, {
      consent: {
        interactive: true,
        ask: async () => {
          asked = true;
          return "y";
        },
      },
    });
    expect(asked).toBe(false);
    expect(existsSync(configIn(root))).toBe(false);
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
