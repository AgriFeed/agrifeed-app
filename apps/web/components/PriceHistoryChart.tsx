import type { CommodityHistoryPoint } from "@/lib/api";

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = 12;

/**
 * Plots relative position only, using Number() on the raw i128 string.
 * This is pixel math for an SVG polyline, never a displayed value, so the
 * precision loss above Number.MAX_SAFE_INTEGER (irrelevant at real
 * commodity price scales) is acceptable here in a way it would not be for
 * on-screen text. Every price shown as text still goes through
 * formatPrice()'s string-safe path.
 */
export function PriceHistoryChart({ points }: { points: CommodityHistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="card flex h-[200px] items-center justify-center">
        <p className="text-sm text-ink-muted">not enough history to plot yet</p>
      </div>
    );
  }

  const chronological = [...points].reverse();
  const values = chronological.map((p) => Number(BigInt(p.price)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const coords = values.map((value, i) => {
    const x = PADDING + (i / (chronological.length - 1)) * (WIDTH - PADDING * 2);
    const y = HEIGHT - PADDING - ((value - min) / range) * (HEIGHT - PADDING * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <div className="card p-4">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[200px] w-full" preserveAspectRatio="none">
        <polyline points={coords.join(" ")} fill="none" stroke="#e0a72b" strokeWidth={1.5} />
      </svg>
    </div>
  );
}
