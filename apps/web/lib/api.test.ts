import { afterEach, describe, expect, it, vi } from "vitest";
import { getCommodityHistory } from "./api";

/**
 * Regression coverage for F-06: /commodity/[symbol] reads contributingNodes
 * straight off getCommodityHistory's response, so this asserts the client
 * actually surfaces real per-finalization node addresses returned by the
 * indexer's fixed /commodities/:symbol/history endpoint, not the aggregate
 * count and not an always-empty array. This is a wire-format contract test:
 * it does not stand up the indexer, matching this repo's existing api.ts
 * test boundary (no server / no page-rendering harness is set up here).
 */
describe("getCommodityHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes through the exact per-finalization contributing node addresses the indexer returns", async () => {
    const nodeA = "GCG3CEYVBAH3DD33AM76A3BGEYWUDNS2F5HNOWHXL3MU6KXSGUQREIWD";
    const nodeB = "GDIFFERENTNODE00000000000000000000000000000000000000000";
    const payload = {
      symbol: "COCOA",
      decimals: 7,
      history: [{ price: "618800", timestamp: "2026-09-07T15:49:32.000Z" }],
      finalizations: [
        {
          price: "618800",
          timestamp: "2026-09-07T15:49:32.000Z",
          contributingNodes: [nodeA, nodeB],
          txHash: "tx-latest",
        },
        {
          price: "600000",
          timestamp: "2026-09-06T15:49:32.000Z",
          contributingNodes: [nodeA],
          txHash: "tx-previous",
        },
      ],
      submissions: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCommodityHistory("COCOA");

    expect(result?.finalizations[0]?.contributingNodes).toEqual([nodeA, nodeB]);
    // Different finalizations can and do have different contributing sets;
    // asserting the second row separately catches a bug that would
    // (re)apply the latest finalization's contributors to every row.
    expect(result?.finalizations[1]?.contributingNodes).toEqual([nodeA]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/commodities/COCOA/history"),
      expect.anything(),
    );
  });

  it("returns null, not a fabricated empty history, for a 404 (unknown commodity)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unknown commodity" }), { status: 404 })),
    );

    const result = await getCommodityHistory("UNKNOWN");

    expect(result).toBeNull();
  });
});
