import { notFound } from "next/navigation";
import { formatPriceWithUnit } from "@agrifeed/sdk";
import { getCommodityHistory, IndexerUnavailableError } from "@/lib/api";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { PriceHistoryChart } from "@/components/PriceHistoryChart";
import { truncateAddress } from "@/lib/address";
import { formatTimestamp, relativeAge } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function CommodityPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();

  let data;
  try {
    data = await getCommodityHistory(symbol);
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <SourceUnavailable what={`History for ${symbol}`} />
        </main>
      );
    }
    throw err;
  }

  if (data === null) {
    notFound();
  }

  const latest = data.history[0];

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-ink-primary">{data.symbol}</h1>
        {latest && (
          <div className="text-right">
            <p className="font-mono text-2xl text-ink-primary">
              {formatPriceWithUnit(latest.price, data.decimals, data.symbol)}
            </p>
            <p className="font-mono text-xs text-ink-muted">{relativeAge(latest.timestamp)}</p>
          </div>
        )}
      </div>

      <section className="mt-8">
        <h2 className="font-display text-lg text-ink-primary">Price history</h2>
        <div className="mt-3">
          <PriceHistoryChart points={data.history} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-lg text-ink-primary">Finalizations</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Exactly which nodes contributed to each finalized price, never just a count.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-ink-muted">
                <th className="py-2 pr-4 font-normal">Timestamp</th>
                <th className="py-2 pr-4 font-normal">Price</th>
                <th className="py-2 pr-4 font-normal">Contributing nodes</th>
                <th className="py-2 pr-4 font-normal">Tx</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.finalizations.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-ink-muted">
                    no finalizations indexed yet
                  </td>
                </tr>
              ) : (
                data.finalizations.map((f) => (
                  <tr key={f.txHash} className="border-b border-border/60">
                    <td className="py-2 pr-4 text-ink-muted">{formatTimestamp(f.timestamp)}</td>
                    <td className="py-2 pr-4 text-ink-primary">
                      {formatPriceWithUnit(f.price, data.decimals, data.symbol)}
                    </td>
                    <td className="py-2 pr-4 text-ink-muted">
                      {f.contributingNodes.map((n) => truncateAddress(n)).join(", ") || "—"}
                    </td>
                    <td className="py-2 pr-4 text-ink-muted">{truncateAddress(f.txHash)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-lg text-ink-primary">Submissions</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-ink-muted">
                <th className="py-2 pr-4 font-normal">Timestamp</th>
                <th className="py-2 pr-4 font-normal">Node</th>
                <th className="py-2 pr-4 font-normal">Price</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.submissions.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-ink-muted">
                    no submissions indexed yet
                  </td>
                </tr>
              ) : (
                data.submissions.map((s) => (
                  <tr key={s.txHash} className="border-b border-border/60">
                    <td className="py-2 pr-4 text-ink-muted">{formatTimestamp(s.timestamp)}</td>
                    <td className="py-2 pr-4 text-ink-primary">{truncateAddress(s.nodeAddress)}</td>
                    <td className="py-2 pr-4 text-ink-primary">
                      {formatPriceWithUnit(s.price, data.decimals, data.symbol)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
