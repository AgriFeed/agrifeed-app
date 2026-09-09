type Direction = "up" | "down" | "flat";

function direction(price: string, previous: string): Direction {
  const a = BigInt(price);
  const b = BigInt(previous);
  if (a > b) return "up";
  if (a < b) return "down";
  return "flat";
}

const ARROW: Record<Direction, string> = { up: "▲", down: "▼", flat: "–" };
const COLOR: Record<Direction, string> = {
  up: "text-price-up",
  down: "text-price-down",
  flat: "text-ink-muted",
};
const LABEL: Record<Direction, string> = { up: "up", down: "down", flat: "unchanged" };

/**
 * Shared price-direction primitive (Phase 3 Step 7). The arrow glyph carries
 * the same meaning as the color (up/down/flat), and an sr-only label spells
 * it out, so direction is never communicated by color alone. Takes raw
 * price strings directly (same i128-as-string contract as the rest of the
 * indexer API) rather than a pre-computed delta, so every caller derives
 * direction the same way.
 *
 * Renders nothing when there is no previous price to compare against —
 * a single data point has no direction, and showing a flat dash for it
 * would manufacture a "0% change" that was never actually observed.
 */
export function PriceChange({ price, previousPrice }: { price: string; previousPrice: string | null }) {
  if (previousPrice === null) return null;
  const d = direction(price, previousPrice);
  return (
    <span className={`font-mono text-sm ${COLOR[d]}`}>
      <span aria-hidden="true">{ARROW[d]}</span>
      <span className="sr-only"> {LABEL[d]}</span>
    </span>
  );
}
