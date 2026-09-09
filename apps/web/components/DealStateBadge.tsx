import { StatusBadge, type StatusTone } from "@/components/StatusBadge";

// Mirrors apps/web/lib/dealState.ts's real DealStatus union exactly — this
// is a presentation layer over the actual state machine, not an invented
// parallel vocabulary. If dealState.ts's DealStatus changes, this map must
// change with it rather than silently drifting.
const STATUS: Record<
  "draft" | "deployment_pending" | "deployed" | "waiting_for_farmer" | "waiting_for_buyer" | "ready_to_submit" | "submitted" | "confirmed" | "failed",
  { tone: StatusTone; label: string }
> = {
  draft: { tone: "neutral", label: "draft — nothing on-chain yet" },
  deployment_pending: { tone: "pending", label: "deploying instance…" },
  deployed: { tone: "info", label: "instance deployed" },
  waiting_for_farmer: { tone: "pending", label: "waiting for farmer to sign" },
  waiting_for_buyer: { tone: "pending", label: "waiting for buyer to sign" },
  // Deliberately distinct from "confirmed": every required signature has
  // been collected, but the transaction has not been submitted or landed
  // on-chain yet. Never render this the same way as a confirmed
  // transaction (Phase 3 Step 10's explicit requirement).
  ready_to_submit: { tone: "info", label: "both parties signed — ready to submit" },
  submitted: { tone: "pending", label: "submitted — awaiting confirmation" },
  confirmed: { tone: "success", label: "confirmed on-chain" },
  failed: { tone: "error", label: "failed" },
};

export type DealDisplayStatus = keyof typeof STATUS;

/**
 * Deal lifecycle status badge (Phase 3 Step 10). Not wired into any page
 * yet — this is the shared vocabulary the Price Protection redesign will
 * consume. "signed" (an individual party's auth entry collected — see
 * ParticipantAuthStatus) and "confirmed" (the assembled transaction has
 * actually landed on-chain) are intentionally never the same badge.
 */
export function DealStateBadge({ status }: { status: DealDisplayStatus }) {
  const { tone, label } = STATUS[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/**
 * Funding is not part of dealState.ts's DealStatus (it's tracked as its own
 * action, independent of the initialize lifecycle — see DemoFlow.tsx's
 * FundForm). Kept as a separate badge rather than folded into
 * DealStateBadge so this component never implies funding is a step in the
 * same state machine as initialize.
 */
export function FundedBadge({ funded }: { funded: boolean }) {
  return funded ? <StatusBadge tone="success">funded</StatusBadge> : <StatusBadge tone="neutral">not yet funded</StatusBadge>;
}
