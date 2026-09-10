import Link from "next/link";
import { formatPrice } from "@agrifeed/sdk";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { IndexedDealStatusBadge } from "@/components/IndexedDealStatusBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Freshness } from "@/components/Freshness";
import { commoditySymbol, type DealRole } from "@/lib/deals";
import type { Deal } from "@/lib/api";

const ROLE_LABEL: Record<DealRole, string> = {
  farmer: "you are the farmer",
  buyer: "you are the buyer",
  both: "you are both farmer and buyer",
};

/**
 * One deal in My Deals' list (Phase 4 Step 6). The card's heading is a
 * real `<Link>` -- keyboard "select a deal" is native tab+Enter with no
 * extra ARIA plumbing -- rather than the whole card being one giant
 * `<a>`: `IdentifierDisplay` below renders its own interactive
 * `<details>`/copy `<button>`, and nesting those inside an anchor is
 * invalid HTML and breaks keyboard/screen-reader navigation (the same
 * reason Freshness.tsx offers a non-interactive mode for use inside a
 * link). `contractId` is the canonical identity, so that is what the link
 * navigates by (`/deals/:contractId`), never an array index or any other
 * locally-invented key.
 */
export function DealCard({ deal, role, decimals }: { deal: Deal; role: DealRole; decimals: number | null }) {
  const symbol = commoditySymbol(deal.commodity);

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          <Link
            href={`/deals/${encodeURIComponent(deal.contractId)}`}
            className="text-ink-primary underline decoration-border underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
          >
            {symbol ? `${symbol} price protection` : "Price protection deal"}
          </Link>
        </h2>
        <IndexedDealStatusBadge status={deal.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <IdentifierDisplay kind="contract" value={deal.contractId} />
        <StatusBadge tone="neutral">{ROLE_LABEL[role]}</StatusBadge>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-ink-muted">Floor price</dt>
          <dd className="font-mono text-ink-primary">
            {deal.floorPrice !== null && decimals !== null ? formatPrice(deal.floorPrice, decimals).formatted : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Notional</dt>
          <dd className="font-mono text-ink-primary">
            {deal.notional !== null && decimals !== null ? formatPrice(deal.notional, decimals).formatted : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Maturity</dt>
          <dd className="font-mono text-ink-primary">{deal.maturityTs ? new Date(deal.maturityTs).toUTCString() : "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Registered</dt>
          <dd>
            <Freshness timestamp={deal.registeredAt} interactive={false} />
          </dd>
        </div>
      </dl>
    </article>
  );
}
