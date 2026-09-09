/**
 * Reporting-node COUNT only (Phase 3 Step 7). Deliberately a separate
 * component from ContributorList: a count of how many nodes are currently
 * authorized/reporting is not the same claim as knowing which specific
 * nodes contributed to one finalized price, and the two must never be
 * rendered as if they were interchangeable (see the Phase 3 Step 1 audit's
 * explicit warning against blurring these).
 */
export function NodeCount({ reporting, total }: { reporting: number; total: number }) {
  return (
    <span className="font-mono text-xs text-ink-muted">
      {reporting}/{total} nodes reporting
    </span>
  );
}
