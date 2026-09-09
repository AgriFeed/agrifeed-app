/**
 * Shared empty-data state (Phase 3 Step 5/9) — distinct from ErrorState:
 * the source answered successfully and genuinely has nothing yet, which is
 * real information, not a failure.
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}
