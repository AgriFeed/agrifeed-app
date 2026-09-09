import { rpc as StellarRpc, xdr } from "@stellar/stellar-sdk";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { OracleError } from "./types.js";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 20;

/**
 * Submits an already-signed transaction and polls until it reaches a final
 * status. Shared by every write path in this SDK, single-signer pricefloor
 * calls (`invokeAndConfirm` in pricefloor.ts) and multi-party ones alike
 * (`submitMultiPartyInvocation` in multiparty.ts), so confirmation behavior
 * (poll interval, attempt count, error shape) stays identical regardless of
 * how the transaction collected its signature(s).
 */
export async function submitAndConfirm(
  server: StellarRpc.Server,
  signedTx: Transaction | FeeBumpTransaction,
  method: string,
): Promise<xdr.ScVal | undefined> {
  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.status === "ERROR") {
    throw new OracleError(`${method} submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      return result.returnValue;
    }
    if (result.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      throw new OracleError(`${method} transaction failed on-chain: ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new OracleError(`${method} transaction ${hash} did not confirm in time`);
}
