/**
 * Distinguishes a finalized (aggregated, on-chain-recorded) price from a
 * single node's raw submission (Phase 3 Step 7). These are different
 * claims — one is the oracle's own settled record, the other is one
 * party's individual, unaggregated input to it — and must never share a
 * label or visual treatment that implies they're the same kind of number.
 */
export function ProvenanceTag({ kind }: { kind: "finalized" | "submission" }) {
  if (kind === "finalized") {
    return (
      <span className="status-badge border-accent text-accent">
        <span aria-hidden="true">◆</span>
        finalized
      </span>
    );
  }
  return (
    <span className="status-badge border-border text-ink-muted">
      <span aria-hidden="true">○</span>
      submission
    </span>
  );
}
