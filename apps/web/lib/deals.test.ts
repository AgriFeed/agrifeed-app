import { afterEach, describe, expect, it, vi } from "vitest";
import { commoditySymbol, loadMyDeals, mergeDealsByRole } from "./deals";
import type { Deal } from "./api";

const FARMER = "GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62";
const BUYER = "GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3";

function makeDeal(overrides: Partial<Deal> & { contractId: string }): Deal {
  return {
    status: "registered",
    farmer: null,
    buyer: null,
    commodity: null,
    floorPrice: null,
    notional: null,
    settlementToken: null,
    maturityTs: null,
    oracleContractId: null,
    registeredAt: "2026-09-01T00:00:00.000Z",
    registeredAtLedger: 1,
    initializedAt: null,
    fundedAt: null,
    settledAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe("mergeDealsByRole", () => {
  it("tags a farmer-only deal 'farmer' and a buyer-only deal 'buyer'", () => {
    const farmerDeal = makeDeal({ contractId: "C1", registeredAt: "2026-09-01T00:00:00.000Z" });
    const buyerDeal = makeDeal({ contractId: "C2", registeredAt: "2026-09-02T00:00:00.000Z" });

    const merged = mergeDealsByRole([farmerDeal], [buyerDeal]);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.deal.contractId === "C1")?.role).toBe("farmer");
    expect(merged.find((m) => m.deal.contractId === "C2")?.role).toBe("buyer");
  });

  it("tags a deal present in both result sets 'both' exactly once, never duplicated", () => {
    const deal = makeDeal({ contractId: "C1" });
    const merged = mergeDealsByRole([deal], [deal]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.role).toBe("both");
  });

  it("orders most recently registered first, across both result sets", () => {
    const older = makeDeal({ contractId: "OLD", registeredAt: "2026-09-01T00:00:00.000Z" });
    const newer = makeDeal({ contractId: "NEW", registeredAt: "2026-09-05T00:00:00.000Z" });
    const merged = mergeDealsByRole([older], [newer]);
    expect(merged.map((m) => m.deal.contractId)).toEqual(["NEW", "OLD"]);
  });

  it("returns an empty list, not an error, for two empty result sets", () => {
    expect(mergeDealsByRole([], [])).toEqual([]);
  });
});

describe("loadMyDeals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries /api/deals for both farmer and buyer, and merges what comes back", async () => {
    const asFarmer = makeDeal({ contractId: "C-FARMER" });
    const asBuyer = makeDeal({ contractId: "C-BUYER" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("farmer=")) return new Response(JSON.stringify({ deals: [asFarmer] }), { status: 200 });
      if (url.includes("buyer=")) return new Response(JSON.stringify({ deals: [asBuyer] }), { status: 200 });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadMyDeals(FARMER);
    expect(result.map((r) => r.deal.contractId).sort()).toEqual(["C-BUYER", "C-FARMER"]);
  });

  it("returns an empty list, not an error, when the address has no deals at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ deals: [] }), { status: 200 })));
    expect(await loadMyDeals(FARMER)).toEqual([]);
  });

  it("propagates an API failure rather than resolving to an empty portfolio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(loadMyDeals(FARMER)).rejects.toThrow();
  });

  it(
    "never surfaces a deal from localStorage: seeding a fabricated deal there has no effect on the result, " +
      "only what the mocked /api/deals response actually returned appears",
    async () => {
      const realDeal = makeDeal({ contractId: "REAL-FROM-API" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ deals: [realDeal] }), { status: 200 })));

      const fakeDeal = makeDeal({ contractId: "FAKE-FROM-LOCALSTORAGE" });
      const store: Record<string, string> = { myDeals: JSON.stringify([fakeDeal]), deals: JSON.stringify([fakeDeal]) };
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => store[key] ?? null,
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } as unknown as Storage);

      const result = await loadMyDeals(FARMER);
      expect(result.map((r) => r.deal.contractId)).toEqual(["REAL-FROM-API"]);
      expect(result.some((r) => r.deal.contractId === "FAKE-FROM-LOCALSTORAGE")).toBe(false);
    },
  );
});

describe("commoditySymbol", () => {
  it("reads the real indexed shape: a 2-element [tag, symbol] tuple", () => {
    expect(commoditySymbol(["Other", "COCOA"])).toBe("COCOA");
  });

  it("returns null for null (registered but not yet initialized, per the schema)", () => {
    expect(commoditySymbol(null)).toBeNull();
  });

  it("returns null rather than guessing for an unrecognized shape", () => {
    expect(commoditySymbol({ tag: "Other", values: ["COCOA"] })).toBeNull();
    expect(commoditySymbol("COCOA")).toBeNull();
    expect(commoditySymbol(["Other"])).toBeNull();
  });
});
