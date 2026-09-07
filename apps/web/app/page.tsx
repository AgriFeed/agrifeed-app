import { getCommodities, IndexerUnavailableError } from "@/lib/api";
import { TickerRow } from "@/components/TickerRow";
import { SourceUnavailable } from "@/components/SourceUnavailable";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let commodities;
  try {
    commodities = await getCommodities();
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <Header />
          <div className="mt-8">
            <SourceUnavailable what="The live commodity ticker" />
          </div>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header />
      <div className="mt-8 flex flex-col gap-px">
        {commodities.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No commodities tracked yet. Once agrifeed-contract has commodities added via
            add_commodity, they will appear here automatically.
          </p>
        ) : (
          commodities.map((commodity) => <TickerRow key={commodity.symbol} commodity={commodity} />)
        )}
      </div>
    </main>
  );
}

function Header() {
  return (
    <div>
      <h1 className="font-display text-4xl text-ink-primary">AgriFeed</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        A decentralized commodity price oracle on Stellar. Every price below is read live from
        the AgriFeedOracle contract, with the number of independent nodes reporting it and when
        it was last updated. No number here is invented.
      </p>
    </div>
  );
}
