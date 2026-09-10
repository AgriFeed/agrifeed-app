/**
 * Shared label/value row for displaying one deal term (Phase 3 Step 8's
 * DealSummary originally defined this inline; extracted in Phase 4 Step 6
 * so My Deals' deal cards and detail view render terms through the exact
 * same visual pattern rather than a second, similar-looking one). Stacks
 * vertically on narrow viewports, horizontal label/value on `sm:` and up.
 */
export function DealFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 sm:flex-row sm:items-baseline sm:justify-between">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="text-sm text-ink-primary">{children}</span>
    </div>
  );
}
