import { getCommodities, IndexerUnavailableError, type CommodityTicker } from "@/lib/api";
import { TickerRow } from "@/components/TickerRow";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { EmptyState } from "@/components/EmptyState";
import { StaleBanner } from "@/components/StaleBanner";

export const dynamic = "force-dynamic";

// Mirrors TickerRow's own conservative default — see its comment for why
// this isn't derived from the oracle's actual per-commodity resolution.
const STALE_AFTER_SECONDS = 2 * 60 * 60;

function isStale(commodity: CommodityTicker): boolean {
  if (!commodity.sourceAvailable || !commodity.priceTimestamp) return false;
  const ageSeconds = (Date.now() - new Date(commodity.priceTimestamp).getTime()) / 1000;
  return ageSeconds > STALE_AFTER_SECONDS;
}

export default async function HomePage() {
  let commodities: CommodityTicker[];
  try {
    commodities = await getCommodities();
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <Header />
          <div className="mt-8">
            <SourceUnavailable what="Commodity prices" />
          </div>
        </main>
      );
    }
    throw err;
  }

  const withPrices = commodities.filter((c) => c.sourceAvailable);
  const allStale = withPrices.length > 0 && withPrices.every(isStale);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header />

      {commodities.length === 0 ? (
        <div className="mt-8">
          <EmptyState>
            No commodities are tracked on the AgriFeedOracle contract yet. Once one is added via
            add_commodity, it will appear here automatically.
          </EmptyState>
        </div>
      ) : (
        <>
          <p className="mt-8 font-mono text-xs text-ink-muted">
            {commodities.length} commodit{commodities.length === 1 ? "y" : "ies"} tracked
          </p>

          {allStale && (
            <div className="mt-3">
              <StaleBanner>
                Every price below is older than expected. The indexer may be behind — the prices
                themselves are still the last real values recorded, not placeholders.
              </StaleBanner>
            </div>
          )}

          <div className="mt-3 flex flex-col gap-px">
            {commodities.map((commodity) => (
              <TickerRow key={commodity.symbol} commodity={commodity} />
            ))}
          </div>

          <Provenance />
        </>
      )}
    </main>
  );
}

function Header() {
  return (
    <div>
      <h1 className="font-display text-4xl text-ink-primary">AgriFeed</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Indexed agricultural commodity prices from the AgriFeedOracle contract on Stellar
        Testnet. Each price below shows how many reporting nodes fed into it and how long ago it
        was last updated.
      </p>
    </div>
  );
}

function Provenance() {
  return (
    <p className="mt-8 max-w-2xl border-t border-border pt-6 text-sm text-ink-muted">
      Prices are indexed from the oracle&apos;s on-chain finalization events, not read live on
      every visit — the age shown next to each price is how long ago the indexer last recorded an
      update. The node count is how many currently-authorized nodes reported into that price, not
      which specific nodes. Open a commodity for its full price history, each finalized price,
      and exactly which nodes contributed.
    </p>
  );
}
