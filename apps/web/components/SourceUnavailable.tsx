export function SourceUnavailable({ what }: { what: string }) {
  return (
    <div className="card p-8 text-center" role="alert">
      <p className="status-badge mx-auto w-fit border-status-error text-status-error">
        <span aria-hidden="true">✕</span>
        source unavailable
      </p>
      <p className="mt-3 text-sm text-ink-muted">
        {what} could not be read from the indexer. This is shown honestly rather than
        substituted with a fabricated value.
      </p>
    </div>
  );
}
