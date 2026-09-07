/**
 * Converts a source's reported unit into USD/MT, the unit every AgriFeed
 * commodity is displayed in (see packages/sdk/src/format.ts's
 * COMMODITY_UNITS). This is ordinary decimal unit conversion on small
 * external numbers, not the on-chain i128 price, so plain floating point
 * is the right tool here (unlike formatPrice/parseAmountToRaw, which
 * exist specifically because i128 values can exceed
 * Number.MAX_SAFE_INTEGER).
 */
const LB_PER_METRIC_TONNE = 2204.622622;

export function toUsdPerMetricTonne(price: number, unit: string): number {
  switch (unit) {
    case "USD/MT":
      return price;
    case "USD_cents/lb":
      return (price / 100) * LB_PER_METRIC_TONNE;
    default:
      throw new Error(`unrecognized source unit "${unit}"`);
  }
}
