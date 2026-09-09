import type { PendingAuthEntry, PreparedMultiPartyInvocation, pricefloor } from "@agrifeed/sdk";

type InitializePriceFloorParams = pricefloor.InitializePriceFloorParams;

/**
 * The lifecycle of one AgriPriceFloor deal being created in this browser
 * session: deploy a fresh instance from the WASM hash, then collect BOTH
 * required signatures (farmer, buyer) before submitting `initialize`.
 * Pure state, no React and no network calls, so it is unit-testable
 * directly and the transition rules (what CAN'T happen) are enforced in
 * one place rather than scattered across button `disabled` props.
 */
export type DealStatus =
  | "draft"
  | "deployment_pending"
  | "deployed"
  | "waiting_for_farmer"
  | "waiting_for_buyer"
  | "ready_to_submit"
  | "submitted"
  | "confirmed"
  | "failed";

export interface DealState {
  status: DealStatus;
  draft: InitializePriceFloorParams | null;
  contractId: string | null;
  prepared: PreparedMultiPartyInvocation | null;
  /** Keyed by address. `prepared.pendingAuthEntries` can have 0, 1, or 2
   * members depending on whether the transaction's source account already
   * satisfies one party's requirement implicitly (see multiparty.ts), so
   * "both parties signed" is derived from this, never hardcoded to 2. */
  signedEntries: Record<string, PendingAuthEntry>;
  txHash: string | null;
  error: string | null;
  /** Which status the flow was in when it failed, so a retry can resume
   * from there instead of discarding an already-deployed instance or
   * already-collected signature. */
  failedFrom: DealStatus | null;
}

export const initialDealState: DealState = {
  status: "draft",
  draft: null,
  contractId: null,
  prepared: null,
  signedEntries: {},
  txHash: null,
  error: null,
  failedFrom: null,
};

export type DealAction =
  | { type: "SET_DRAFT"; draft: InitializePriceFloorParams }
  | { type: "DEPLOY_START" }
  | { type: "DEPLOY_SUCCESS"; contractId: string }
  | { type: "DEPLOY_FAILURE"; error: string }
  | { type: "USE_EXISTING_CONTRACT"; contractId: string }
  | { type: "PREPARE_SUCCESS"; prepared: PreparedMultiPartyInvocation }
  | { type: "PREPARE_FAILURE"; error: string }
  | { type: "PARTY_SIGNED"; entry: PendingAuthEntry }
  | { type: "SIGN_FAILURE"; error: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS"; txHash?: string }
  | { type: "SUBMIT_FAILURE"; error: string }
  | { type: "RESET" };

/**
 * Which party (if any) the flow is still waiting on, derived from the real
 * simulated auth entries, never assumed to always be "both." If the
 * transaction's source account happens to be one of farmer/buyer, that
 * party's requirement is satisfied implicitly by the envelope signature
 * (see multiparty.ts's toPendingAuthEntries), so it never appears here and
 * that waiting_for_* status is skipped for them.
 */
export function nextSigningStatus(
  prepared: PreparedMultiPartyInvocation,
  draft: InitializePriceFloorParams,
  signedEntries: Record<string, PendingAuthEntry>,
): "waiting_for_farmer" | "waiting_for_buyer" | "ready_to_submit" {
  const pendingAddresses = new Set(prepared.pendingAuthEntries.map((e) => e.address));
  if (pendingAddresses.has(draft.farmer) && !signedEntries[draft.farmer]) return "waiting_for_farmer";
  if (pendingAddresses.has(draft.buyer) && !signedEntries[draft.buyer]) return "waiting_for_buyer";
  return "ready_to_submit";
}

export function dealReducer(state: DealState, action: DealAction): DealState {
  switch (action.type) {
    case "SET_DRAFT":
      // A draft can only be (re)written before anything has been deployed;
      // changing terms after deployment would deploy one instance and then
      // silently initialize it with different terms.
      if (state.status !== "draft") return state;
      return { ...state, draft: action.draft };

    case "DEPLOY_START":
      if (state.status !== "draft" || !state.draft) return state;
      return { ...state, status: "deployment_pending", error: null, failedFrom: null };

    case "DEPLOY_SUCCESS":
      if (state.status !== "deployment_pending") return state;
      return { ...state, status: "deployed", contractId: action.contractId };

    case "DEPLOY_FAILURE":
      if (state.status !== "deployment_pending") return state;
      return { ...state, status: "failed", error: action.error, failedFrom: "deployment_pending" };

    case "USE_EXISTING_CONTRACT":
      // The legacy/demo fallback path: skip deployment entirely and point
      // the rest of the flow at an already-deployed, already-initialized
      // instance (NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID). Only valid from
      // draft, and only meaningful for fund/settle/cancel afterward, not
      // for re-running initialize against it.
      if (state.status !== "draft") return state;
      return { ...state, status: "confirmed", contractId: action.contractId };

    case "PREPARE_SUCCESS": {
      if (state.status !== "deployed" || !state.draft) return state;
      const status = nextSigningStatus(action.prepared, state.draft, {});
      return { ...state, status, prepared: action.prepared, signedEntries: {} };
    }

    case "PREPARE_FAILURE":
      if (state.status !== "deployed") return state;
      return { ...state, status: "failed", error: action.error, failedFrom: "deployed" };

    case "PARTY_SIGNED": {
      if (state.status !== "waiting_for_farmer" && state.status !== "waiting_for_buyer") return state;
      if (!state.prepared || !state.draft) return state;
      // Defense in depth: even though signAuthEntryAsExpectedParty already
      // refuses to sign for an unexpected address, never trust a single
      // layer alone — an entry for an address this deal doesn't recognize
      // is ignored here too, rather than recorded.
      const isDealParty = action.entry.address === state.draft.farmer || action.entry.address === state.draft.buyer;
      if (!isDealParty) return state;
      const signedEntries = { ...state.signedEntries, [action.entry.address]: action.entry };
      const status = nextSigningStatus(state.prepared, state.draft, signedEntries);
      return { ...state, status, signedEntries };
    }

    case "SIGN_FAILURE":
      if (state.status !== "waiting_for_farmer" && state.status !== "waiting_for_buyer") return state;
      return { ...state, status: "failed", error: action.error, failedFrom: state.status };

    case "SUBMIT_START":
      if (state.status !== "ready_to_submit") return state;
      return { ...state, status: "submitted", error: null };

    case "SUBMIT_SUCCESS":
      if (state.status !== "submitted") return state;
      return { ...state, status: "confirmed", txHash: action.txHash ?? state.txHash };

    case "SUBMIT_FAILURE":
      if (state.status !== "submitted") return state;
      return { ...state, status: "failed", error: action.error, failedFrom: "ready_to_submit" };

    case "RESET":
      return initialDealState;

    default:
      return state;
  }
}

// --- Guards: what the UI is allowed to let the user do right now. ---

export function canDeploy(state: DealState): boolean {
  return state.status === "draft" && state.draft !== null;
}

export function canUseExistingContract(state: DealState): boolean {
  return state.status === "draft";
}

export function canPrepareInitialize(state: DealState): boolean {
  return state.status === "deployed";
}

export function canFarmerSign(state: DealState): boolean {
  return state.status === "waiting_for_farmer";
}

export function canBuyerSign(state: DealState): boolean {
  return state.status === "waiting_for_buyer";
}

export function canSubmitInitialize(state: DealState): boolean {
  return state.status === "ready_to_submit" && state.prepared !== null;
}

/** fund/settle/cancel are all only meaningful once a real, initialized
 * agreement exists on-chain, whether reached via deploy+init in this
 * session or via USE_EXISTING_CONTRACT. */
export function canOperateOnDeal(state: DealState): boolean {
  return state.status === "confirmed" && state.contractId !== null;
}
