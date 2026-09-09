"use client";

import { formatTimestamp, relativeAge } from "@/lib/time";

/**
 * Reusable freshness treatment (Phase 3 Step 6). Every timestamp-backed
 * value in the app (a price, a finalization, a node's last submission)
 * should render through this component rather than a bare relativeAge()
 * call, so "stale" gets a consistent, explicit treatment everywhere
 * instead of being silently left to the reader to notice.
 *
 * Deliberately does not change the underlying polling architecture: this
 * only presents whatever timestamp it's given. "Stale" here means "older
 * than the caller says to expect," not a live re-check against the chain.
 *
 * The absolute timestamp is revealed via a native <details> disclosure
 * (not a hover-only tooltip), so it's reachable by keyboard and on touch
 * devices without any extra JS state — except when `interactive` is false,
 * for use inside an already-interactive ancestor (e.g. a row that is
 * itself a link): nesting a <details>/<summary> inside an <a> makes a
 * click ambiguous between "toggle" and "navigate" and is invalid HTML.
 * In that mode the absolute timestamp is still available, via the native
 * `title` tooltip on the <time> element, which adds no interactive
 * element of its own.
 */
export function Freshness({
  timestamp,
  staleAfterSeconds,
  refreshing = false,
  interactive = true,
}: {
  /** ISO timestamp string. */
  timestamp: string;
  /** If the data is older than this, render the stale treatment. Omit when
   * the caller doesn't know the expected refresh cadence (e.g. resolution
   * isn't loaded yet) rather than guessing a threshold. */
  staleAfterSeconds?: number;
  refreshing?: boolean;
  /** Set to false when rendering inside another interactive element (e.g.
   * a link wrapping the whole row) so this never nests a second
   * interactive control inside it. */
  interactive?: boolean;
}) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  const isStale = staleAfterSeconds !== undefined && ageSeconds > staleAfterSeconds;
  const staleClass = isStale ? "text-status-warning" : "text-ink-muted";

  const label = (
    <>
      {isStale ? "stale · " : ""}
      <time dateTime={timestamp}>{relativeAge(timestamp)}</time>
    </>
  );

  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs">
      {refreshing && (
        <span className="text-status-info" aria-live="polite">
          refreshing…
        </span>
      )}
      {interactive ? (
        <details className="inline">
          <summary className={`inline cursor-pointer list-none ${staleClass}`}>{label}</summary>
          <span className="ml-1 text-ink-muted">{formatTimestamp(timestamp)}</span>
        </details>
      ) : (
        <span className={staleClass} title={formatTimestamp(timestamp)}>
          {label}
        </span>
      )}
    </span>
  );
}
