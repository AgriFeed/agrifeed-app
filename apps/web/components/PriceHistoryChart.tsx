import type { CommodityHistoryPoint } from "@/lib/api";
import { formatPrice, commodityUnit } from "@agrifeed/sdk";
import { formatTimestamp } from "@/lib/time";

const WIDTH = 720;
const HEIGHT = 220;
const PAD_X = 56;
const PAD_Y = 20;

function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * FINALIZED price history only — one point per finalize_price call
 * (price_history / price_finalizations), never a raw node submission. See
 * the page's own "Finalized prices" and "Individual node submissions"
 * sections for that distinction; this chart never mixes the two.
 *
 * Plots relative position only, using Number() on the raw i128 string.
 * This is pixel math for an SVG polyline, never a displayed value, so the
 * precision loss above Number.MAX_SAFE_INTEGER (irrelevant at real
 * commodity price scales) is acceptable here in a way it would not be for
 * on-screen text. Every price shown as text still goes through
 * formatPrice()'s string-safe path.
 */
export function PriceHistoryChart({
  points,
  decimals,
  symbol,
}: {
  points: CommodityHistoryPoint[];
  decimals: number;
  symbol: string;
}) {
  if (points.length === 0) {
    return (
      <div className="card flex h-[220px] items-center justify-center p-4 text-center">
        <p className="text-sm text-ink-muted">No finalized prices indexed for {symbol} yet.</p>
      </div>
    );
  }
  if (points.length === 1) {
    return (
      <div className="card flex h-[220px] flex-col items-center justify-center gap-1 p-4 text-center">
        <p className="text-sm text-ink-muted">
          Only one finalized price indexed so far — at least two are needed to plot a trend.
        </p>
        <p className="font-mono text-sm text-ink-primary">
          {formatPrice(points[0]!.price, decimals).formatted} {commodityUnit(symbol)} ·{" "}
          {formatTimestamp(points[0]!.timestamp)}
        </p>
      </div>
    );
  }

  const chronological = [...points].reverse();
  const values = chronological.map((p) => Number(BigInt(p.price)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const coords = values.map((value, i) => {
    const x = PAD_X + (i / (chronological.length - 1)) * (WIDTH - PAD_X - PAD_Y);
    const y = HEIGHT - PAD_Y - ((value - min) / range) * (HEIGHT - PAD_Y * 2);
    return { x, y };
  });

  const minLabel = formatPrice(String(BigInt(min)), decimals).formatted;
  const maxLabel = formatPrice(String(BigInt(max)), decimals).formatted;
  const first = chronological[0]!;
  const last = chronological[chronological.length - 1]!;

  const summary = `${chronological.length} finalized prices for ${symbol}, from ${shortDate(first.timestamp)} to ${shortDate(
    last.timestamp,
  )}, ranging from ${minLabel} to ${maxLabel} ${commodityUnit(symbol)}.`;

  return (
    <div className="card p-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[220px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        {/* Y-axis: price range only, no gridlines — the shape of the line
            carries the trend, these two labels anchor its scale. */}
        <text x={4} y={PAD_Y + 4} className="fill-ink-muted font-mono" fontSize="11">
          {maxLabel}
        </text>
        <text x={4} y={HEIGHT - PAD_Y + 4} className="fill-ink-muted font-mono" fontSize="11">
          {minLabel}
        </text>
        {/* X-axis: first and last finalization date only. */}
        <text x={PAD_X} y={HEIGHT - 4} className="fill-ink-muted font-mono" fontSize="11">
          {shortDate(first.timestamp)}
        </text>
        <text x={WIDTH - PAD_Y} y={HEIGHT - 4} textAnchor="end" className="fill-ink-muted font-mono" fontSize="11">
          {shortDate(last.timestamp)}
        </text>

        <polyline
          points={coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")}
          fill="none"
          className="stroke-accent"
          strokeWidth={1.5}
        />
        {coords.map((c, i) => (
          <circle key={chronological[i]!.timestamp} cx={c.x} cy={c.y} r={2.5} className="fill-accent">
            <title>{`${formatPrice(chronological[i]!.price, decimals).formatted} ${commodityUnit(symbol)} · ${formatTimestamp(chronological[i]!.timestamp)}`}</title>
          </circle>
        ))}
      </svg>
      <p className="mt-3 text-xs text-ink-muted">{summary}</p>
    </div>
  );
}
