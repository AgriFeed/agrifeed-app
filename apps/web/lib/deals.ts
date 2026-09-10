import { getDealsByBuyer, getDealsByFarmer, type Deal } from "./api";

/**
 * Pure helpers behind My Deals (Phase 4 Step 6). Kept separate from any
 * React component so the actual discovery logic -- which two API calls
 * are made, how their results are merged and role-tagged -- is testable
 * without a component-rendering harness (this project has none, see
 * lib/api.test.ts's own existing pattern). Nothing here reads
 * localStorage/sessionStorage or any other client-local store: the only
 * source of truth for "does this deal exist" is what getDealsByFarmer/
 * getDealsByBuyer actually returned from /api/deals.
 */

export type DealRole = "farmer" | "buyer" | "both";

export interface DealWithRole {
  deal: Deal;
  role: DealRole;
}

/**
 * Merges the farmer-filtered and buyer-filtered result sets into one list,
 * de-duplicated by contractId (the canonical identity, see
 * docs/phase4-step5-deals-api.md), tagging each deal with every role the
 * connected address actually holds on it. A deal appearing in both lists
 * (the same address is both farmer and buyer on it -- an edge case the
 * contract itself does not forbid, even though this app's own deal-
 * creation form does, see NewDealFlow.tsx's validateDraft) is tagged
 * "both" and included exactly once, never twice.
 */
export function mergeDealsByRole(farmerDeals: Deal[], buyerDeals: Deal[]): DealWithRole[] {
  const byContractId = new Map<string, DealWithRole>();
  for (const deal of farmerDeals) {
    byContractId.set(deal.contractId, { deal, role: "farmer" });
  }
  for (const deal of buyerDeals) {
    const existing = byContractId.get(deal.contractId);
    byContractId.set(deal.contractId, { deal, role: existing ? "both" : "buyer" });
  }
  return [...byContractId.values()].sort(
    (a, b) => new Date(b.deal.registeredAt).getTime() - new Date(a.deal.registeredAt).getTime(),
  );
}

/**
 * Fetches and merges one address's full deal portfolio. This is the one
 * function My Deals' UI calls: everything it renders traces back to this,
 * and this traces back only to getDealsByFarmer/getDealsByBuyer -- i.e.
 * only to /api/deals. A caller that also happened to have fabricated data
 * sitting in localStorage under some app-chosen key would see none of it
 * here, by construction (there is no read of any storage API anywhere in
 * this call chain) -- see deals.test.ts's dedicated regression test for
 * this.
 */
export async function loadMyDeals(address: string): Promise<DealWithRole[]> {
  const [farmerDeals, buyerDeals] = await Promise.all([getDealsByFarmer(address), getDealsByBuyer(address)]);
  return mergeDealsByRole(farmerDeals, buyerDeals);
}

/**
 * The indexed `commodity` field is the raw native-decoded value of the
 * contract's own Asset union (see docs/phase4-step5-deals-api.md), which
 * is NOT the SDK's `Asset` type shape (`{ tag, values }` --
 * packages/sdk/src/types.ts): scValToNative renders a fieldless-payload
 * union variant like `Other(Symbol)` as a plain 2-element tuple,
 * `["Other", "COCOA"]`, confirmed against this project's own real indexed
 * data (Phase 4 Step 4's settled instance). Never guessed beyond that
 * shape: anything else returns null rather than a wrong symbol.
 */
export function commoditySymbol(commodity: unknown): string | null {
  if (Array.isArray(commodity) && commodity.length === 2 && typeof commodity[0] === "string" && typeof commodity[1] === "string") {
    return commodity[1];
  }
  return null;
}
