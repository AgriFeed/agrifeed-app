import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { StatusBadge } from "@/components/StatusBadge";

export type ParticipantAuthState =
  | "disconnected"
  | "wrong-wallet"
  | "ready-to-sign"
  | "signing"
  | "signed"
  | "rejected";

/**
 * Shared wallet presentation primitive for one participant's (farmer's or
 * buyer's) two-party authorization step (Phase 3 Step 9/Step 10). Purely
 * presentational — takes the expected address, the currently-connected
 * address, and a state, and renders the right explicit combination. Does
 * not call Freighter or any SDK function itself; the caller (the future
 * Price Protection page) is responsible for driving `state` from the real
 * connection/signing flow in packages/sdk/src/wallet.ts and
 * multiparty.ts, unchanged.
 *
 * Deliberately keeps "signed" (this participant's auth entry has been
 * collected) visually and textually distinct from "transaction confirmed"
 * (the whole multi-party transaction has landed on-chain) — those are
 * different facts, and StatusBadge's caller elsewhere is responsible for
 * the latter, never this component.
 */
export function ParticipantAuthStatus({
  role,
  expectedAddress,
  connectedAddress,
  state,
}: {
  role: "farmer" | "buyer";
  expectedAddress: string;
  connectedAddress: string | null;
  state: ParticipantAuthState;
}) {
  return (
    <div className="card flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-wide text-ink-muted">{role}</span>
        {state === "signed" && <StatusBadge tone="success">signed</StatusBadge>}
        {state === "signing" && <StatusBadge tone="pending">waiting for signature</StatusBadge>}
        {state === "ready-to-sign" && <StatusBadge tone="neutral">not yet signed</StatusBadge>}
        {state === "wrong-wallet" && <StatusBadge tone="error">wrong wallet connected</StatusBadge>}
        {state === "rejected" && <StatusBadge tone="error">signature declined</StatusBadge>}
        {state === "disconnected" && <StatusBadge tone="neutral">wallet not connected</StatusBadge>}
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">expected</span>
          <IdentifierDisplay kind="address" value={expectedAddress} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">connected</span>
          {connectedAddress ? (
            <IdentifierDisplay kind="address" value={connectedAddress} />
          ) : (
            <span className="text-ink-muted">none</span>
          )}
        </div>
      </div>

      {state === "wrong-wallet" && connectedAddress && (
        <p className="text-xs text-status-error">
          Switch the connected wallet to the {role}&apos;s account ({expectedAddress}) before signing.
        </p>
      )}
    </div>
  );
}
