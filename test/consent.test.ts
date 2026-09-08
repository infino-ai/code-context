// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Consent to uploading a repository's contents. The failure that matters here
// is not a crash: it is a repository uploaded by someone who did not
// understand that is what they agreed to, or by nobody at all. So the tests
// are about the wording naming what leaves, and about the default with no
// person present being no.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askUploadConsent, consentNotice, hasUploadConsent, recordUploadConsent } from "../src/core/consent.js";
import { readStoredAccount, writeStoredAccount } from "../src/core/keystore.js";

const PLATFORM = "https://platform.example";
let dir: string;
let printed: string[];

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "cx-consent-")), "account");
  process.env.CX_ACCOUNT_DIR = dir;
  printed = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    printed.push(String(m ?? ""));
  });
  writeStoredAccount({ baseUrl: PLATFORM, storedAt: "2026-09-08T00:00:00.000Z" });
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
  vi.restoreAllMocks();
});

describe("the notice", () => {
  it("says the file contents go, not 'data'", () => {
    const text = consentNotice(PLATFORM, "my-repo", "/home/me/code");
    expect(text).toContain("text of the files");
    expect(text).toContain("/home/me/code");
    expect(text).toContain("my-repo");
    expect(text).toContain(PLATFORM);
    // "sends data" reads as telemetry to anyone skimming, which is the exact
    // misunderstanding this text exists to prevent.
    expect(text).not.toMatch(/sends? data\b/);
  });

  it("says which tools do not upload, and that no is a working outcome", () => {
    const text = consentNotice(PLATFORM, "my-repo", "/home/me/code");
    expect(text).toContain("find, search and sql do not");
    expect(text).toContain("send nothing anywhere");
    expect(text).toContain("keep working if you say no");
  });

  it("tells someone whose code it is not to decline", () => {
    expect(consentNotice(PLATFORM, "r", "/r")).toContain("not yours to upload");
  });
});

describe("asking", () => {
  const ask = (answer: string) => ({ interactive: true, ask: async () => answer, now: () => new Date("2026-09-08T12:00:00Z") });

  it("takes y as yes and records when", async () => {
    expect(await askUploadConsent(PLATFORM, "r", "/r", ask("y"))).toBe("granted");
    expect(readStoredAccount()?.uploadConsentAt).toBe("2026-09-08T12:00:00.000Z");
    expect(hasUploadConsent()).toBe(true);
  });

  it("takes yes, and is not case-sensitive", async () => {
    expect(await askUploadConsent(PLATFORM, "r", "/r", ask("YES"))).toBe("granted");
  });

  it("treats everything else as no, including a bare return", async () => {
    for (const answer of ["", "n", "no", "N", "maybe", " "]) {
      writeStoredAccount({ baseUrl: PLATFORM, storedAt: "" });
      expect(await askUploadConsent(PLATFORM, "r", "/r", ask(answer))).toBe("declined");
      expect(hasUploadConsent()).toBe(false);
    }
  });

  it("asks once per machine, not once per repository", async () => {
    expect(await askUploadConsent(PLATFORM, "first", "/a", ask("y"))).toBe("granted");
    let asked = false;
    const outcome = await askUploadConsent(PLATFORM, "second", "/b", {
      interactive: true,
      ask: async () => {
        asked = true;
        return "n";
      },
    });
    expect(outcome).toBe("already-given");
    expect(asked).toBe(false);
  });

  it("does not print the notice when consent was already given", async () => {
    await askUploadConsent(PLATFORM, "r", "/r", ask("y"));
    printed = [];
    await askUploadConsent(PLATFORM, "r2", "/r2", ask("y"));
    expect(printed).toEqual([]);
  });

  it("prints the notice before the question, not after", async () => {
    const order: string[] = [];
    vi.mocked(console.log).mockImplementation((m?: unknown) => {
      order.push(`print:${String(m ?? "").slice(0, 20)}`);
    });
    await askUploadConsent(PLATFORM, "r", "/r", {
      interactive: true,
      ask: async () => {
        order.push("asked");
        return "y";
      },
    });
    expect(order[0]).toContain("print:");
    expect(order[order.length - 1]).toBe("asked");
  });
});

describe("with nobody at the terminal", () => {
  it("answers no rather than assuming yes", async () => {
    // `cx install` gets run by dotfiles scripts and CI. An unattended default
    // of yes would upload a repository nobody chose to upload.
    expect(await askUploadConsent(PLATFORM, "r", "/r", { interactive: false })).toBe("no-terminal");
    expect(hasUploadConsent()).toBe(false);
  });

  it("asks nothing, so it cannot block waiting for input", async () => {
    let asked = false;
    await askUploadConsent(PLATFORM, "r", "/r", {
      interactive: false,
      ask: async () => {
        asked = true;
        return "y";
      },
    });
    expect(asked).toBe(false);
  });

  it("still short-circuits to already-given when consent is on file", async () => {
    recordUploadConsent("2026-09-01T00:00:00.000Z");
    expect(await askUploadConsent(PLATFORM, "r", "/r", { interactive: false })).toBe("already-given");
  });
});

describe("recording", () => {
  it("cannot record against an account that is not there", () => {
    process.env.CX_ACCOUNT_DIR = join(dir, "nope");
    expect(recordUploadConsent("2026-09-08T00:00:00.000Z")).toBe(false);
  });

  it("leaves the rest of the account untouched", () => {
    writeStoredAccount({ baseUrl: PLATFORM, consoleUrl: "https://console.example", storedAt: "then" });
    recordUploadConsent("2026-09-08T00:00:00.000Z");
    expect(readStoredAccount()).toEqual({
      baseUrl: PLATFORM,
      consoleUrl: "https://console.example",
      storedAt: "then",
      uploadConsentAt: "2026-09-08T00:00:00.000Z",
    });
  });
});
