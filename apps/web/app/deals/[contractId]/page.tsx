import Link from "next/link";
import { getCommodities, getDeal } from "@/lib/api";
import { commoditySymbol } from "@/lib/deals";
import { DealDetailView } from "@/components/DealDetailView";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

/**
 * The deal recovery route (Phase 4 Step 6): contract_id in the URL is the
 * only input this page needs. A server component, deliberately -- it
 * proves recovery does not depend on any client-side state surviving a
 * refresh, browser restart, or new visit, since a server component has no
 * client state to lose in the first place. Every render is a fresh
 * getDeal() call against the real indexer, never a cached or
 * locally-reconstructed value.
 */
export default async function DealDetailPage({ params }: { params: { contractId: string } }) {
  const result = await getDeal(params.contractId);

  if (result.outcome === "invalid") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Header contractId={params.contractId} />
        <div className="mt-8">
          <EmptyState>
            &quot;{params.contractId}&quot; is not shaped like a real Soroban contract id, so no
            lookup was made. Check the value and try again.
          </EmptyState>
        </div>
      </main>
    );
  }

  if (result.outcome === "not-found") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Header contractId={params.contractId} />
        <div className="mt-8">
          <EmptyState>
            No deal is registered under this contract id. This is a real, successful answer from
            the indexer — either this contract was never registered for discovery, or it isn&apos;t
            an AgriPriceFloor instance at all.
          </EmptyState>
        </div>
      </main>
    );
  }

  if (result.outcome === "unavailable") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Header contractId={params.contractId} />
        <div className="mt-8">
          <SourceUnavailable what="This deal" />
        </div>
      </main>
    );
  }

  const { deal } = result;
  const symbol = commoditySymbol(deal.commodity);
  let decimals: number | null = null;
  if (symbol) {
    try {
      const commodities = await getCommodities();
      decimals = commodities.find((c) => c.symbol === symbol)?.decimals ?? null;
    } catch {
      // Best-effort enrichment only -- the deal record itself loaded fine,
      // see DealDetailView's formattedOrRaw fallback for how this degrades.
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Header contractId={deal.contractId} />
      <div className="mt-8">
        <DealDetailView deal={deal} decimals={decimals} />
      </div>
    </main>
  );
}

function Header({ contractId }: { contractId: string }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">
        <Link href="/deals" className="text-accent hover:underline">
          ← My Deals
        </Link>
      </p>
      <h1 className="mt-2 font-display text-4xl text-ink-primary">Deal detail</h1>
      <p className="mt-2 max-w-2xl break-all font-mono text-xs text-ink-muted">{contractId}</p>
    </div>
  );
}
