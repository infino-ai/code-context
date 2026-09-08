// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// What the model is told when the platform refuses a call. These strings are
// the whole of the user's experience of running out of credit or holding a
// dead key, and the model acts on them: told only a status code it concludes
// the server is broken and stops using the local tools too, which cost
// nothing and still work. So each refusal has to name its own fix, and say
// what is unaffected.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostedError } from "../src/core/hosted.js";
import { keyRefusedSteps, outOfCreditSteps, refusalHint } from "../src/mcp/server.js";
import { writeStoredAccount } from "../src/core/keystore.js";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "cx-refusal-")), "account");
  process.env.CX_ACCOUNT_DIR = dir;
});

afterEach(() => {
  delete process.env.CX_ACCOUNT_DIR;
});

const err = (status: number) => new HostedError("ask", status, "server said so");

describe("HostedError tells the three refusals apart", () => {
  it("reads 402 as payment required and 401 as unauthenticated, and neither as the other", () => {
    expect(err(402).paymentRequired).toBe(true);
    expect(err(402).unauthenticated).toBe(false);
    expect(err(402).atCapacity).toBe(false);
    expect(err(401).unauthenticated).toBe(true);
    expect(err(401).paymentRequired).toBe(false);
    expect(err(429).atCapacity).toBe(true);
    expect(err(429).paymentRequired).toBe(false);
    expect(err(403).paymentRequired).toBe(false);
    expect(err(403).unauthenticated).toBe(false);
  });
});

describe("the out-of-credit message", () => {
  it("says to add details and a card to the same account, and where", () => {
    writeStoredAccount({ baseUrl: "https://platform.example", consoleUrl: "https://console.example", storedAt: "" });
    const text = outOfCreditSteps();
    expect(text).toContain("no credit left");
    expect(text).toContain("billing details and a card");
    expect(text).toContain("this same account");
    expect(text).toContain("https://console.example");
  });

  it("says which tools still work, so the model does not abandon all five", () => {
    const text = outOfCreditSteps();
    expect(text).toContain("find, search and sql keep working");
    expect(text).toContain("ask and explore need a balance");
  });

  it("does not tell the user to reinstall or sign up again", () => {
    const text = outOfCreditSteps();
    expect(text).toContain("nothing needs reinstalling");
    expect(text).not.toMatch(/sign ?up/i);
    expect(text).not.toMatch(/new account/i);
  });

  it("falls back to naming the console generically when none was stored", () => {
    expect(outOfCreditSteps()).toContain("the Infino console");
  });
});

describe("the refused-key message", () => {
  it("names the file and the command, and separates itself from a billing problem", () => {
    const text = keyRefusedSteps();
    expect(text).toContain("cx login");
    expect(text).toContain("mode 600");
    expect(text).toContain("find, search and sql are unaffected");
    expect(text).not.toMatch(/credit|card|billing/i);
  });
});

describe("refusalHint routes each status to its own fix", () => {
  it("gives 402 the billing steps and 401 the sign-in steps", () => {
    expect(refusalHint(err(402))).toContain("billing details and a card");
    expect(refusalHint(err(401))).toContain("cx login");
    expect(refusalHint(err(429))).toContain("at capacity");
  });

  it("adds nothing to a status whose own message is already the whole story", () => {
    expect(refusalHint(err(500))).toBe("");
    expect(refusalHint(err(0))).toBe("");
    expect(refusalHint(new Error("not a hosted failure"))).toBe("");
  });

  it("never conflates the two credential failures", () => {
    // 401 is a key problem and 402 is a money problem; a user sent to the
    // wrong one wastes their time on the wrong fix.
    expect(refusalHint(err(401))).not.toMatch(/credit|card/i);
    expect(refusalHint(err(402))).not.toContain("cx login");
  });
});
