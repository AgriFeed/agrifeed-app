import {
  getAddress,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { OracleError } from "./types.js";

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
    throw new OracleError(`Freighter access denied: ${access.error}`);
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
      throw new OracleError(`Freighter signing failed: ${result.error}`);
    }
    return result.signedTxXdr;
  };
}
