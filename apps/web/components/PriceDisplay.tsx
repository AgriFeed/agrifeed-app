import { formatPriceWithUnit } from "@agrifeed/sdk";

/**
 * Shared price presentation primitive (Phase 3 Step 7). Always monospace,
 * always with its unit — per DESIGN.md, a price is never shown without the
 * context needed to read it, and every price in the app should render
 * through this component rather than a bare formatPriceWithUnit() call in
 * page markup.
 */
export function PriceDisplay({
  raw,
  decimals,
  symbol,
  className = "",
}: {
  raw: string;
  decimals: number;
  symbol: string;
  className?: string;
}) {
  return <span className={`font-mono ${className}`}>{formatPriceWithUnit(raw, decimals, symbol)}</span>;
}
