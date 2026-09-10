"use client";

import { useEffect, useState } from "react";
import { getCommodities } from "@/lib/api";
import { commoditySymbol, loadMyDeals, type DealWithRole } from "@/lib/deals";
import { WalletConnect } from "@/components/WalletConnect";
import { DealCard } from "@/components/DealCard";
import { EmptyState } from "@/components/EmptyState";
import { SourceUnavailable } from "@/components/SourceUnavailable";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; deals: DealWithRole[] }
  | { status: "error"; message: string };

/**
 * Looks up each deal's commodity decimals from the indexer's own
 * /commodities (the same indexed source TickerRow/NewDealFlow already use
 * for formatting), so floor price/notional render as real decimal amounts
 * rather than raw unscaled i128 strings. Best-effort: if this fails, deal
 * cards still render with "—" for the scaled amounts rather than blocking
 * the whole page -- the deal list itself came back fine, this is a
 * separate, non-essential enrichment.
 */
function useCommodityDecimals() {
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    getCommodities()
      .then((commodities) => {
        if (cancelled) return;
        setDecimals(Object.fromEntries(commodities.map((c) => [c.symbol, c.decimals])));
      })
      .catch(() => {
        // Best-effort only, see doc comment above.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return decimals;
}

export default function MyDealsPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const decimalsBySymbol = useCommodityDecimals();

  useEffect(() => {
    if (!publicKey) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadMyDeals(publicKey)
      .then((deals) => {
        if (!cancelled) setState({ status: "loaded", deals });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "failed to load deals" });
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink-primary">My Deals</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Every AgriPriceFloor deal registered under your connected address, farmer or buyer,
        discovered from the indexed deal registry — never from this browser&apos;s own storage.
        Reloading this page, restarting your browser, or returning another day does not lose
        this list: it is read fresh from the indexer every time, by your address alone.
      </p>

      <div className="mt-8">
        <WalletConnect onConnect={setPublicKey} />
      </div>

      <div className="mt-8">
        {!publicKey && (
          <EmptyState>Connect a wallet above to see the deals registered to your address.</EmptyState>
        )}

        {publicKey && state.status === "loading" && (
          <div className="card p-8 text-center text-sm text-ink-muted" aria-live="polite">
            Loading your deals from the indexer…
          </div>
        )}

        {publicKey && state.status === "error" && <SourceUnavailable what="Your deals" />}

        {publicKey && state.status === "loaded" && state.deals.length === 0 && (
          <EmptyState>
            No deals are registered to this address yet. This means the indexer successfully
            answered and genuinely found none — not that something failed to load.
          </EmptyState>
        )}

        {publicKey && state.status === "loaded" && state.deals.length > 0 && (
          <ul className="flex flex-col gap-4" aria-label="Your registered deals">
            {state.deals.map(({ deal, role }) => (
              <li key={deal.contractId}>
                <DealCard
                  deal={deal}
                  role={role}
                  decimals={(() => {
                    const symbol = commoditySymbol(deal.commodity);
                    return symbol && symbol in decimalsBySymbol ? decimalsBySymbol[symbol]! : null;
                  })()}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
