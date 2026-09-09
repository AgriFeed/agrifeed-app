import {
  Contract,
  inspectAuthEntry,
  Operation,
  rpc as StellarRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { OracleError } from "./types.js";
import type { AgriPriceFloorConfig, PendingAuthEntry, PreparedMultiPartyInvocation } from "./types.js";
import type { SignAndSend } from "./wallet.js";
import { submitAndConfirm } from "./soroban-tx.js";

/**
 * Real multi-party Soroban authorization, for calls like AgriPriceFloor's
 * `initialize` that require independent authorization from more than one
 * address (farmer and buyer). This is deliberately split into three steps
 * that never share a single caller, so no one party's code path ever holds
 * more than its own signature:
 *
 *   1. `prepareMultiPartyInvocation` — build and simulate the call once,
 *      producing one unsigned `PendingAuthEntry` per address simulation
 *      says must authorize.
 *   2. each `PendingAuthEntry` is handed to *that address's own* signer
 *      (its own Freighter session), which calls
 *      `signAuthEntryWithFreighter` (see wallet.ts) on it independently.
 *   3. `submitMultiPartyInvocation` — once every entry has come back
 *      signed, assembles and submits the final transaction.
 *
 * A single Freighter `signTransaction` call only ever produces the outer
 * transaction envelope's signature, for whichever address is the
 * transaction's source account. It does not and cannot sign a *different*
 * address's Soroban authorization entry: that needs a signature from that
 * address's own key, which is exactly what step 2 above collects, and
 * exactly why `pricefloor.ts`'s single-signer `initialize()` cannot
 * satisfy a real two-party deal (see its doc comment).
 *
 * Built entirely from `@stellar/stellar-sdk` 17.0.1's own first-party
 * multi-party auth primitives (`inspectAuthEntry`, `rpc.assembleTransaction`,
 * `Operation.invokeHostFunction`) and XDR's own `toXDR`/`fromXDR`
 * round-tripping, the same mechanism the SDK's own `authorizeEntry` doc
 * example uses, not hand-rolled auth-entry construction.
 */

/**
 * Extracts one `PendingAuthEntry` per address-credentialed entry a
 * simulation returned. Pure, no network I/O: the part of
 * `prepareMultiPartyInvocation` that is actually unit-testable without a
 * live RPC. Source-account-credentialed entries (Soroban's implicit,
 * envelope-signature-only credential kind, used when the requiring
 * address is also the transaction's source account) are skipped: they
 * need no independent signature, only the transaction's own envelope
 * signature, which the source account provides when it calls `signAndSend`
 * in `submitMultiPartyInvocation`.
 */
/**
 * Throws unless `connectedAddress` is exactly `expectedAddress`. This is the
 * "verify identity before signing" guard: it is deliberately pure (no
 * Freighter call inside it) so the check itself is unit-testable without
 * mocking a wallet, and deliberately synchronous/throwing so a caller
 * cannot accidentally proceed to request a signature on a mismatch. `role`
 * (e.g. "farmer", "buyer") is only used to make the error readable.
 */
export function assertExpectedSigner(
  connectedAddress: string | null,
  expectedAddress: string,
  role: string,
): void {
  if (connectedAddress !== expectedAddress) {
    throw new OracleError(
      `Wrong wallet connected for ${role}: expected ${expectedAddress}, but ` +
        `${connectedAddress ?? "no wallet"} is connected. Switch Freighter to the ${role}'s ` +
        `account and try again.`,
    );
  }
}

export function toPendingAuthEntries(entries: xdr.SorobanAuthorizationEntry[]): PendingAuthEntry[] {
  const pending: PendingAuthEntry[] = [];
  for (const entry of entries) {
    const info = inspectAuthEntry(entry);
    if (info.address === null) continue;
    pending.push({ address: info.address, entryXdr: entry.toXDR("base64") });
  }
  return pending;
}

/**
 * Builds and simulates a contract invocation that may require more than
 * one address's authorization. Returns the raw (unsimulated) transaction
 * plus one `PendingAuthEntry` per address that must sign, so each can be
 * routed to that address's own signer independently, and never re-derives
 * them again: `submitMultiPartyInvocation` re-simulates only for resource
 * fees, never for auth, since a second simulation would mint fresh nonces
 * that invalidate every signature already collected against this one.
 */
export async function prepareMultiPartyInvocation(
  config: AgriPriceFloorConfig,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
): Promise<PreparedMultiPartyInvocation> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const contract = new Contract(config.contractId);
  const account = await server.getAccount(sourcePublicKey);

  const built = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simulated = await server.simulateTransaction(built);
  if (StellarRpc.Api.isSimulationError(simulated)) {
    throw new OracleError(`simulation of ${method} failed: ${simulated.error}`);
  }
  if (!StellarRpc.Api.isSimulationSuccess(simulated)) {
    throw new OracleError(`simulation of ${method} did not succeed`);
  }

  return {
    transactionXdr: built.toXDR(),
    pendingAuthEntries: toPendingAuthEntries(simulated.result?.auth ?? []),
  };
}

/**
 * Replaces the transaction's single `invokeHostFunction` operation's auth
 * array with `authEntries`, on top of a builder that already carries
 * simulation's resource footprint/fee (from `rpc.assembleTransaction`).
 * Pure XDR reconstruction otherwise: no network I/O, so it is unit
 * testable by feeding it a builder built directly (bypassing simulation)
 * from an offline `Account`.
 */
export function withAuthEntries(
  builder: TransactionBuilder,
  originalTx: Transaction,
  authEntries: xdr.SorobanAuthorizationEntry[],
): Transaction {
  const op = originalTx.operations[0];
  if (!op || op.type !== "invokeHostFunction") {
    throw new OracleError("expected the transaction's sole operation to be invokeHostFunction");
  }
  const built = builder
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ source: op.source, func: op.func, auth: authEntries }))
    .build();
  if (!(built instanceof Transaction)) {
    throw new OracleError("expected a single-operation Transaction, not a fee-bump transaction");
  }
  return built;
}

/**
 * Submits a multi-party invocation once every entry `prepareMultiPartyInvocation`
 * returned has been independently signed (in order, matching
 * `pendingAuthEntries`). Re-simulates only to re-derive the current
 * resource fee/footprint, never to re-derive auth, then rebuilds the
 * operation with the caller-supplied signed entries, has the source
 * account sign the outer transaction envelope via `signAndSend`, submits,
 * and polls for confirmation exactly like the single-signer path.
 */
export async function submitMultiPartyInvocation(
  config: AgriPriceFloorConfig,
  transactionXdr: string,
  signedAuthEntryXdrs: string[],
  signAndSend: SignAndSend,
): Promise<xdr.ScVal | undefined> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const originalTx = TransactionBuilder.fromXDR(transactionXdr, config.networkPassphrase);
  if (!(originalTx instanceof Transaction)) {
    throw new OracleError("expected a single-operation Transaction, not a fee-bump transaction");
  }

  const simulated = await server.simulateTransaction(originalTx);
  if (StellarRpc.Api.isSimulationError(simulated)) {
    throw new OracleError(`re-simulation before submit failed: ${simulated.error}`);
  }

  const authEntries = signedAuthEntryXdrs.map((entryXdr) => xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64"));
  const builder = StellarRpc.assembleTransaction(originalTx, simulated);
  const built = withAuthEntries(builder, originalTx, authEntries);

  const signedXdr = await signAndSend(built.toXDR());
  const signedTx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);

  return submitAndConfirm(server, signedTx, "multi-party invocation");
}
