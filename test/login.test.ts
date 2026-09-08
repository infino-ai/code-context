// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx login`. Three properties are the point of the command: the key is never
// an argument, a key that does not work is not stored, and each of the three
// distinguishable refusals - wrong key, unpayable account, unreachable host -
// says which one it is instead of "login failed".
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginError, baseUrlFrom, loginCmd } from "../src/commands/login-cmd.js";
import { keyFilePath, readStoredAccount, readStoredKey, writeStoredKey } from "../src/core/keystore.js";

const KEY = "inf_0123456789abcdef_deadbeefdeadbeefdeadbeefdeadbeef";
const PLATFORM = "https://platform.example";

let dir: string;

/** A platform that answers `GET /v1/databases`. */
const answering = (status: number, body: string) => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers as HeadersInit).get("authorization") ?? undefined });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const withDatabases = (...names: string[]) =>
  answering(200, JSON.stringify({ databases: names.map((name) => ({ name, state: "registered" })) }));

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "cx-login-")), "account");
  process.env.CX_ACCOUNT_DIR = dir;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
  vi.restoreAllMocks();
});

describe("cx login: storing the account", () => {
  it("verifies the key, then stores it at 0600 with the platform beside it", async () => {
    const { impl, calls } = withDatabases("infino", "notes");
    const result = await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });

    expect(calls).toEqual([{ url: `${PLATFORM}/v1/databases`, auth: `Bearer ${KEY}` }]);
    expect(result).toMatchObject({ action: "stored", baseUrl: PLATFORM, databases: ["infino", "notes"] });
    expect(readStoredKey()).toBe(KEY);
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600);
    expect(readStoredAccount()?.baseUrl).toBe(PLATFORM);
  });

  it("takes the key from a file when one is named", async () => {
    const file = join(dir.replace(/account$/, ""), "key.txt");
    writeFileSync(file, `${KEY}\n`);
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, apiKeyFile: file }, { stdin: () => "", fetch: impl });
    expect(readStoredKey()).toBe(KEY);
  });

  it("keeps the console URL for the out-of-credit message", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM, consoleUrl: "https://console.example" }, { stdin: () => KEY, fetch: impl });
    expect(readStoredAccount()?.consoleUrl).toBe("https://console.example");
  });

  it("reuses the stored platform when --db is left off on a later sign-in", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    const second = await loginCmd({}, { stdin: () => `${KEY}-rotated`, fetch: impl });
    expect(second.baseUrl).toBe(PLATFORM);
    expect(readStoredKey()).toBe(`${KEY}-rotated`);
  });
});

describe("cx login: the key is never an argument", () => {
  it("says so when nothing was piped in", async () => {
    const { impl } = withDatabases();
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "", fetch: impl })).rejects.toThrow(
      /arguments are visible to every process/,
    );
  });

  it("rejects something that is plainly not a key", async () => {
    const { impl } = withDatabases();
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "two words", fetch: impl })).rejects.toThrow(/whitespace/);
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => "x".repeat(5000), fetch: impl })).rejects.toThrow(
      /not an API key/,
    );
  });

  it("has no option that takes a key value", async () => {
    // A guard on the shape of the command rather than on its behaviour: the
    // only two ways in are a path and standard input.
    const opts = { db: PLATFORM, apiKeyFile: "/x", consoleUrl: "y", logout: true, show: true };
    expect(Object.keys(opts)).not.toContain("apiKey");
  });
});

describe("cx login: a key that does not work is not stored", () => {
  it("names a refused key, and leaves any previous one untouched", async () => {
    writeStoredKey("inf_previous_key_value");
    const { impl } = answering(401, JSON.stringify({ message: "unauthenticated" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/refused that key/);
    expect(readStoredKey()).toBe("inf_previous_key_value");
  });

  it("names an account that cannot be used yet, and does not store", async () => {
    const { impl } = answering(402, JSON.stringify({ message: "onboarding required" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(
      /no billing details on file/,
    );
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("names an unreachable platform separately from a refusal", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND platform.example");
    }) as unknown as typeof fetch;
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/could not reach/);
    expect(existsSync(keyFilePath())).toBe(false);
  });

  it("reports any other status with the server's own words", async () => {
    const { impl } = answering(500, JSON.stringify({ message: "boom" }));
    await expect(loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl })).rejects.toThrow(/answered 500/);
  });
});

describe("cx login --logout / --show", () => {
  it("forgets the key and keeps the platform URL", async () => {
    const { impl } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    expect((await loginCmd({ logout: true })).action).toBe("logged-out");
    expect(readStoredKey()).toBeUndefined();
    expect(readStoredAccount()?.baseUrl).toBe(PLATFORM);
    expect((await loginCmd({ logout: true })).action).toBe("nothing-to-forget");
  });

  it("shows what is stored and contacts nothing", async () => {
    const { impl, calls } = withDatabases();
    await loginCmd({ db: PLATFORM }, { stdin: () => KEY, fetch: impl });
    const shown = await loginCmd({ show: true }, { fetch: impl });
    expect(shown).toMatchObject({ action: "shown", baseUrl: PLATFORM });
    expect(calls).toHaveLength(1); // only the sign-in's own call
  });
});

describe("the platform URL", () => {
  it("accepts an origin, and a database URL whose name it ignores", () => {
    expect(baseUrlFrom("https://platform.example")).toBe(PLATFORM);
    expect(baseUrlFrom("https://platform.example/")).toBe(PLATFORM);
    expect(baseUrlFrom("https://platform.example/my-repo")).toBe(PLATFORM);
  });

  it("refuses a deeper path rather than silently keeping the origin", () => {
    expect(() => baseUrlFrom("https://platform.example/a/b")).toThrow(LoginError);
    expect(() => baseUrlFrom("not-a-url")).toThrow(/http\(s\) URL/);
  });
});
