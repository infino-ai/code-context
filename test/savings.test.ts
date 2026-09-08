import { describe, expect, it } from "vitest";
import { savingsFrom } from "../src/commands/savings-cmd.js";
import type { UsageEntry } from "../src/core/usage.js";

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  ts: "2026-09-08T15:00:00.000Z",
  tool: "search",
  query: "q",
  returnedTokens: 0,
  ...over,
});

describe("savingsFrom", () => {
  it("counts every call's served tokens, which are measured", () => {
    const s = savingsFrom([
      entry({ tool: "find", returnedTokens: 100 }),
      entry({ tool: "sql", returnedTokens: 50 }),
      entry({ tool: "search", returnedTokens: 25, wholeFileTokens: 1000 }),
    ]);
    expect(s.queries).toBe(3);
    expect(s.servedTokens).toBe(175);
  });

  it("estimates only against calls that recorded a whole-file comparison", () => {
    // find's fair alternative is a grep and sql returns an aggregate, so
    // neither records a counterfactual - and counting them as avoided file
    // reads is exactly how this figure gets inflated.
    const s = savingsFrom([
      entry({ tool: "find", returnedTokens: 900 }),
      entry({ tool: "search", returnedTokens: 100, wholeFileTokens: 1600 }),
    ]);
    expect(s.measuredAgainst).toBe(1);
    expect(s.wholeFileTokens).toBe(1600);
    expect(s.servedOnMeasured).toBe(100);
    expect(s.avoidedTokens).toBe(1500);
  });

  it("treats a null comparison as absent, not as zero", () => {
    // null means nothing was stattable at query time - the files moved. A zero
    // there would report the whole served payload as avoided.
    const s = savingsFrom([entry({ returnedTokens: 40, wholeFileTokens: null })]);
    expect(s.measuredAgainst).toBe(0);
    expect(s.wholeFileTokens).toBe(0);
    expect(s.avoidedTokens).toBe(0);
  });

  it("never reports a negative saving", () => {
    // A hit set larger than the files it came from (overlapping windows) must
    // floor at zero rather than print a negative.
    const s = savingsFrom([entry({ returnedTokens: 500, wholeFileTokens: 100 })]);
    expect(s.avoidedTokens).toBe(0);
  });

  it("is empty on an empty ledger", () => {
    const s = savingsFrom([]);
    expect(s).toMatchObject({ queries: 0, servedTokens: 0, measuredAgainst: 0, avoidedTokens: 0 });
  });
});
