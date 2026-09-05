// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The ledger's platform telemetry helper: the answering call's round trip and
// metered tokens, read off the client after a platform call, attached to a
// usage entry and never to a tool result. A scripted fake fetch stands in for
// the platform.

import { describe, expect, it } from "vitest";
import { HostedDb } from "../src/core/hosted.js";
import { hostedTelemetry } from "../src/core/searcher.js";
import { sqlEntry, withPlatform } from "../src/core/usage.js";

const KEY = "inf_test_key_do_not_log";

function clientAnswering(headers: Record<string, string>) {
  const fetchImpl: typeof fetch = async () =>
    new Response("[]", { status: 200, headers: { "content-type": "application/json", ...headers } });
  return new HostedDb({ baseUrl: "https://api.example.test", database: "cx", apiKey: KEY }, { fetch: fetchImpl });
}

describe("hostedTelemetry", () => {
  it("reports the answering call's round trip and metered tokens", async () => {
    const hosted = clientAnswering({ "x-infino-read-tokens": "0.050" });
    expect(hostedTelemetry({ hosted })).toBeUndefined(); // nothing called yet
    await hosted.querySql("SELECT 1");
    const telemetry = hostedTelemetry({ hosted });
    expect(telemetry).toMatchObject({ readTokens: 0.05 });
    expect(telemetry!.rttMs).toBeGreaterThanOrEqual(0);
    expect(telemetry).not.toHaveProperty("writeTokens");
  });

  it("is undefined when there is no platform client", () => {
    expect(hostedTelemetry({})).toBeUndefined();
  });

  it("withPlatform attaches it to a ledger entry, and leaves a local entry alone", async () => {
    const hosted = clientAnswering({ "x-infino-write-tokens": "2.000" });
    await hosted.querySql("SELECT 1");
    const entry = withPlatform(sqlEntry("SELECT 1", []), { hosted });
    expect(entry.platform).toMatchObject({ writeTokens: 2 });
    expect(withPlatform(sqlEntry("SELECT 1", []), {}).platform).toBeUndefined();
  });
});
