import { StatusBadge, type StatusTone } from "@/components/StatusBadge";
import type { Deal } from "@/lib/api";

/**
 * The indexed registry's own lifecycle status (Phase 4 Steps 2-5:
 * registered/initialized/funded/settled/cancelled), deliberately a
 * separate component from DealStateBadge (Phase 3): that one renders
 * dealState.ts's browser-local signing-session states (draft, waiting for
 * farmer, ready to submit, ...), a completely different vocabulary that
 * exists only for the lifetime of an in-progress browser tab. This one
 * renders what the indexer has actually observed on-chain for a deal that
 * may have been created in a different session entirely, possibly by
 * someone else (My Deals only ever shows a deal to its farmer/buyer, but
 * the record itself was not necessarily created by the viewer's own
 * browser session).
 *
 * "cancelled" is rendered with the same weight as "settled" -- a real,
 * legitimate terminal outcome -- not as an error tone, and its label says
 * plainly that it is event-derived, tying back to the real contract gap
 * documented in docs/phase4-step4-lifecycle-and-decision.md: this badge
 * (and everything upstream of it) can only ever reflect a real observed
 * Cancelled event, never a storage snapshot.
 */
const STATUS: Record<Deal["status"], { tone: StatusTone; label: string }> = {
  registered: { tone: "neutral", label: "registered — not yet initialized" },
  initialized: { tone: "info", label: "initialized — not yet funded" },
  funded: { tone: "pending", label: "funded — awaiting settlement" },
  settled: { tone: "success", label: "settled" },
  cancelled: { tone: "neutral", label: "cancelled (event-observed)" },
};

export function IndexedDealStatusBadge({ status }: { status: string }) {
  const entry = STATUS[status as Deal["status"]];
  if (!entry) return <StatusBadge tone="neutral">{status}</StatusBadge>;
  return <StatusBadge tone={entry.tone}>{entry.label}</StatusBadge>;
}
