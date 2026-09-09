import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";

/**
 * Route-scoped not-found page (Next.js App Router convention) for
 * /commodity/[symbol] only — does not affect any other route's 404
 * behavior. Without this, Next's built-in default 404 (unstyled, dark)
 * rendered here regardless of the rest of the app's light palette, which
 * is its own kind of visual inconsistency this page's redesign should
 * not leave in place. Distinct from "insufficient history" (Step 12B) and
 * "no submissions/finalizations yet" (Step 12C): this is specifically "no
 * such commodity is tracked at all."
 */
export default function CommodityNotFound() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Link href="/" className="text-sm text-ink-muted transition-colors hover:text-ink-primary">
        ← Markets
      </Link>
      <div className="mt-6">
        <EmptyState>
          This symbol isn&apos;t tracked by the AgriFeedOracle contract. Check{" "}
          <Link href="/" className="text-accent hover:underline">
            Markets
          </Link>{" "}
          for the commodities currently indexed.
        </EmptyState>
      </div>
    </main>
  );
}
