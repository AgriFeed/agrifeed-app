import { describe, expect, it } from "vitest";
import { SourceUnavailableError } from "@agrifeed/sdk";
import { aggregatePrice } from "./aggregate.js";
import type { SourceAdapter, SourcePrice } from "../adapters/types.js";

/** A fake adapter conforming to the real SourceAdapter contract -- not a
 * mock of aggregatePrice's own dependencies, a genuine stand-in source
 * exercising aggregatePrice's real decision logic (median-of-N, oldest
 * timestamp, "never fabricate when everything fails") against
 * deterministic, controlled inputs. This is the same test-double pattern
 * multiparty.test.ts already uses for its own dependencies. */
function fakeSource(source: SourcePrice["source"], price: string, unit: string, asOf: Date): SourceAdapter {
  return async (commodity: string) => ({ source, commodity, price, unit, asOf });
}

function failingSource(message = "unavailable"): SourceAdapter {
  return async () => {
    throw new SourceUnavailableError("FAKE", message);
  };
}

const JAN1 = new Date("2026-01-01T00:00:00Z");
const FEB1 = new Date("2026-02-01T00:00:00Z");
const MAR1 = new Date("2026-03-01T00:00:00Z");

describe("aggregatePrice", () => {
  it("takes the exact middle value for an odd number of real sources", () => {
    const adapters = [
      fakeSource("FAO", "100", "USD/MT", JAN1),
      fakeSource("IMF", "200", "USD/MT", FEB1),
      fakeSource("FAO", "300", "USD/MT", MAR1),
    ];

    return aggregatePrice("COCOA", 2, adapters).then((result) => {
      expect(result.rawPrice).toBe("20000"); // 200.00 scaled by 10^2
    });
  });

  it("averages the two middle values for an even number of real sources", () => {
    const adapters = [fakeSource("FAO", "100", "USD/MT", JAN1), fakeSource("IMF", "200", "USD/MT", FEB1)];

    return aggregatePrice("COCOA", 2, adapters).then((result) => {
      expect(result.rawPrice).toBe("15000"); // (100+200)/2 = 150.00
    });
  });

  it("uses the single source's value when only one succeeds", () => {
    const adapters = [failingSource(), fakeSource("FAO", "618.8", "USD/MT", JAN1)];

    return aggregatePrice("COCOA", 2, adapters).then((result) => {
      expect(result.rawPrice).toBe("61880");
      expect(result.contributingSources).toEqual(["FAO"]);
    });
  });

  it("never fabricates a price when every source fails, matching this project's own stated rule", () => {
    const adapters = [failingSource("FAO down"), failingSource("IMF down")];

    return expect(aggregatePrice("COCOA", 2, adapters)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it(
    "uses the OLDEST contributing observation's date as source_ts, never the newest and never " +
      "the fetch time, so source_ts never overstates freshness",
    () => {
      const adapters = [
        fakeSource("FAO", "100", "USD/MT", MAR1),
        fakeSource("IMF", "200", "USD/MT", JAN1),
        fakeSource("FAO", "300", "USD/MT", FEB1),
      ];

      return aggregatePrice("COCOA", 2, adapters).then((result) => {
        expect(result.sourceTs).toBe(BigInt(Math.floor(JAN1.getTime() / 1000)));
      });
    },
  );

  it("converts each source's own unit to USD/MT before taking the median, not after", () => {
    // 100 USD/MT vs. 100 cents/lb (~2204.62 USD/MT): the median of two
    // very different raw numbers must reflect the converted values, not
    // the literal input numbers (which would coincidentally look equal).
    const adapters = [fakeSource("FAO", "100", "USD/MT", JAN1), fakeSource("IMF", "100", "USD_cents/lb", FEB1)];

    return aggregatePrice("COFFEE", 2, adapters).then((result) => {
      const expectedMedian = (100 + (100 / 100) * 2204.622622) / 2;
      expect(result.rawPrice).toBe(Math.round(expectedMedian * 100).toString());
    });
  });

  it("records exactly which sources actually contributed, excluding any that failed", () => {
    const adapters = [
      fakeSource("FAO", "100", "USD/MT", JAN1),
      failingSource(),
      fakeSource("IMF", "200", "USD/MT", FEB1),
    ];

    return aggregatePrice("COCOA", 2, adapters).then((result) => {
      expect(result.contributingSources.sort()).toEqual(["FAO", "IMF"]);
    });
  });

  it("scales the raw price by the given decimals precisely, never through float precision loss", () => {
    const adapters = [fakeSource("FAO", "6188.00", "USD/MT", JAN1)];

    return aggregatePrice("COCOA", 7, adapters).then((result) => {
      expect(result.rawPrice).toBe("61880000000");
    });
  });

  it("rejects a source reporting an unrecognized unit rather than guessing a conversion", () => {
    const adapters = [fakeSource("FAO", "100", "EUR/kg", JAN1)];
    return expect(aggregatePrice("COCOA", 2, adapters)).rejects.toThrow(/unrecognized source unit/);
  });
});
