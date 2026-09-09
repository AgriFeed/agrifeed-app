/**
 * Page-level stale-data banner (Phase 3 Step 5/9). Distinct from
 * ErrorState/SourceUnavailable: the data loaded successfully and is being
 * shown, it's just older than expected. Existing data must never
 * disappear merely because it's stale or because a background refresh is
 * in progress — this banner sits alongside content, it never replaces it.
 */
export function StaleBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="status-badge w-full justify-start border-status-warning text-status-warning" role="status">
      <span aria-hidden="true">!</span>
      <span>{children}</span>
    </div>
  );
}
