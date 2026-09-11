import { describe, expect, it } from "vitest";
import { toUsdPerMetricTonne } from "./units.js";

describe("toUsdPerMetricTonne", () => {
  it("passes USD/MT through unchanged", () => {
    expect(toUsdPerMetricTonne(2544.8, "USD/MT")).toBe(2544.8);
  });

  it("converts US cents/lb to USD/MT using the real metric-tonne conversion factor", () => {
    // 100 cents/lb -> $1/lb -> $1 * 2204.622622 lb/MT = $2204.622622/MT.
    const result = toUsdPerMetricTonne(100, "USD_cents/lb");
    expect(result).toBeCloseTo(2204.622622, 5);
  });

  it("converts a real IMF-shaped coffee price (cents/lb) to a plausible USD/MT figure", () => {
    // A real-order-of-magnitude coffee price, ~180 cents/lb.
    const result = toUsdPerMetricTonne(180, "USD_cents/lb");
    expect(result).toBeCloseTo((180 / 100) * 2204.622622, 5);
  });

  it("rejects an unrecognized unit rather than guessing a conversion", () => {
    expect(() => toUsdPerMetricTonne(100, "EUR/kg")).toThrow(/unrecognized source unit/);
  });

  it("rejects an empty unit string", () => {
    expect(() => toUsdPerMetricTonne(100, "")).toThrow(/unrecognized source unit/);
  });
});
