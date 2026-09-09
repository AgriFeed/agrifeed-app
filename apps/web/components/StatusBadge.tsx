const TONE = {
  success: { color: "border-status-success text-status-success", glyph: "✓" },
  error: { color: "border-status-error text-status-error", glyph: "✕" },
  warning: { color: "border-status-warning text-status-warning", glyph: "!" },
  info: { color: "border-status-info text-status-info", glyph: "i" },
  pending: { color: "border-status-pending text-status-pending", glyph: "…" },
  neutral: { color: "border-border text-ink-muted", glyph: "–" },
} as const;

export type StatusTone = keyof typeof TONE;

/**
 * Generic semantic status badge (Phase 3 Step 5). Every tone pairs a glyph
 * with the label text, so meaning never depends on color alone — this is
 * the shared primitive every transaction/deal/data state in the app should
 * render through, rather than each screen inventing its own pending/failed
 * treatment.
 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const { color, glyph } = TONE[tone];
  return (
    <span className={`status-badge ${color}`}>
      <span aria-hidden="true">{glyph}</span>
      {children}
    </span>
  );
}
