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
 * devices without any extra JS state.
 */
export function Freshness({
  timestamp,
  staleAfterSeconds,
  refreshing = false,
}: {
  /** ISO timestamp string. */
  timestamp: string;
  /** If the data is older than this, render the stale treatment. Omit when
   * the caller doesn't know the expected refresh cadence (e.g. resolution
   * isn't loaded yet) rather than guessing a threshold. */
  staleAfterSeconds?: number;
  refreshing?: boolean;
}) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  const isStale = staleAfterSeconds !== undefined && ageSeconds > staleAfterSeconds;

  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs">
      {refreshing && (
        <span className="text-status-info" aria-live="polite">
          refreshing…
        </span>
      )}
      <details className="inline">
        <summary className={`inline cursor-pointer list-none ${isStale ? "text-status-warning" : "text-ink-muted"}`}>
          {isStale ? "stale · " : ""}
          <time dateTime={timestamp}>{relativeAge(timestamp)}</time>
        </summary>
        <span className="ml-1 text-ink-muted">{formatTimestamp(timestamp)}</span>
      </details>
    </span>
  );
}
