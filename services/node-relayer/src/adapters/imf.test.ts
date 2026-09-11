import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceUnavailableError } from "@agrifeed/sdk";
import { fetchImfPrice, parsePcpsPeriod } from "./imf.js";

describe("parsePcpsPeriod", () => {
  it("parses a real PCPS monthly period into the correct UTC month-end-adjacent date", () => {
    const date = parsePcpsPeriod("2026-M07");
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(6); // 0-indexed: July = 6
    expect(date.getUTCDate()).toBe(1);
  });

  it("rejects an unrecognized period format rather than guessing a date", () => {
    expect(() => parsePcpsPeriod("2026-07")).toThrow(SourceUnavailableError);
    expect(() => parsePcpsPeriod("not-a-period")).toThrow(SourceUnavailableError);
    expect(() => parsePcpsPeriod("")).toThrow(SourceUnavailableError);
  });
});

/** A real-shaped SDMX 3.0 jsondata response, matching the documented
 * structure imf.ts's own comment describes (confirmed live against the
 * real API during an earlier phase) -- not an arbitrary fixture. */
function sdmxResponse(observations: Record<string, [number | null]>, periods: string[]): unknown {
  return {
    data: {
      dataSets: [{ series: { "0:0:0:0": { observations } } }],
      structures: [{ dimensions: { observation: [{ values: periods.map((value) => ({ value })) }] } }],
    },
  };
}

describe("fetchImfPrice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the single indicator's latest real observation for a single-indicator commodity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sdmxResponse({ "0": [1200], "1": [1250] }, ["2026-M06", "2026-M07"])), { status: 200 })),
    );

    const result = await fetchImfPrice("COCOA");

    expect(result.source).toBe("IMF");
    expect(result.price).toBe("1250");
    expect(result.unit).toBe("USD/MT");
    expect(result.asOf.getUTCMonth()).toBe(6); // July
  });

  it("averages two indicators for COFFEE (PCOFFOTM + PCOFFROB), matching the documented special case", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        // First call is PCOFFOTM, second is PCOFFROB, per INDICATOR's order.
        const value = callCount === 1 ? 180 : 160;
        return new Response(JSON.stringify(sdmxResponse({ "0": [value] }, ["2026-M07"])), { status: 200 });
      }),
    );

    const result = await fetchImfPrice("COFFEE");

    expect(callCount).toBe(2);
    expect(result.price).toBe("170"); // (180+160)/2
    expect(result.unit).toBe("USD_cents/lb"); // COFFEE's indicators are cents/lb, not USD/MT
  });

  it("uses the OLDEST of the two coffee indicators' observation dates, never the newest", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        const period = callCount === 1 ? "2026-M07" : "2026-M05";
        return new Response(JSON.stringify(sdmxResponse({ "0": [100] }, [period])), { status: 200 });
      }),
    );

    const result = await fetchImfPrice("COFFEE");

    expect(result.asOf.getUTCMonth()).toBe(4); // May, the older of the two
  });

  it("rejects a commodity with no mapped PCPS indicator rather than guessing", async () => {
    await expect(fetchImfPrice("NOT_A_REAL_COMMODITY")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("throws SourceUnavailableError, never fabricating a price, on a real network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(fetchImfPrice("COCOA")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("throws SourceUnavailableError on a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    await expect(fetchImfPrice("COCOA")).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("skips a null observation and uses the most recent real one instead of fabricating a value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(sdmxResponse({ "0": [1200], "1": [null] }, ["2026-M06", "2026-M07"])), { status: 200 }),
      ),
    );

    const result = await fetchImfPrice("COCOA");

    // Index 1 (the most recent period) is null, so the real (non-null)
    // observation at index 0 must be used instead, not a fabricated
    // zero or the null value itself.
    expect(result.price).toBe("1200");
  });

  it("throws SourceUnavailableError when every observation is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sdmxResponse({ "0": [null] }, ["2026-M07"])), { status: 200 })),
    );

    await expect(fetchImfPrice("COCOA")).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});
