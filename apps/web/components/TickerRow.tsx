import Link from "next/link";
import type { CommodityTicker } from "@/lib/api";
import { PriceDisplay } from "@/components/PriceDisplay";
import { PriceChange } from "@/components/PriceChange";
import { Freshness } from "@/components/Freshness";
import { NodeCount } from "@/components/NodeCount";

// The oracle's per-commodity resolution (finalize_price's window) isn't
// currently exposed by the indexer's /commodities endpoint, so this is a
// deliberately conservative, resolution-agnostic default rather than a
// precise per-commodity threshold: flag a price as stale once it's
// noticeably older than a typical finalize window, without claiming to
// know that window exactly. Revisit once /commodities exposes resolution.
const STALE_AFTER_SECONDS = 2 * 60 * 60;

export function TickerRow({ commodity }: { commodity: CommodityTicker }) {
  if (!commodity.sourceAvailable || !commodity.price || !commodity.priceTimestamp) {
    return (
      <div className="ticker-row">
        <span className="font-mono text-sm font-medium text-ink-primary">{commodity.symbol}</span>
        <span className="text-sm text-ink-muted">source unavailable</span>
      </div>
    );
  }

  return (
    <Link
      href={`/commodity/${commodity.symbol}`}
      className="ticker-row flex-col items-stretch justify-start gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="flex items-baseline justify-between gap-4 sm:justify-start sm:gap-3">
        <span className="font-mono text-sm font-medium text-ink-primary">{commodity.symbol}</span>
        <PriceDisplay
          raw={commodity.price}
          decimals={commodity.decimals}
          symbol={commodity.symbol}
          className="text-base font-medium text-ink-primary sm:text-lg"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:ml-auto sm:justify-end">
        <PriceChange price={commodity.price} previousPrice={commodity.previousPrice} />
        <NodeCount reporting={commodity.nodesReporting} total={commodity.nodesTotal} />
        <Freshness timestamp={commodity.priceTimestamp} staleAfterSeconds={STALE_AFTER_SECONDS} interactive={false} />
      </div>
    </Link>
  );
}
