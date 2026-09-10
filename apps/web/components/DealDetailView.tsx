import Link from "next/link";
import { formatPrice } from "@agrifeed/sdk";
import { DealFieldRow } from "@/components/DealFieldRow";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { IndexedDealStatusBadge } from "@/components/IndexedDealStatusBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Freshness } from "@/components/Freshness";
import { commoditySymbol } from "@/lib/deals";
import type { Deal } from "@/lib/api";

function formattedOrRaw(raw: string | null, decimals: number | null): string {
  if (raw === null) return "—";
  if (decimals === null) return `${raw} (raw indexed units — commodity decimals unavailable)`;
  return formatPrice(raw, decimals).formatted;
}

/**
 * What this deal's status actually still needs from a user, distinguished
 * from what browser-session state is and isn't recoverable (Phase 4 Step
 * 6's core requirement). Deliberately never claims to resume an
 * in-progress signing session: opening this page recovers the persisted
 * *record*, never the React state of whatever browser tab originally
 * built it (see NewDealFlow.tsx's own same-session limitation, unchanged
 * by this step). The "continue" links below hand the recovered contract
 * id to Price Protection's existing same-session Fund/Settle/Cancel
 * steps, exactly the same action a fresh visitor could take by pasting in
 * this contract id manually -- this page only saves that step, it does
 * not add any new signing capability.
 */
function RecoveryGuidance({ deal }: { deal: Deal }) {
  const continueHref = (step: "fund" | "settle-cancel") =>
    `/demo?contractId=${encodeURIComponent(deal.contractId)}&step=${step}`;

  switch (deal.status) {
    case "registered":
      return (
        <div className="card border-status-warning p-4">
          <StatusBadge tone="warning">registered, never initialized (as far as this indexer has seen)</StatusBadge>
          <p className="mt-2 text-sm text-ink-muted">
            This contract was registered for discovery but the indexer has never observed an{" "}
            <code>Initialized</code> event for it. If this was mid-signing in a browser tab that
            was closed or reloaded, that session&apos;s draft terms and any signatures collected
            so far are gone for good — they were never persisted anywhere, on this indexer or
            otherwise. The only way forward is to start over with a new deal, or, if you still
            have the original terms, initialize this same contract id again with a fresh
            two-party signing session.
          </p>
        </div>
      );
    case "initialized":
      return (
        <div className="card border-status-info p-4">
          <StatusBadge tone="info">initialized, awaiting funding</StatusBadge>
          <p className="mt-2 text-sm text-ink-muted">
            Both parties&apos; authorizations are on-chain. The buyer still needs to fund this
            agreement — a separate, later transaction from initialize.
          </p>
          <Link
            href={continueHref("fund")}
            className="mt-3 inline-block border border-accent px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent hover:text-void"
          >
            Continue to fund this deal
          </Link>
        </div>
      );
    case "funded":
      return (
        <div className="card border-status-pending p-4">
          <StatusBadge tone="pending">funded, awaiting settlement</StatusBadge>
          <p className="mt-2 text-sm text-ink-muted">
            Collateral is in the contract. Once this deal has matured, anyone may call settle;
            either party may cancel once the applicable grace period has elapsed.
          </p>
          <Link
            href={continueHref("settle-cancel")}
            className="mt-3 inline-block border border-accent px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent hover:text-void"
          >
            Continue to settle or cancel
          </Link>
        </div>
      );
    case "settled":
      return (
        <div className="card border-status-success p-4">
          <StatusBadge tone="success">settled — no action needed</StatusBadge>
          <p className="mt-2 text-sm text-ink-muted">
            This agreement has settled. The indexed record only carries the settlement{" "}
            <em>timestamp</em>, not the payout amount or market price used — those are part of
            the real on-chain <code>Settled</code> event, not the summary this registry keeps;
            read the transaction directly for that detail.
          </p>
        </div>
      );
    case "cancelled":
      return (
        <div className="card p-4">
          <StatusBadge tone="neutral">cancelled — no action needed</StatusBadge>
          <p className="mt-2 text-sm text-ink-muted">
            This status is set exclusively from a real, observed <code>Cancelled</code> event —
            never inferred from missing funding or missing settlement. Live cancellation itself
            remains unverified end to end in this environment (see{" "}
            <Link href="/docs#pricefloor" className="text-accent hover:underline">
              Developers &amp; Docs
            </Link>
            ); this page does not present cancellation as a live-proven action, only reports what
            the indexer actually recorded.
          </p>
        </div>
      );
    default:
      return null;
  }
}

export function DealDetailView({ deal, decimals }: { deal: Deal; decimals: number | null }) {
  const symbol = commoditySymbol(deal.commodity);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <IndexedDealStatusBadge status={deal.status} />
        <IdentifierDisplay kind="contract" value={deal.contractId} />
      </div>

      <p className="border border-status-info p-3 text-xs text-ink-muted" role="note">
        Everything below is the indexer&apos;s last-recorded state for this contract — a read of
        its database, not a live Soroban RPC call made just now. See{" "}
        <Link href="/docs#rest-api" className="text-accent hover:underline">
          REST API
        </Link>{" "}
        for exactly what backs each field.
      </p>

      <RecoveryGuidance deal={deal} />

      <section aria-labelledby="deal-terms-heading" className="card p-4">
        <h2 id="deal-terms-heading" className="text-sm font-medium text-ink-primary">
          Terms
        </h2>
        <div className="mt-2">
          <DealFieldRow label="Commodity">
            <span className="font-mono">{symbol ?? "unavailable"}</span>
          </DealFieldRow>
          <DealFieldRow label="Farmer">
            {deal.farmer ? <IdentifierDisplay kind="address" value={deal.farmer} /> : "unavailable"}
          </DealFieldRow>
          <DealFieldRow label="Buyer">
            {deal.buyer ? <IdentifierDisplay kind="address" value={deal.buyer} /> : "unavailable"}
          </DealFieldRow>
          <DealFieldRow label="Floor price">
            <span className="font-mono">{formattedOrRaw(deal.floorPrice, decimals)}</span>
          </DealFieldRow>
          <DealFieldRow label="Notional">
            <span className="font-mono">{formattedOrRaw(deal.notional, decimals)}</span>
          </DealFieldRow>
          <DealFieldRow label="Maturity">
            <span className="font-mono">{deal.maturityTs ? new Date(deal.maturityTs).toUTCString() : "unavailable"}</span>
          </DealFieldRow>
          <DealFieldRow label="Settlement token">
            {deal.settlementToken ? (
              <IdentifierDisplay kind="contract" value={deal.settlementToken} />
            ) : (
              "not yet read from instance storage"
            )}
          </DealFieldRow>
          <DealFieldRow label="Oracle">
            {deal.oracleContractId ? (
              <IdentifierDisplay kind="contract" value={deal.oracleContractId} />
            ) : (
              "not yet read from instance storage"
            )}
          </DealFieldRow>
        </div>
      </section>

      <section aria-labelledby="deal-lifecycle-heading" className="card p-4">
        <h2 id="deal-lifecycle-heading" className="text-sm font-medium text-ink-primary">
          Lifecycle timestamps
        </h2>
        <div className="mt-2">
          <DealFieldRow label="Registered">
            <Freshness timestamp={deal.registeredAt} /> (ledger {deal.registeredAtLedger})
          </DealFieldRow>
          <DealFieldRow label="Initialized">
            {deal.initializedAt ? <Freshness timestamp={deal.initializedAt} /> : "not yet observed"}
          </DealFieldRow>
          <DealFieldRow label="Funded">
            {deal.fundedAt ? <Freshness timestamp={deal.fundedAt} /> : "not yet observed"}
          </DealFieldRow>
          <DealFieldRow label="Settled">
            {deal.settledAt ? <Freshness timestamp={deal.settledAt} /> : "not yet observed"}
          </DealFieldRow>
          <DealFieldRow label="Cancelled">
            {deal.cancelledAt ? <Freshness timestamp={deal.cancelledAt} /> : "not yet observed"}
          </DealFieldRow>
        </div>
      </section>
    </div>
  );
}
