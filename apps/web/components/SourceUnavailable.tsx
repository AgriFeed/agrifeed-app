export function SourceUnavailable({ what }: { what: string }) {
  return (
    <div className="card p-8 text-center">
      <p className="font-mono text-sm text-ink-muted">source unavailable</p>
      <p className="mt-2 text-sm text-ink-muted">
        {what} could not be read from the indexer. This is shown honestly rather than
        substituted with a fabricated value.
      </p>
    </div>
  );
}
