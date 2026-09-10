import Link from "next/link";

/**
 * Mandatory, non-dismissible notice for any in-progress Price Protection
 * deal (Phase 3 Step 4/9, updated Phase 4 Step 6). The *signing session*
 * — the draft terms, whichever authorizations have been collected so far
 * — lives only in this browser tab's React state and is never persisted
 * anywhere; reloading or closing this tab before initialize is submitted
 * loses that progress for good, with no way to recover it, here or
 * anywhere else.
 *
 * Once a contract id exists, that is a different fact: it has already
 * been registered with the indexer (see NewDealFlow.tsx's own
 * registration effect), so the contract itself — not the in-progress
 * signing state — is discoverable afterward via My Deals, by address,
 * with no need to have manually saved this id. This notice says both
 * things plainly rather than only the first, which was true but no
 * longer the whole story once Phase 4's registry shipped.
 */
export function DealPersistenceNotice({ contractId }: { contractId?: string | null }) {
  return (
    <div className="status-badge w-full flex-col items-start gap-1 border-status-warning text-status-warning" role="status">
      <span>
        <span aria-hidden="true">!</span> This browser tab&apos;s signing progress is not saved
        anywhere. Reloading or closing this page before initialize is submitted loses any
        signatures collected so far, for good.
      </span>
      {contractId && (
        <span className="text-ink-muted">
          The deployed contract itself is a different matter: once registered, it stays
          discoverable afterward via{" "}
          <Link href="/deals" className="text-accent hover:underline">
            My Deals
          </Link>{" "}
          — you do not need to save the contract ID below by hand for that.
        </span>
      )}
    </div>
  );
}
