import Link from "next/link";
import { notFound } from "next/navigation";
import { getCommodityHistory, getNodes, IndexerUnavailableError } from "@/lib/api";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { PriceHistoryChart } from "@/components/PriceHistoryChart";
import { PriceDisplay } from "@/components/PriceDisplay";
import { Freshness } from "@/components/Freshness";
import { ProvenanceTag } from "@/components/ProvenanceTag";
import { ContributorList } from "@/components/ContributorList";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { EmptyState } from "@/components/EmptyState";
import { StaleBanner } from "@/components/StaleBanner";
import { formatTimestamp } from "@/lib/time";

export const dynamic = "force-dynamic";

// Mirrors Markets' own conservative default — see TickerRow.tsx's comment
// for why this isn't derived from the oracle's actual per-commodity
// resolution (not exposed by the current /commodities API).
const STALE_AFTER_SECONDS = 2 * 60 * 60;

export default async function CommodityPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();

  let data;
  try {
    data = await getCommodityHistory(symbol);
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <BackLink />
          <div className="mt-6">
            <SourceUnavailable what={`History for ${symbol}`} />
          </div>
        </main>
      );
    }
    throw err;
  }

  if (data === null) {
    notFound();
  }

  // Best-effort only: the total authorized-node count is a supplementary
  // relationship note next to per-finalization contributor lists, not
  // load-bearing data for this page. If it can't be fetched, the page
  // still shows everything getCommodityHistory succeeded at loading —
  // a failed background call never discards already-loaded evidence.
  let totalAuthorizedNodes: number | null = null;
  try {
    const nodes = await getNodes();
    totalAuthorizedNodes = nodes.filter((n) => n.active).length;
  } catch {
    totalAuthorizedNodes = null;
  }

  const latest = data.history[0];
  const latestStale =
    latest !== undefined && (Date.now() - new Date(latest.timestamp).getTime()) / 1000 > STALE_AFTER_SECONDS;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <BackLink />

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="font-display text-4xl text-ink-primary">{data.symbol}</h1>
        {latest && (
          <div className="text-right">
            <PriceDisplay
              raw={latest.price}
              decimals={data.decimals}
              symbol={data.symbol}
              className="text-2xl font-medium text-ink-primary"
            />
            <div className="mt-1">
              <Freshness timestamp={latest.timestamp} staleAfterSeconds={STALE_AFTER_SECONDS} />
            </div>
          </div>
        )}
      </div>

      {latestStale && (
        <div className="mt-4">
          <StaleBanner>
            This price is older than expected. The indexer may be behind — it is still the last
            real finalized price recorded, not a placeholder.
          </StaleBanner>
        </div>
      )}

      <section className="mt-10">
        <h2 className="font-display text-lg text-ink-primary">Finalized price history</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Each point is one finalized price, indexed from the oracle&apos;s on-chain
          finalizations — not a plot of individual node submissions.
        </p>
        <div className="mt-3">
          <PriceHistoryChart points={data.history} decimals={data.decimals} symbol={data.symbol} />
        </div>
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg text-ink-primary">Finalized prices</h2>
          <ProvenanceTag kind="finalized" />
        </div>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          One row per finalize_price call, with exactly which nodes contributed to that specific
          price — never just a count.
        </p>

        {data.finalizations.length === 0 ? (
          <div className="mt-3">
            <EmptyState>No finalized prices indexed for {data.symbol} yet.</EmptyState>
          </div>
        ) : (
          <div className="mt-3 table-scroll">
            <table className="min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Price
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Finalized
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Nodes that contributed to this finalized price
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Tx
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.finalizations.map((f) => (
                  <tr key={f.txHash} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-4">
                      <PriceDisplay raw={f.price} decimals={data.decimals} symbol={data.symbol} className="text-ink-primary" />
                    </td>
                    <td className="py-3 pr-4">
                      <Freshness timestamp={f.timestamp} staleAfterSeconds={STALE_AFTER_SECONDS} />
                    </td>
                    <td className="py-3 pr-4">
                      <ContributorList addresses={f.contributingNodes} />
                      {totalAuthorizedNodes !== null && (
                        <p className="mt-1 text-xs text-ink-muted">
                          {f.contributingNodes.length} of {totalAuthorizedNodes} currently-authorized nodes
                        </p>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <IdentifierDisplay kind="tx" value={f.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg text-ink-primary">Individual node submissions</h2>
          <ProvenanceTag kind="submission" />
        </div>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Raw observations from individual nodes, before aggregation — not finalized market
          prices.
        </p>

        {data.submissions.length === 0 ? (
          <div className="mt-3">
            <EmptyState>No individual node submissions indexed for {data.symbol} yet.</EmptyState>
          </div>
        ) : (
          <div className="mt-3 table-scroll">
            <table className="min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Node
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Submitted price
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Submitted
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Tx
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.submissions.map((s) => (
                  <tr key={s.txHash} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-4">
                      <IdentifierDisplay kind="address" value={s.nodeAddress} />
                    </td>
                    <td className="py-3 pr-4">
                      <PriceDisplay raw={s.price} decimals={data.decimals} symbol={data.symbol} className="text-ink-primary" />
                    </td>
                    <td className="py-3 pr-4">
                      <Freshness timestamp={s.timestamp} staleAfterSeconds={STALE_AFTER_SECONDS} />
                    </td>
                    <td className="py-3 pr-4">
                      <IdentifierDisplay kind="tx" value={s.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Provenance />
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/" className="text-sm text-ink-muted transition-colors hover:text-ink-primary">
      ← Markets
    </Link>
  );
}

function Provenance() {
  return (
    <section className="mt-10 max-w-2xl border-t border-border pt-6 text-sm text-ink-muted">
      <h2 className="font-display text-base text-ink-primary">Where this data comes from</h2>
      <p className="mt-2">
        Prices originate from independent nodes submitting observations to the AgriFeedOracle
        contract. A permissionless finalization step aggregates the pending submissions into one
        median price once enough nodes have reported. This page reads that history as indexed by
        AgriFeed&apos;s indexer, not a live read of the contract on every visit — timestamps show
        how long ago the indexed data was last updated. Each finalization&apos;s contributing
        nodes are reconstructed from the submissions recorded in that specific finalization
        window, not asserted by the finalization event itself. See{" "}
        <Link href="/docs" className="text-accent hover:underline">
          Developers &amp; Docs
        </Link>{" "}
        for the underlying methodology.
      </p>
    </section>
  );
}
