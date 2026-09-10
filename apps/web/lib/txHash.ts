import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { SignAndSend } from "@agrifeed/sdk/wallet";

/**
 * Wraps a real SignAndSend (e.g. freighterSignAndSend(...)) to also capture
 * the resulting transaction's hash, purely by computing it client-side from
 * the signed envelope Freighter returns — the exact same hash the network
 * will assign this transaction, since a transaction's hash is a
 * deterministic function of its own signed contents. This never changes
 * what gets signed or submitted: the real SignAndSend call and its return
 * value pass through completely unmodified, this only observes them.
 *
 * Exists because packages/sdk/src/soroban-tx.ts's submitAndConfirm() (used
 * by every pricefloor/deploy/multiparty write call) only returns the
 * contract's return value, never the transaction hash — and this step
 * needs to show real transaction evidence without changing SDK transaction
 * behavior, which is explicitly out of scope here.
 */
export function withCapturedTxHash(
  signAndSend: SignAndSend,
  onHash: (hash: string) => void,
  networkPassphrase: string,
): SignAndSend {
  return async (unsignedXdr: string) => {
    const signedXdr = await signAndSend(unsignedXdr);
    try {
      const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
      // tx.hash() returns a Uint8Array in this (browser-safe) build, not a
      // Node Buffer — Uint8Array's own .toString() ignores an encoding
      // argument and silently joins the raw byte values as decimal
      // instead, so the hex conversion is done by hand here.
      const bytes = tx.hash();
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      onHash(hex);
    } catch {
      // Purely observational: if hash computation fails for any reason,
      // the real signed transaction still proceeds unaffected below.
    }
    return signedXdr;
  };
}
