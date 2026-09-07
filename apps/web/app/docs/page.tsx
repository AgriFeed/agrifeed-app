import { DocsSection, CodeBlock } from "@/components/DocsSection";

export default function DocsPage() {
  const oracleId = process.env.NEXT_PUBLIC_ORACLE_CONTRACT_ID;
  const rpc = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_API_URL ?? "http://localhost:4000";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink-primary">Integration guide</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Three ways to read AgriFeed prices in your own project: from another Soroban contract,
        from a TypeScript app with the SDK, or over plain REST from the indexer.
      </p>

      <DocsSection title="Contract addresses">
        <p>
          AgriFeedOracle implements the SEP-40 price feed interface plus AgriFeed&apos;s own
          admin and ingestion functions. Current testnet address:
        </p>
        <CodeBlock>{oracleId ?? "not deployed yet — check the repo README for the current address"}</CodeBlock>
        <p>RPC endpoint used by this deployment:</p>
        <CodeBlock>{rpc}</CodeBlock>
      </DocsSection>

      <DocsSection title="Reading a price from another Soroban contract">
        <p>
          Call <strong>lastprice</strong> like any SEP-40 feed. The commodity asset is always
          the <strong>Other</strong> variant, keyed by its symbol, e.g. <strong>COCOA</strong>.
        </p>
        <CodeBlock>{`use soroban_sdk::{contractclient, Address, Env, Symbol};

#[contractclient(name = "AgriFeedOracleClient")]
pub trait AgriFeedOracle {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

fn read_cocoa_price(env: &Env, oracle: &Address) -> Option<PriceData> {
    let client = AgriFeedOracleClient::new(env, oracle);
    let cocoa = Asset::Other(Symbol::new(env, "COCOA"));
    client.lastprice(&cocoa)
}`}</CodeBlock>
        <p>
          <strong>price</strong> is an i128 scaled by <strong>10^decimals</strong> (call{" "}
          <strong>decimals()</strong> once and cache it). Divide with integer math, never cast
          through a float.
        </p>
      </DocsSection>

      <DocsSection title="Reading a price with the TypeScript SDK">
        <CodeBlock>{`import { oracle, formatPriceWithUnit } from "@agrifeed/sdk";

const config = {
  contractId: process.env.NEXT_PUBLIC_ORACLE_CONTRACT_ID!,
  rpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!,
  networkPassphrase: Networks.TESTNET,
};

const cocoa = { tag: "Other" as const, values: ["COCOA"] as [string] };
const decimals = await oracle.decimals(config);
const latest = await oracle.lastprice(config, cocoa);

if (latest) {
  console.log(formatPriceWithUnit(latest.price, decimals, "COCOA"));
  // "6,188.00 USD/MT"
}`}</CodeBlock>
        <p>
          <strong>formatPriceWithUnit</strong> and <strong>formatPrice</strong> only ever do
          string/BigInt arithmetic. Never call <strong>Number()</strong> or{" "}
          <strong>parseFloat()</strong> on a raw price string yourself, an i128 can exceed{" "}
          <strong>Number.MAX_SAFE_INTEGER</strong>.
        </p>
      </DocsSection>

      <DocsSection title="Reading over REST">
        <p>
          services/indexer polls the oracle&apos;s own read calls and re-serves them as plain
          JSON, useful if you don&apos;t want a Soroban RPC dependency at all.
        </p>
        <CodeBlock>{`GET ${indexerUrl}/commodities
GET ${indexerUrl}/commodities/COCOA/history
GET ${indexerUrl}/nodes`}</CodeBlock>
        <p>
          Every commodity entry carries <strong>nodesReporting</strong>,{" "}
          <strong>nodesTotal</strong>, and <strong>priceTimestamp</strong> alongside the price.
          If <strong>sourceAvailable</strong> is false, price is null, treat that as &ldquo;no data,&rdquo;
          never substitute zero or the previous value.
        </p>
      </DocsSection>

      <DocsSection title="How a price is finalized">
        <p>
          Authorized nodes call <strong>submit_price</strong> independently after fetching from
          FAO, IMF, and AMIS (see services/node-relayer and research/METHODOLOGY.md for exactly
          how). Once enough nodes have submitted for a resolution window,{" "}
          <strong>finalize_price</strong> computes the median and writes one{" "}
          <strong>PriceData</strong> record. The <strong>/commodity/[symbol]</strong> page on
          this site lists every node that contributed to each finalization, so you can verify
          the median wasn&apos;t computed from a single source.
        </p>
      </DocsSection>
    </main>
  );
}
