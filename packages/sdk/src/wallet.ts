import {
  getAddress,
  isConnected,
  requestAccess,
  signAuthEntry,
  signTransaction,
} from "@stellar/freighter-api";
import { OracleError } from "./types.js";
import type { PendingAuthEntry } from "./types.js";
import { assertExpectedSigner } from "./multiparty.js";

/** Signs a base64 transaction XDR and returns the signed base64 XDR. */
export type SignAndSend = (unsignedXdr: string) => Promise<string>;

export interface FreighterConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

export async function isFreighterInstalled(): Promise<boolean> {
  const result = await isConnected();
  if (result.error) return false;
  return true;
}

/**
 * Requests access to the user's Freighter wallet. Must be called from a
 * user gesture (a click handler), Freighter will reject silent calls.
 */
export async function connectFreighter(): Promise<FreighterConnection> {
  const access = await requestAccess();
  if (access.error) {
    throw new OracleError(`Freighter access denied: ${access.error.message}`);
  }

  return {
    publicKey: access.address,
    network: "",
    networkPassphrase: "",
  };
}

export async function getConnectedAddress(): Promise<string | null> {
  const result = await getAddress();
  if (result.error || !result.address) return null;
  return result.address;
}

/**
 * Returns a SignAndSend closure bound to the given network passphrase, for
 * passing into packages/sdk/pricefloor.ts write calls.
 */
export function freighterSignAndSend(networkPassphrase: string): SignAndSend {
  return async (unsignedXdr: string) => {
    const result = await signTransaction(unsignedXdr, { networkPassphrase });
    if (result.error) {
      throw new OracleError(`Freighter signing failed: ${result.error.message}`);
    }
    return result.signedTxXdr;
  };
}

/**
 * Has the connected Freighter wallet sign one address's share of a
 * multi-party Soroban invocation (see multiparty.ts). This is a genuinely
 * separate signing operation from `freighterSignAndSend`: an outer
 * transaction envelope signature only ever covers the transaction's own
 * source account, never a different address's `SorobanAuthorizationEntry`.
 * Each party in a multi-party call must independently call this, from
 * their own Freighter session, on their own `PendingAuthEntry`.
 *
 * `pending.address` is passed as the signing hint (`opts.address`) so
 * Freighter can refuse if the connected account does not match the
 * address this entry actually authorizes, rather than silently signing
 * with the wrong key.
 */
export async function signAuthEntryWithFreighter(
  pending: PendingAuthEntry,
  networkPassphrase: string,
): Promise<PendingAuthEntry> {
  const result = await signAuthEntry(pending.entryXdr, {
    networkPassphrase,
    address: pending.address,
  });
  if (result.error || !result.signedAuthEntry) {
    const reason = result.error?.message ?? "no signed entry was returned";
    throw new OracleError(`Freighter auth entry signing failed for ${pending.address}: ${reason}`);
  }
  return { address: pending.address, entryXdr: result.signedAuthEntry };
}

/**
 * Like `signAuthEntryWithFreighter`, but verifies the currently connected
 * Freighter account is actually the party this entry is for *before*
 * requesting a signature, rather than relying on the user's say-so or on
 * Freighter's own (extension-side) refusal. `role` is a readable label
 * ("farmer", "buyer") used only in the rejection message.
 *
 * This is the function every multi-party signing step in the UI should
 * call, never `signAuthEntryWithFreighter` directly, so a wrong-wallet
 * mismatch is always caught before a signature is ever requested.
 */
export async function signAuthEntryAsExpectedParty(
  pending: PendingAuthEntry,
  role: string,
  networkPassphrase: string,
): Promise<PendingAuthEntry> {
  const connected = await getConnectedAddress();
  assertExpectedSigner(connected, pending.address, role);
  return signAuthEntryWithFreighter(pending, networkPassphrase);
}
