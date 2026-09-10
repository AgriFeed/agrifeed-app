import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCommodityHistory,
  getPriceFloorInstance,
  getPriceFloorInstancesByBuyer,
  getPriceFloorInstancesByFarmer,
  IndexerUnavailableError,
  registerPriceFloorInstance,
} from "./api";

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

/**
 * Phase 4: the client side of registerPriceFloorInstance/getPriceFloorInstance*.
 * Deliberately asserts the real POST body/method and the real query-string
 * shape, and that a refusal's actual reason (from the indexer's own
 * verification, never fabricated by this client) survives into the thrown
 * error, not just a generic status message.
 */
describe("registerPriceFloorInstance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the contract id and returns the real registered instance", async () => {
    const contractId = "CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN";
    const instance = {
      contractId,
      status: "registered",
      farmer: null,
      buyer: null,
      commodity: null,
      floorPrice: null,
      notional: null,
      settlementToken: null,
      maturityTs: null,
      oracleContractId: null,
      registeredAt: "2026-09-10T10:19:20.748Z",
      registeredAtLedger: 4602394,
      initializedAt: null,
      fundedAt: null,
      settledAt: null,
      cancelledAt: null,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ instance }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerPriceFloorInstance(contractId);

    expect(result).toEqual(instance);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/pricefloor-instances");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ contractId });
  });

  it("surfaces the indexer's real refusal reason, not a generic status message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "contract was not deployed from the configured PriceFloor WASM hash" }),
            { status: 422 },
          ),
      ),
    );

    await expect(registerPriceFloorInstance("CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T")).rejects.toThrow(
      /not deployed from the configured PriceFloor WASM hash/,
    );
  });

  it("throws IndexerUnavailableError, distinguishable from a real refusal, when the indexer cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(registerPriceFloorInstance("CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN")).rejects.toBeInstanceOf(
      IndexerUnavailableError,
    );
  });
});

describe("getPriceFloorInstance / getPriceFloorInstancesByFarmer / getPriceFloorInstancesByBuyer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null, not a fabricated instance, for a 404 (never registered)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unknown" }), { status: 404 })));

    const result = await getPriceFloorInstance("CUNKNOWN0000000000000000000000000000000000000000000000");

    expect(result).toBeNull();
  });

  it("queries by farmer and buyer with the real address in the query string, never conflating the two", async () => {
    const farmer = "GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62";
    const buyer = "GABZIONIHNKUA2YLWDWESPJC7R23UQJ2GPM6CM4RSZJQ7VZ73WQ25AES";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ instances: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getPriceFloorInstancesByFarmer(farmer);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`farmer=${farmer}`);

    await getPriceFloorInstancesByBuyer(buyer);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(`buyer=${buyer}`);
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain("farmer=");
  });
});
