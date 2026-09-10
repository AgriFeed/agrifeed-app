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
import { refreshTimeBounds, submitAndConfirm } from "./soroban-tx.js";

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
 * The complement of `toPendingAuthEntries`: every SourceAccount-credentialed
 * entry a simulation returned, as base64 XDR, preserved verbatim so
 * `submitMultiPartyInvocation` can resubmit them unchanged (they carry no
 * nonce, so they never go stale).
 */
function toSourceAccountAuthEntryXdrs(entries: xdr.SorobanAuthorizationEntry[]): string[] {
  return entries.filter((entry) => inspectAuthEntry(entry).address === null).map((entry) => entry.toXDR("base64"));
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

  const allAuthEntries = simulated.result?.auth ?? [];
  return {
    transactionXdr: built.toXDR(),
    pendingAuthEntries: toPendingAuthEntries(allAuthEntries),
    sourceAccountAuthEntryXdrs: toSourceAccountAuthEntryXdrs(allAuthEntries),
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
 * Reunites the preserved SourceAccount-credentialed entries from
 * `prepareMultiPartyInvocation` with the entries each party actually signed.
 * Soroban's host only authorizes an address whose SorobanAuthorizationEntry
 * is present in the submitted transaction, including a SourceAccount-
 * credentialed one, present but signature-less, satisfied by the envelope
 * signature alone (verified against soroban-env-host's
 * `AccountAuthorizationTracker::from_authorization_entry`, which builds a
 * tracker only from entries actually in the array). Those entries are never
 * in `signedEntries` (`toPendingAuthEntries` deliberately never hands them
 * out to sign), so they must come from here, or that party's authorization
 * silently vanishes from the final transaction. `sourceAccountEntries` must
 * be the ones `prepareMultiPartyInvocation` returned, not a fresh
 * simulation's: see `submitMultiPartyInvocation`'s doc comment for why.
 */
export function mergeSignedAuthEntries(
  sourceAccountEntries: xdr.SorobanAuthorizationEntry[],
  signedEntries: xdr.SorobanAuthorizationEntry[],
): xdr.SorobanAuthorizationEntry[] {
  return [...sourceAccountEntries.filter((entry) => inspectAuthEntry(entry).address === null), ...signedEntries];
}

/**
 * Submits a multi-party invocation once every entry `prepareMultiPartyInvocation`
 * returned has been independently signed (in order, matching
 * `pendingAuthEntries`).
 *
 * Re-derives the current resource fee/footprint by re-simulating, since real
 * time (a whole independent signing round, possibly minutes or more) has
 * passed since `prepareMultiPartyInvocation`'s own simulation. That
 * re-simulation must never run against a *bare, auth-less* copy of the
 * transaction: Soroban RPC simulates a transaction whose operation carries
 * no auth entries in "recording" mode, which mints a brand-new, random
 * nonce for every address-credentialed requirement, different from the one
 * already baked into the entry each party actually signed. The resulting
 * resource footprint would then only cover that fresh, unused nonce's
 * ledger key, not the real signed one, and the submitted transaction traps
 * at execution with "trying to access nonce outside of the footprint" —
 * confirmed against a real Testnet failure during F-04 live verification,
 * on every call where any real time separated prepare from submit (i.e.
 * every real two-party flow, the entire reason this three-phase design
 * exists). So instead, the operation is primed with the exact entries about
 * to be submitted (the preserved, nonce-free SourceAccount entries plus the
 * now-signed, nonce-fixed ones) *before* simulating: Soroban then simulates
 * in enforcing mode against those exact nonces, so the fresh footprint/fee
 * estimate actually matches what gets submitted.
 */
export async function submitMultiPartyInvocation(
  config: AgriPriceFloorConfig,
  transactionXdr: string,
  signedAuthEntryXdrs: string[],
  sourceAccountAuthEntryXdrs: string[],
  signAndSend: SignAndSend,
): Promise<xdr.ScVal | undefined> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const originalTx = TransactionBuilder.fromXDR(transactionXdr, config.networkPassphrase);
  if (!(originalTx instanceof Transaction)) {
    throw new OracleError("expected a single-operation Transaction, not a fee-bump transaction");
  }

  const signedEntries = signedAuthEntryXdrs.map((entryXdr) => xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64"));
  const sourceAccountEntries = sourceAccountAuthEntryXdrs.map((entryXdr) =>
    xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64"),
  );
  const authEntries = mergeSignedAuthEntries(sourceAccountEntries, signedEntries);
  const primedTx = withAuthEntries(
    TransactionBuilder.cloneFrom(originalTx, { fee: originalTx.fee }),
    originalTx,
    authEntries,
  );

  const simulated = await server.simulateTransaction(primedTx);
  if (StellarRpc.Api.isSimulationError(simulated)) {
    throw new OracleError(`re-simulation before submit failed: ${simulated.error}`);
  }

  const builder = StellarRpc.assembleTransaction(primedTx, simulated);
  // `primedTx` (and so `builder`, cloned from it) still carries whatever
  // time bounds `prepareMultiPartyInvocation` fixed, possibly minutes or
  // more ago -- the exact staleness this whole function's own doc comment
  // above already describes handling for nonces, but time bounds are a
  // separate mechanism (envelope-level, not per-auth-entry) that was not
  // previously refreshed here. This is safe to do this late, right before
  // the source account's own fresh envelope signature is requested below,
  // and never touches the already-signed entries in `authEntries`: see
  // refreshTimeBounds's doc comment for why the two are independent
  // (Phase 5 Step 4).
  const built = refreshTimeBounds(withAuthEntries(builder, primedTx, authEntries));

  const signedXdr = await signAndSend(built.toXDR());
  const signedTx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);

  return submitAndConfirm(server, signedTx, "multi-party invocation");
}
