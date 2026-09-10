import { DocsSection, DocsSubsection, CodeBlock, DocsTable } from "@/components/DocsSection";
import { DocsNav } from "@/components/DocsNav";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { StatusBadge } from "@/components/StatusBadge";
import { oracleContractId, pricefloorContractId, pricefloorWasmHash, rpcUrl, networkLabel } from "@/lib/stellar";

export default function DocsPage() {
  const oracleId = oracleContractId();
  const legacyPricefloorId = pricefloorContractId();
  const wasmHash = pricefloorWasmHash();
  const rpc = rpcUrl();
  const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_API_URL ?? "http://localhost:4000";

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink-primary">Developers &amp; Docs</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        A technical reference for integrating with AgriFeed: the Oracle, the PriceFloor
        agreement contract, the REST API, the TypeScript SDK, and how they fit together on
        Stellar Testnet.
      </p>

      <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[14rem_1fr]">
        <DocsNav />

        <div className="min-w-0">
          <DocsSection id="introduction" title="Introduction">
            <p>
              AgriFeed is two Soroban contracts and the off-chain infrastructure around them,
              deployed on Stellar Testnet.
            </p>
            <ul className="list-disc pl-5">
              <li>
                <strong>AgriFeedOracle</strong> is a SEP-40-compatible commodity price feed.
                Independent reporting nodes each submit an observed price; the contract
                finalizes a price for a resolution window only once enough independent
                submissions agree, via a median-of-N. See <a href="#oracle" className="text-accent">Oracle</a>.
              </li>
              <li>
                <strong>AgriPriceFloor</strong> is a two-party minimum-price agreement between
                a farmer and a buyer, settled against AgriFeedOracle at maturity. Each deal is
                its own fresh contract instance, not a shared singleton. See{" "}
                <a href="#pricefloor" className="text-accent">PriceFloor</a>.
              </li>
            </ul>
            <p>
              Everything on this page describes the system as it actually runs today, on{" "}
              <strong>{networkLabel()}</strong>: what is indexed, what is same-session-only,
              and what has been implemented but not yet exercised end to end live. Where a
              capability is deferred, this page says so directly rather than describing the
              intended future state as current.
            </p>
            <p>
              This page is written for developers integrating against AgriFeed: people calling
              the contracts directly, building against the REST API or the SDK, or reviewing
              the system&apos;s actual guarantees before relying on it. It assumes familiarity with
              Soroban and Stellar concepts (accounts, contracts, authorization entries); see{" "}
              <a href="#wallet-signing" className="text-accent">Wallet &amp; signing</a> for the
              Soroban authorization model specifically.
            </p>
          </DocsSection>

          <DocsSection id="oracle" title="Oracle">
            <p>AgriFeedOracle turns independent node submissions into one finalized price, in five steps:</p>
            <CodeBlock>{`data source (FAO, IMF)
    ↓
node submission          submit_price(node, asset, price, source_ts)
    ↓
threshold check           enough independent submissions this window?
    ↓
finalization               finalize_price(asset) computes the median, stores it
    ↓
indexed API                services/indexer polls it, serves it over REST`}</CodeBlock>
            <p>
              A <strong>submission</strong> is one node&apos;s <code>submit_price</code> call: one
              address&apos;s claim about the price, not yet trusted on its own. A{" "}
              <strong>finalized price</strong> is the result of <code>finalize_price</code>,
              callable by anyone once the pending-submission count for that commodity and
              window meets the configured threshold; it is the median across every independent
              submission in that window, so no single node or single upstream source can move
              the published price alone. Only a finalized <code>PriceData</code> record is
              returned by the SEP-40 read functions (<code>lastprice</code>, <code>price</code>,{" "}
              <code>prices</code>); individual pending submissions are not exposed there.
            </p>
            <p>
              The <strong>authorized node roster</strong> is set by the contract&apos;s admin
              (<code>add_node</code> / <code>remove_node</code>); only an address on that
              roster can submit. This deployment currently has a small, fixed set of
              reporting nodes, real addresses, real submissions, real median arithmetic, but
              not the large, permissionless node set that &ldquo;decentralized&rdquo; usually
              implies. See <code>/nodes</code> for the actual current roster and submission
              history, and <a href="#methodology" className="text-accent">Methodology</a> for
              where the underlying prices come from.
            </p>
          </DocsSection>

          <DocsSection id="pricefloor" title="PriceFloor">
            <p>
              AgriPriceFloor is <strong>one instance per deal</strong>, not a shared contract
              with many deals inside it. A new deal deploys a fresh instance from a shared WASM
              hash, then initializes it with that deal&apos;s own terms:
            </p>
            <CodeBlock>{`deploy (from PRICEFLOOR_WASM_HASH)
    ↓
new, uninitialized instance      its contract ID is the deal's identifier
    ↓
initialize(farmer, buyer, commodity, floor_price, notional,
           settlement_token, maturity_ts, oracle)
    ↓
fund(buyer, amount)               buyer deposits collateral
    ↓
settle()  or  cancel(caller)      after maturity`}</CodeBlock>
            <p>
              The deployed contract&apos;s address is the deal&apos;s only identifier; nothing
              else names it. <code>initialize</code> requires independent authorization from{" "}
              <strong>both</strong> the farmer and the buyer (<code>farmer.require_auth()</code>{" "}
              and <code>buyer.require_auth()</code>), evaluated by Soroban itself, not a
              convention the application layer enforces on top. See{" "}
              <a href="#wallet-signing" className="text-accent">Wallet &amp; signing</a> for how
              two independent signatures are collected.
            </p>
            <p>
              <StatusBadge tone="neutral">current limitation</StatusBadge> Two-party
              authorization in this product is <strong>same-session</strong>: both parties sign
              in the same browser tab, switching which Freighter account is active between
              signatures. There is no link-sharing or multi-device handoff yet, a deal in
              progress that isn&apos;t finished before the tab closes is lost.
            </p>
            <p>
              After initialization, the buyer funds the agreement (a separate, later
              transaction, not part of <code>initialize</code>). At or after maturity, anyone
              may call <code>settle</code>: if the oracle&apos;s finalized price is below the
              floor, the farmer is topped up (capped at the funded amount); otherwise the
              buyer keeps the difference. <code>cancel</code> is available to either party once
              the applicable grace period has elapsed, see{" "}
              <a href="#contract-reference" className="text-accent">Contract reference</a> for
              the exact conditions.
            </p>
          </DocsSection>

          <DocsSection id="rest-api" title="REST API">
            <p>
              The REST API is served by <code>services/indexer</code>, which polls the oracle
              and watches its on-chain events, writing what it sees to Postgres. Every response
              below is <strong>indexed data</strong>, a read of the indexer&apos;s own database,
              not a per-request direct call to Soroban RPC or the contract. Base URL for this
              deployment:
            </p>
            <CodeBlock>{indexerUrl}</CodeBlock>

            <DocsSubsection title="GET /commodities">
              <p>Every commodity the oracle tracks, with its latest indexed price and reporting-node count.</p>
              <CodeBlock label="response">{`{
  "commodities": [
    {
      "symbol": "COCOA",
      "decimals": 7,
      "price": "61880000000",
      "priceTimestamp": "2026-09-01T00:00:00.000Z",
      "previousPrice": "61200000000",
      "nodesReporting": 2,
      "nodesTotal": 2,
      "sourceAvailable": true
    }
  ]
}`}</CodeBlock>
              <p>
                <code>price</code> is the raw i128 string, scaled by <code>10^decimals</code>;
                format it with the SDK&apos;s <code>formatPrice</code>, never{" "}
                <code>Number()</code>. When <code>sourceAvailable</code> is <code>false</code>,{" "}
                <code>price</code> is <code>null</code>, treat that as no data, not as zero or
                as the previous value.
              </p>
            </DocsSubsection>

            <DocsSubsection title="GET /commodities/:symbol/history">
              <p>Price history, finalizations with their contributing nodes, and raw node submissions for one commodity.</p>
              <CodeBlock label="response">{`{
  "symbol": "COCOA",
  "decimals": 7,
  "history": [{ "price": "61880000000", "timestamp": "2026-09-01T00:00:00.000Z" }],
  "finalizations": [
    {
      "price": "61880000000",
      "timestamp": "2026-09-01T00:00:00.000Z",
      "contributingNodes": ["GABC...", "GDEF..."],
      "txHash": "..."
    }
  ],
  "submissions": [
    { "nodeAddress": "GABC...", "price": "61880000000", "timestamp": "...", "txHash": "..." }
  ]
}`}</CodeBlock>
              <p>
                Unknown symbol returns <code>404 {"{ \"error\": \"unknown commodity\" }"}</code>.
                History and finalizations are capped (200 and 50 rows respectively, most recent
                first) rather than paginated.
              </p>
            </DocsSubsection>

            <DocsSubsection title="GET /nodes">
              <p>The authorized node roster and each node&apos;s real submission activity.</p>
              <CodeBlock label="response">{`{
  "nodes": [
    {
      "address": "GABC...",
      "addedAt": "2026-08-01T00:00:00.000Z",
      "removedAt": null,
      "active": true,
      "submissionCount": 42,
      "lastSubmissionAt": "2026-09-01T00:00:00.000Z"
    }
  ]
}`}</CodeBlock>
            </DocsSubsection>

            <DocsSubsection title="GET /api/deals">
              <p>
                The canonical, stable read API for indexed PriceFloor deals (Phase 4 Step 5).
                Every independently deployed instance that has been{" "}
                <a href="#pricefloor" className="text-accent">registered</a> is indexed here,
                not only the one fixed legacy instance, and <code>contractId</code> is the
                deal&apos;s canonical identity, nothing else names it.
              </p>
              <CodeBlock label="response">{`{
  "deals": [
    {
      "contractId": "CD2A...",
      "status": "funded",
      "farmer": "GABC...",
      "buyer": "GDEF...",
      "commodity": ["Other", "COCOA"],
      "floorPrice": "40820949368",
      "notional": "100",
      "settlementToken": "CDLZ...",
      "maturityTs": "2026-09-10T12:23:24.000Z",
      "oracleContractId": "CBKA...",
      "registeredAt": "2026-09-10T12:18:08.117Z",
      "registeredAtLedger": 4603820,
      "initializedAt": "2026-09-10T12:18:37.000Z",
      "fundedAt": "2026-09-10T12:18:52.000Z",
      "settledAt": null,
      "cancelledAt": null
    }
  ],
  "limit": 50,
  "offset": 0
}`}</CodeBlock>
              <p>
                <code>GET /api/deals/:contractId</code> returns <code>{"{ \"deal\": {...} }"}</code>{" "}
                with the same shape for one deal, <code>404 {"{ \"error\": \"...\" }"}</code> for a
                syntactically valid but unregistered contract id, or <code>400</code> for one
                that isn&apos;t even shaped like a real Soroban contract id. Add{" "}
                <code>?farmer=G...</code> and/or <code>?buyer=G...</code> to <code>GET
                /api/deals</code> to filter (given together, both must match the same deal, an
                AND, not an OR); a malformed address returns <code>400</code>, never a silent
                empty result. <code>?limit=</code> (default 50, clamped to a 200 ceiling rather
                than rejected) and <code>?offset=</code> page the list, ordered most-recently-
                registered first; there is no total count in the response, a page shorter than
                <code>limit</code> is the only signal that no further page exists.
              </p>
              <DocsTable
                headers={["field", "source of truth"]}
                rows={[
                  ["status", "Indexed lifecycle state, advanced only by an observed on-chain event, never re-derived from a storage snapshot"],
                  ["farmer / buyer / commodity / floorPrice / notional / maturityTs", "The Initialized event's own payload; null until observed"],
                  ["settlementToken / oracleContractId", "Not in any PriceFloor event; read separately from the contract's own instance storage, null until that read succeeds"],
                  ["registeredAt / registeredAtLedger", "When this indexer verified and persisted the row (RPC read), not an on-chain event"],
                  ["initializedAt / fundedAt / settledAt / cancelledAt", "Ledger-close time of the transaction that produced the respective event, null until observed"],
                ]}
              />
              <p>
                <StatusBadge tone="warning">cancelled is event-only</StatusBadge>{" "}
                <code>status: &quot;cancelled&quot;</code> is set exclusively by observing a real{" "}
                <code>Cancelled</code> event; the contract itself writes no corresponding
                storage flag (see{" "}
                <a href="#contract-reference" className="text-accent">Contract reference</a>),
                so this API can never re-derive &quot;cancelled&quot; from a point-in-time
                on-chain read, only from unbroken event history. A polling outage that outlasts
                the RPC&apos;s event-retention window before catching back up is the one way a
                cancellation could be missed; there is no fallback for that case today.
              </p>
            </DocsSubsection>

            <p>
              A request to an unrecognized route returns <code>404 {"{ \"error\": \"not found\" }"}</code>;
              an unhandled server error returns <code>500 {"{ \"error\": \"internal error\" }"}</code>.
              There is no rate limiting or authentication on these endpoints.
            </p>
            <p>
              <StatusBadge tone="neutral">scope</StatusBadge> <code>/api/deals*</code> above is
              the documented, stable surface for reading the deal registry; an equivalent{" "}
              <code>/pricefloor-instances*</code> family (same underlying data, same field
              shape) also exists and is what this product&apos;s own frontend currently calls
              internally, kept for now rather than migrated in this step so that behavior is
              unchanged. Neither endpoint exposes anything for a PriceFloor instance that has
              never been registered with this indexer (see{" "}
              <a href="#pricefloor" className="text-accent">PriceFloor</a>): read its state
              directly from the contract over RPC instead in that case.
            </p>
          </DocsSection>

          <DocsSection id="sdk" title="SDK">
            <p>
              <code>@agrifeed/sdk</code> wraps the Soroban calls both <code>apps/web</code> and
              the backend services use. Its exported surface, from{" "}
              <code>packages/sdk/src/index.ts</code>:
            </p>
            <CodeBlock label="packages/sdk/src/index.ts">{`export * from "./types.js";
export * from "./format.js";
export * as oracle from "./oracle.js";
export * as pricefloor from "./pricefloor.js";
export * as multiparty from "./multiparty.js";
export * as deploy from "./deploy.js";`}</CodeBlock>
            <p>
              Freighter-specific wallet functions are <strong>not</strong> part of that import.
              <code>@stellar/freighter-api</code> is browser-only and throws if evaluated under
              Node, so browser code imports it separately from{" "}
              <code>@agrifeed/sdk/wallet</code> instead.
            </p>

            <DocsSubsection title="oracle.*  (packages/sdk/src/oracle.ts)">
              <CodeBlock>{`oracle.base(config): Promise<Asset>
oracle.assets(config): Promise<Asset[]>
oracle.decimals(config): Promise<number>
oracle.resolution(config): Promise<number>
oracle.price(config, asset, timestamp: bigint): Promise<PriceData | null>
oracle.prices(config, asset, records: number): Promise<PriceData[] | null>
oracle.lastprice(config, asset): Promise<PriceData | null>`}</CodeBlock>
              <p>
                Each is a direct simulated read against Soroban RPC (an <code>OracleConfig</code>{" "}
                of <code>{"{ contractId, rpcUrl, networkPassphrase }"}</code>), not the indexer.
                Use these when you need a guaranteed up-to-the-ledger read; use the REST API
                when you don&apos;t want an RPC dependency.
              </p>
            </DocsSubsection>

            <DocsSubsection title="pricefloor.*  (packages/sdk/src/pricefloor.ts)">
              <CodeBlock>{`pricefloor.initializeArgs(params: InitializePriceFloorParams): xdr.ScVal[]
pricefloor.initialize(config, params, callerPublicKey, signAndSend): Promise<void>
pricefloor.fundArgs(buyer, amount: bigint): xdr.ScVal[]
pricefloor.fund(config, buyer, amount, signAndSend): Promise<void>
pricefloor.settle(config, callerPublicKey, signAndSend): Promise<void>
pricefloor.cancelArgs(callerPublicKey): xdr.ScVal[]
pricefloor.cancel(config, callerPublicKey, signAndSend): Promise<void>`}</CodeBlock>
              <p>
                <code>pricefloor.initialize</code> signs with exactly one signer. It only
                succeeds when farmer, buyer, and the caller are the <strong>same</strong>{" "}
                connected wallet, that is not a relaxed authorization rule, it is one signature
                happening to satisfy both identical addresses. For a real deal with two
                different people, use <code>multiparty.*</code> instead.
              </p>
              <p>
                <code>getState</code> is exported but currently returns <code>{"{}"}</code>{" "}
                unconditionally: AgriPriceFloor exposes no state-reading contract function, and
                arbitrary instances are not indexed (see{" "}
                <a href="#rest-api" className="text-accent">REST API</a>), so there is no live
                source for it to read from yet.
              </p>
            </DocsSubsection>

            <DocsSubsection title="multiparty.*  (packages/sdk/src/multiparty.ts)">
              <CodeBlock>{`multiparty.prepareMultiPartyInvocation(config, method, args, sourcePublicKey)
  : Promise<PreparedMultiPartyInvocation>

multiparty.submitMultiPartyInvocation(config, transactionXdr, signedAuthEntryXdrs,
  sourceAccountAuthEntryXdrs, signAndSend): Promise<xdr.ScVal | undefined>

multiparty.assertExpectedSigner(connectedAddress, expectedAddress, role): void
multiparty.toPendingAuthEntries(entries): PendingAuthEntry[]
multiparty.mergeSignedAuthEntries(sourceAccountEntries, signedEntries): xdr.SorobanAuthorizationEntry[]
multiparty.withAuthEntries(builder, originalTx, authEntries): Transaction`}</CodeBlock>
              <p>
                <code>prepareMultiPartyInvocation</code> simulates the call once and returns one
                unsigned <code>PendingAuthEntry</code> per address that must independently
                authorize. Each entry is then handed to that address&apos;s own signer (its own
                Freighter session), never a single caller holding more than one signature.
                Once every entry is signed, <code>submitMultiPartyInvocation</code> re-simulates
                against those exact entries (never a fresh, auth-less simulation, which would
                mint different nonces) and submits.
              </p>
            </DocsSubsection>

            <DocsSubsection title="deploy.*  (packages/sdk/src/deploy.ts)">
              <CodeBlock>{`deploy.deployInstance(config: AgriPriceFloorDeploymentConfig, deployerPublicKey, signAndSend)
  : Promise<string>  // the new instance's contract ID`}</CodeBlock>
              <p>
                Deploys a fresh AgriPriceFloor instance from{" "}
                <code>config.wasmHash</code>. Single-signer, since deploying from an existing
                WASM hash needs no counterparty approval, that comes at{" "}
                <code>initialize</code>. The contract has no on-deploy constructor: deploy and
                initialize are always two separate calls.
              </p>
            </DocsSubsection>

            <DocsSubsection title="wallet.*  (packages/sdk/src/wallet.ts, import from @agrifeed/sdk/wallet)">
              <CodeBlock>{`connectFreighter(): Promise<FreighterConnection>
getConnectedAddress(): Promise<string | null>
isFreighterInstalled(): Promise<boolean>
freighterSignAndSend(networkPassphrase): SignAndSend
signAuthEntryWithFreighter(pending, networkPassphrase): Promise<PendingAuthEntry>
signAuthEntryAsExpectedParty(pending, role, networkPassphrase): Promise<PendingAuthEntry>`}</CodeBlock>
              <p>
                <code>signAuthEntryAsExpectedParty</code> is the one every multi-party signing
                step should call: it verifies the currently connected address actually matches
                the party the entry is for <em>before</em> requesting a signature, so a
                wrong-wallet mismatch is caught before Freighter is even asked. See{" "}
                <a href="#wallet-signing" className="text-accent">Wallet &amp; signing</a>.
              </p>
            </DocsSubsection>

            <DocsSubsection title="format.*  (packages/sdk/src/format.ts)">
              <CodeBlock>{`formatPrice(raw: string | bigint, decimals: number): FormattedPrice
formatPriceWithUnit(raw, decimals, symbol): string
parseAmountToRaw(input: string, decimals: number): string
assetSymbol(asset: Asset): string
commodityUnit(symbol: string): string`}</CodeBlock>
              <p>
                These only ever do string/BigInt arithmetic. A price is an i128 that can exceed{" "}
                <code>Number.MAX_SAFE_INTEGER</code>, never round-trip one through{" "}
                <code>Number()</code> or <code>parseFloat()</code>.
              </p>
            </DocsSubsection>
          </DocsSection>

          <DocsSection id="contract-reference" title="Contract reference">
            <p>
              A concise reference, not the full source. Read the actual contracts in{" "}
              <a
                href="https://github.com/AgriFeed/agrifeed-contract"
                className="text-accent"
                target="_blank"
                rel="noreferrer"
              >
                agrifeed-contract
              </a>{" "}
              for complete doc comments and error conditions.
            </p>

            <DocsSubsection title="AgriFeedOracle">
              <DocsTable
                headers={["Function", "Auth", "Notes"]}
                rows={[
                  ["initialize(admin, decimals, resolution, base_asset)", "admin", "Once only; sets threshold to 0 until set_threshold is called."],
                  ["add_node(admin, node)", "admin", "Adding an already-present node is a no-op, still returns Ok."],
                  ["remove_node(admin, node)", "admin", ""],
                  ["set_threshold(admin, threshold)", "admin", "A threshold of 0 can never be met, no single submission finalizes a price."],
                  ["add_commodity(admin, asset)", "admin", "Only add a commodity a reporting node can actually supply."],
                  ["submit_price(node, asset, price, source_ts)", "node (must be on the roster)", "Rejects a duplicate submission from the same node in the current window."],
                  ["finalize_price(asset)", "permissionless", "Requires the pending-submission count to meet the configured threshold."],
                  ["extend_instance_ttl(asset)", "permissionless", "Keeps storage entries alive; intended to be called periodically."],
                  ["base / assets / decimals / resolution / price / prices / lastprice", "read-only", "The SEP-40 interface, see SDK above."],
                ]}
              />
            </DocsSubsection>

            <DocsSubsection title="AgriPriceFloor">
              <DocsTable
                headers={["Function", "Auth", "Notes"]}
                rows={[
                  ["initialize(farmer, buyer, commodity, floor_price, notional, settlement_token, maturity_ts, oracle)", "farmer AND buyer", "Once per instance; each deal is a fresh deployment, not reusable."],
                  ["fund(buyer, amount)", "buyer (must match the stored buyer)", "Separate, later call; a deal can be initialized and unfunded."],
                  ["settle()", "permissionless", "Requires maturity passed and the oracle to have a finalized price; pays the farmer up to the floor, capped at the funded amount, remainder to the buyer."],
                  ["cancel(caller)", "farmer or buyer", "Only after the applicable grace period: unfunded past maturity, or funded and the oracle still has no price past a further grace period."],
                ]}
              />
              <p>
                Both <code>initialize</code>&apos;s two authorizations and <code>fund</code>
                &apos;s single one are checked by Soroban&apos;s own{" "}
                <code>require_auth()</code>, not application logic; a transaction missing a
                required authorization is rejected before it can execute.
              </p>
            </DocsSubsection>
          </DocsSection>

          <DocsSection id="integration-guide" title="Integration guide">
            <p>Six practical workflows, each labeled by where it runs.</p>

            <DocsSubsection title="A. Read a commodity price (SDK/direct or REST, Testnet)">
              <p>Either call the oracle directly with the SDK, or read the indexed value over REST, see <a href="#sdk" className="text-accent">SDK</a> and <a href="#rest-api" className="text-accent">REST API</a> above.</p>
            </DocsSubsection>

            <DocsSubsection title="B. Inspect price history and provenance (REST, Testnet)">
              <p>
                <code>GET /commodities/:symbol/history</code> returns raw history, finalizations,
                and the individual node submissions behind each finalization, so a caller can
                verify a median wasn&apos;t computed from a single source.
              </p>
            </DocsSubsection>

            <DocsSubsection title="C. Deploy a new PriceFloor instance (browser/Freighter, Testnet-only)">
              <p>
                <code>deploy.deployInstance(config, deployerPublicKey, signAndSend)</code>, single
                signer, any funded Testnet account. Returns the new instance&apos;s contract ID,
                the deal&apos;s only identifier going forward.
              </p>
            </DocsSubsection>

            <DocsSubsection title="D. Prepare a two-party initialization (browser/Freighter, Testnet-only)">
              <p>
                <code>multiparty.prepareMultiPartyInvocation(config, &quot;initialize&quot;,
                pricefloor.initializeArgs(params), sourcePublicKey)</code>. The source account
                can be any funded account, it does not have to be the farmer or the buyer.
              </p>
            </DocsSubsection>

            <DocsSubsection title="E. Collect both authorizations (browser/Freighter, same-session)">
              <p>
                For each of farmer and buyer: switch Freighter to that account, verify the
                connected address matches (<code>signAuthEntryAsExpectedParty</code> does this
                before requesting a signature), then sign that party&apos;s{" "}
                <code>PendingAuthEntry</code>. Both signatures must be collected in the same
                browser tab.
              </p>
            </DocsSubsection>

            <DocsSubsection title="F. Submit and confirm (browser/Freighter, Testnet-only)">
              <p>
                <code>multiparty.submitMultiPartyInvocation(config, transactionXdr,
                signedAuthEntryXdrs, sourceAccountAuthEntryXdrs, signAndSend)</code>, one final
                envelope signature from the source account. On success this returns a
                transaction hash, confirming the deal is now initialized on-chain.
              </p>
            </DocsSubsection>

            <p>
              None of the above requires a private key in browser code; every signature is
              requested from Freighter, the application never handles a secret key directly.
              See <a href="#wallet-signing" className="text-accent">Wallet &amp; signing</a>.
            </p>
          </DocsSection>

          <DocsSection id="wallet-signing" title="Wallet &amp; signing">
            <p>
              AgriPriceFloor&apos;s <code>initialize</code> requires two independent Soroban
              authorization entries, one from the farmer&apos;s address and one from the
              buyer&apos;s. Neither can be satisfied by the other party&apos;s signature, and
              neither can be satisfied by a single Freighter session signing twice as the same
              account.
            </p>
            <ol className="list-decimal pl-5">
              <li><strong>Connecting Freighter</strong>: <code>connectFreighter()</code> requests access from the extension and returns the currently active account&apos;s address.</li>
              <li><strong>Identity check</strong>: before requesting a signature for a given party, the app compares the connected address against that party&apos;s expected address and blocks if they don&apos;t match, rather than trusting the user&apos;s say-so.</li>
              <li><strong>Farmer/buyer signing</strong>: each party independently signs their own <code>SorobanAuthorizationEntry</code> via <code>signAuthEntryWithFreighter</code>. A party who is also the transaction&apos;s source account has this satisfied implicitly by the envelope signature at submit time, nothing separate to sign.</li>
              <li><strong>Source account</strong>: whichever account pays the transaction fee and provides the outer envelope signature. It does not have to be the farmer or the buyer.</li>
              <li><strong>Final envelope signing</strong>: once both authorization entries are collected, the source account signs the assembled transaction and it is submitted.</li>
            </ol>
            <p>
              <StatusBadge tone="neutral">current limitation</StatusBadge> The product currently
              supports <strong>same-session sequential signing only</strong>: both signatures
              happen in one browser tab, switching Freighter&apos;s active account between
              them. There is no mechanism today for the farmer to sign on one device and the
              buyer to sign later on another.
            </p>
            <p>
              <StatusBadge tone="neutral">environment note</StatusBadge> Live testing in this
              environment found that the installed Freighter browser extension could not parse
              the specific Soroban authorization entry shape (<code>SOROBAN_CREDENTIALS_ADDRESS_V2</code>)
              this Testnet deployment currently returns from simulation, even on Freighter&apos;s
              latest available release at the time of testing. This is an external wallet
              compatibility limitation observed in this environment, not a claim about Soroban
              protocol behavior in general or about AgriFeed&apos;s own authorization logic,
              which builds and signs a standards-compliant entry either way.
            </p>
          </DocsSection>

          <DocsSection id="testing" title="Testing">
            <p>Application workspace (root of this repo):</p>
            <CodeBlock label="agrifeed-app">{`pnpm typecheck
pnpm lint
pnpm test
pnpm build`}</CodeBlock>
            <p>Contracts (agrifeed-contract):</p>
            <CodeBlock label="agrifeed-contract">{`cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings`}</CodeBlock>
            <DocsTable
              headers={["Layer", "Covers"]}
              rows={[
                ["Contract tests (cargo test)", "Oracle submission/threshold/finalization logic, PriceFloor initialize/fund/settle/cancel authorization and payout arithmetic, run against the Soroban test environment, not a live network."],
                ["SDK tests (packages/sdk)", "Argument encoding, auth-entry construction and merging, error-message handling, deploy address derivation. No live RPC calls."],
                ["Indexer tests (services/indexer)", "Event parsing and poll logic against a test database."],
                ["Web tests (apps/web)", "Formatting and deal-state-machine logic; no browser/Freighter automation."],
              ]}
            />
            <p>
              <StatusBadge tone="neutral">scope</StatusBadge> None of the above is a live,
              automated end-to-end test against real Testnet infrastructure or a real wallet
              extension. Live browser/Freighter verification in this project has so far been
              done manually; settlement and cancellation specifically have real SDK support and
              passing unit tests, but have not been exercised against a live, matured agreement
              in this environment.
            </p>
          </DocsSection>

          <DocsSection id="testnet-deployment" title="Testnet deployment">
            <p>Current values for this deployment, from the running application&apos;s own configuration:</p>
            <DocsTable
              headers={["Variable", "Value"]}
              rows={[
                ["Network", networkLabel()],
                ["Soroban RPC", <CodeBlock key="rpc">{rpc}</CodeBlock>],
                [
                  "AgriFeedOracle contract",
                  oracleId ? <IdentifierDisplay key="oracle" kind="contract" value={oracleId} /> : "not configured in this environment",
                ],
                [
                  "PriceFloor WASM hash (deploy source)",
                  wasmHash ? <CodeBlock key="wasm">{wasmHash}</CodeBlock> : "not configured in this environment",
                ],
                [
                  <span key="legacy">Legacy PriceFloor instance <StatusBadge tone="neutral">demo/legacy</StatusBadge></span>,
                  legacyPricefloorId ? (
                    <IdentifierDisplay key="pf" kind="contract" value={legacyPricefloorId} />
                  ) : (
                    "not configured in this environment"
                  ),
                ],
              ]}
            />
            <p>
              The legacy PriceFloor instance above is a single already-initialized deal kept
              for continuing to fund/settle/cancel one existing agreement; it is never used to
              create a new deal, and it is the only PriceFloor instance the indexer currently
              watches.
            </p>
            <p>
              Environment variables a consuming frontend or service needs (see{" "}
              <code>.env.example</code> for the full list):
            </p>
            <CodeBlock>{`NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_ORACLE_CONTRACT_ID=<deployed AgriFeedOracle address>
NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID=<legacy fallback instance, optional>
NEXT_PUBLIC_PRICEFLOOR_WASM_HASH=<uploaded AgriPriceFloor wasm hash>
NEXT_PUBLIC_INDEXER_API_URL=http://localhost:4000`}</CodeBlock>
            <p>
              Deploying the contracts themselves, adding nodes, setting the threshold, and
              adding tracked commodities is documented step by step in{" "}
              <a
                href="https://github.com/AgriFeed/agrifeed-contract/blob/main/docs/testnet-deployment.md"
                className="text-accent"
                target="_blank"
                rel="noreferrer"
              >
                agrifeed-contract/docs/testnet-deployment.md
              </a>
              , this page does not duplicate it. <code>NODE_RELAYER_SECRET_KEY</code> and any
              other secret-holding variable are never printed here or anywhere in this app.
            </p>
          </DocsSection>

          <DocsSection id="architecture" title="Architecture">
            <p>Read path, oracle side:</p>
            <CodeBlock>{`AgriFeedOracle (contract)
    ↓  events + reads
Node relayer (services/node-relayer)      writes: fetches FAO/IMF, calls submit_price
    ↓
Indexer (services/indexer)                 polls the oracle, writes Postgres, serves REST
    ↓
REST API                                   /commodities, /commodities/:symbol/history, /nodes
    ↓
Next.js app (apps/web)                     Markets, Commodity Detail, Reporting Network`}</CodeBlock>
            <p>PriceFloor path, one deal:</p>
            <CodeBlock>{`deploy.deployInstance          new, uninitialized instance
    ↓
multiparty auth                 farmer + buyer independently authorize
    ↓
initialize                       on-chain, both signatures present
    ↓
fund                             buyer deposits collateral
    ↓
settle  or  cancel                after maturity`}</CodeBlock>
            <p>
              <StatusBadge tone="neutral">current gap</StatusBadge> The indexer only watches the
              Oracle and one fixed, legacy PriceFloor instance. A PriceFloor instance deployed
              through the product&apos;s own deploy-and-initialize flow is real and on-chain,
              but is not picked up by the indexer, and therefore has no REST endpoint and no
              history view on this site. Reading a freshly deployed instance&apos;s state
              today means calling it directly over Soroban RPC. Multi-instance PriceFloor
              indexing is not implemented.
            </p>
          </DocsSection>

          <DocsSection id="methodology" title="Methodology">
            <p>
              The full path from a public statistics agency to an on-chain finalized price is
              documented in{" "}
              <a
                href="https://github.com/AgriFeed/agrifeed-app/blob/main/research/METHODOLOGY.md"
                className="text-accent"
                target="_blank"
                rel="noreferrer"
              >
                research/METHODOLOGY.md
              </a>
              , including exactly which upstream source is used per commodity and why. This
              page summarizes it, it does not restate the full reasoning.
            </p>
            <DocsTable
              headers={["Layer", "What it is"]}
              rows={[
                ["Upstream/public data", "FAO FAOSTAT producer prices and IMF PCPS, fetched by services/node-relayer. AMIS is fetched for diagnostic context only and never contributes to a submitted price, it does not publish prices."],
                ["On-chain oracle logic", "Each node submits the median of whatever upstream sources succeeded that cycle; finalize_price then takes a second median across independent nodes' submissions."],
                ["Indexed data", "services/indexer's own copy of on-chain history and finalizations, served over REST."],
                ["Derived values", "Formatted/display values (e.g. formatPriceWithUnit) computed client-side from indexed or on-chain raw values, never a separately stored number."],
              ]}
            />
          </DocsSection>

          <DocsSection id="contributing" title="Contributing">
            <p>
              Full contribution guidelines, coding standards, and commit conventions live in{" "}
              <a
                href="https://github.com/AgriFeed/agrifeed-app/blob/main/CONTRIBUTING.md"
                className="text-accent"
                target="_blank"
                rel="noreferrer"
              >
                CONTRIBUTING.md
              </a>
              . Summary:
            </p>
            <CodeBlock label="repository structure">{`apps/web            Next.js frontend (pnpm workspace)
packages/sdk         TypeScript SDK (pnpm workspace)
services/indexer      REST API + event indexer (pnpm workspace)
services/node-relayer  Off-chain price submission (pnpm workspace)
research/             Python methodology and backtests (separate from the pnpm workspace)`}</CodeBlock>
            <CodeBlock label="development setup">{`pnpm install
cp .env.example .env.local
docker compose up -d
pnpm --filter @agrifeed/indexer migrate
pnpm dev:web
pnpm dev:indexer`}</CodeBlock>
            <p>
              Before opening a pull request: <code>pnpm typecheck</code>, <code>pnpm lint</code>,{" "}
              <code>pnpm build</code> across the workspace, plus a clean{" "}
              <code>pnpm --filter @agrifeed/indexer migrate</code> to confirm the schema still
              applies. Conventional commits (<code>type(scope): description</code>), one commit
              per logical unit, specific files staged explicitly rather than{" "}
              <code>git add .</code>.
            </p>
          </DocsSection>
        </div>
      </div>
    </main>
  );
}
