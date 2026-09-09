/**
 * Mandatory, non-dismissible notice for any in-progress Price Protection
 * deal (Phase 3 Step 4/9). Deal state lives only in this browser tab's
 * React state — confirmed elsewhere in this codebase that no
 * localStorage/sessionStorage/backend persistence exists for it — so this
 * must be visible for the entire lifetime of a deal in progress, not a
 * one-time toast a user can miss and forget.
 */
export function DealPersistenceNotice({ contractId }: { contractId?: string | null }) {
  return (
    <div className="status-badge w-full justify-start border-status-warning text-status-warning" role="status">
      <span aria-hidden="true">!</span>
      <span>
        This deal exists only in this browser tab.{" "}
        {contractId
          ? "Save the contract ID below if you need to find it again — reloading or closing this page will lose your place."
          : "Reloading or closing this page before it's on-chain will lose your progress."}
      </span>
    </div>
  );
}
