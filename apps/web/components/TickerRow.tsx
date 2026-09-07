import Link from "next/link";
import { formatPriceWithUnit } from "@agrifeed/sdk";
import type { CommodityTicker } from "@/lib/api";
import { relativeAge } from "@/lib/time";

function delta(price: string, previous: string): "up" | "down" | "flat" {
  // Compare as BigInt, both are raw i128 strings on the same decimals scale.
  const a = BigInt(price);
  const b = BigInt(previous);
  if (a > b) return "up";
  if (a < b) return "down";
  return "flat";
}

const ARROW: Record<"up" | "down" | "flat", string> = {
  up: "▲",
  down: "▼",
  flat: "–",
};

const COLOR: Record<"up" | "down" | "flat", string> = {
  up: "text-price-up",
  down: "text-price-down",
  flat: "text-ink-muted",
};

export function TickerRow({ commodity }: { commodity: CommodityTicker }) {
  if (!commodity.sourceAvailable || !commodity.price || !commodity.priceTimestamp) {
    return (
      <div className="ticker-row">
        <span className="font-mono text-sm text-ink-primary">{commodity.symbol}</span>
        <span className="text-sm text-ink-muted">source unavailable</span>
      </div>
    );
  }

  const direction = commodity.previousPrice ? delta(commodity.price, commodity.previousPrice) : "flat";

  return (
    <Link href={`/commodity/${commodity.symbol}`} className="ticker-row">
      <span className="font-mono text-sm font-medium text-ink-primary">{commodity.symbol}</span>
      <span className="font-mono text-sm text-ink-primary">
        {formatPriceWithUnit(commodity.price, commodity.decimals, commodity.symbol)}
      </span>
      <span className={`font-mono text-sm ${COLOR[direction]}`}>{ARROW[direction]}</span>
      <span className="font-mono text-xs text-ink-muted">
        {commodity.nodesReporting}/{commodity.nodesTotal} nodes
      </span>
      <span className="font-mono text-xs text-ink-muted">{relativeAge(commodity.priceTimestamp)}</span>
    </Link>
  );
}
