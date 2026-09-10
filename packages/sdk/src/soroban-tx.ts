import { rpc as StellarRpc, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { FeeBumpTransaction } from "@stellar/stellar-sdk";
import { OracleError, TxTooLateError } from "./types.js";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 20;

/**
 * How long, from the moment `refreshTimeBounds` is called, a transaction's
 * outer envelope stays valid for submission (Phase 5 Step 4). Not the
 * original 60 seconds every write path used to set once, at build time,
 * before simulation and before the human ever saw a signing prompt: three
 * consecutive real `tx_too_late` failures during Phase 4 Step 4's live
 * deploy verification proved that budget insufficient once RPC round-trip
 * latency and real wallet-approval time were both taken out of it before
 * the human's own reaction time even started. 180 seconds is a deliberate,
 * evidence-based widening of the *human-facing* signing window specifically
 * (see `refreshTimeBounds`'s doc comment for why it can be set this late,
 * this generously, without weakening anything) -- not an unexamined bump
 * to every timeout in the codebase.
 */
export const SIGNING_VALIDITY_SECONDS = 180;

/**
 * Rebuilds `tx` with a freshly-computed time-bounds window starting now,
 * discarding whatever window it already carried. Meant to be called as
 * late as possible, immediately before a transaction is handed to a
 * wallet for its final envelope signature, so the validity window covers
 * only the one genuinely unpredictable step left (the human's own
 * approval time), not also the RPC round trips (`getAccount`,
 * `simulateTransaction`/`prepareTransaction`) that already happened
 * before this point, which were previously eating into the same fixed
 * budget the human's approval also had to fit inside.
 *
 * Safe to call on any transaction that has **not yet been signed**: this
 * changes only the envelope's own time bounds via `TransactionBuilder`,
 * never operations, fee, resource footprint, or Soroban authorization
 * entries. Soroban authorization is independently gated by each entry's
 * own `signatureExpirationLedger` (a ledger-based expiry Soroban tracks
 * separately, confirmed against `@stellar/stellar-sdk`'s own XDR types),
 * not by the envelope's time bounds at all -- so refreshing the envelope's
 * timeBounds here never invalidates, re-derives, or requires re-collecting
 * any party's already-signed `SorobanAuthorizationEntry` (see
 * `multiparty.ts`'s `submitMultiPartyInvocation`, the one caller that
 * applies this to a transaction carrying other parties' entries).
 *
 * Must never be called on an already-signed transaction: time bounds are
 * part of what gets hashed and signed, so mutating them afterward silently
 * invalidates that signature rather than producing a clear error.
 */
export function refreshTimeBounds(tx: Transaction, validitySeconds: number = SIGNING_VALIDITY_SECONDS): Transaction {
  const builder = TransactionBuilder.cloneFrom(tx, { fee: tx.fee });
  builder.timebounds = null;
  builder.setTimeout(validitySeconds);
  // TransactionBuilder.cloneFrom does not itself carry a Soroban
  // transaction's resource footprint (`sorobanData`, the simulation
  // result `prepareTransaction`/`assembleTransaction` attached) onto the
  // new builder -- confirmed live this step: without this, the rebuilt
  // transaction submits as `tx_malformed`, not the intended fresh, valid
  // one. Every write path in this SDK invokes exactly one Soroban
  // operation, so re-attaching whatever footprint `tx` itself carried
  // (extracted the same way cloneFrom's own internals do, from the
  // transaction's own envelope) is always correct here, never a guess.
  const envelope = tx.toEnvelope();
  const sorobanData = envelope.type === "envelopeTypeTx" && envelope.value.tx.ext.type === "sorobanData" ? envelope.value.tx.ext.value : undefined;
  if (sorobanData) {
    builder.setSorobanData(sorobanData);
  }
  const rebuilt = builder.build();
  if (!(rebuilt instanceof Transaction)) {
    throw new OracleError("expected a single-operation Transaction, not a fee-bump transaction");
  }
  return rebuilt;
}

/**
 * True when a real Stellar Core `TransactionResult` specifically rejected
 * submission because the envelope's own time bounds had already elapsed
 * by the time it reached the network -- confirmed against
 * `@stellar/stellar-sdk`'s own generated XDR types
 * (`TransactionResultResultTxTooLate`'s `type` discriminant, the same
 * shape a real captured `tx_too_late` rejection decodes to, see
 * docs/phase5-step4-tx-too-late.md). Deliberately narrow: every other
 * rejection reason (bad auth, bad sequence, insufficient fee, a real
 * on-chain contract error, ...) returns false here, so a caller can tell
 * "this specific, recoverable-by-retrying-fresh failure" apart from every
 * other kind, never lump them into one generic message.
 */
export function isTxTooLate(errorResult: xdr.TransactionResult | undefined): boolean {
  return errorResult?.result.type === "txTooLate";
}

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
    if (isTxTooLate(sendResult.errorResult)) {
      throw new TxTooLateError(method);
    }
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
