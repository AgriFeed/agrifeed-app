import type { Asset, FormattedPrice } from "./types.js";

/**
 * Formats a raw i128 price string (scaled by `10^decimals`) as a decimal
 * string, using integer-safe string manipulation only. `i128` values can
 * exceed Number.MAX_SAFE_INTEGER, so this never casts through a JS number.
 */
export function formatPrice(raw: string | bigint, decimals: number): FormattedPrice {
  const negative = typeof raw === "bigint" ? raw < 0n : raw.trim().startsWith("-");
  const digits = (typeof raw === "bigint" ? raw.toString() : raw.trim()).replace("-", "");
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : "";

  const wholeWithCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted =
    (negative ? "-" : "") + wholeWithCommas + (fraction ? `.${fraction}` : "");

  return {
    formatted,
    raw: (negative ? "-" : "") + digits,
    decimals,
  };
}

/** Renders an Asset as its display symbol, e.g. `Other("COCOA")` -> `COCOA`. */
export function assetSymbol(asset: Asset): string {
  return asset.values[0];
}

/**
 * Every commodity on AgriFeed has an implied unit for display purposes.
 * The oracle contract itself is unit-agnostic; this mapping exists only
 * so the frontend can show `6,188.00 USD/MT` instead of a bare number.
 * Extend this when a new commodity is added via `add_commodity`.
 */
const COMMODITY_UNITS: Record<string, string> = {
  COCOA: "USD/MT",
  COFFEE: "USD/MT",
  WHEAT: "USD/MT",
  MAIZE: "USD/MT",
  RICE: "USD/MT",
  SOYBEAN: "USD/MT",
  SUGAR: "USD/MT",
  COTTON: "USD/MT",
};

export function commodityUnit(symbol: string): string {
  return COMMODITY_UNITS[symbol] ?? "USD/unit";
}

export function formatPriceWithUnit(
  raw: string | bigint,
  decimals: number,
  symbol: string,
): string {
  return `${formatPrice(raw, decimals).formatted} ${commodityUnit(symbol)}`;
}
