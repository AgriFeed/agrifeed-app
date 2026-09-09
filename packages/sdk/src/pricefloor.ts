import { Contract, nativeToScVal, rpc as StellarRpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { OracleError } from "./types.js";
import type { AgriPriceFloorConfig, AgriPriceFloorState, Asset } from "./types.js";
import type { SignAndSend } from "./wallet.js";
import { submitAndConfirm } from "./soroban-tx.js";

// Mirrors contracts/agripricefloor/src/errors.rs; keep in sync with that enum.
const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: "This contract instance has already been initialized. Each AgriPriceFloor deal is a fresh instance deployed from PRICEFLOOR_WASM_HASH, not reusable, deploy a new instance for a new deal.",
  2: "This agreement has not been funded yet, run Fund before Settle.",
  3: "This agreement has already been funded.",
  4: "This agreement has already been settled.",
  5: "The maturity timestamp has not passed yet, Settle is only available after maturity.",
  6: "The oracle has no finalized price for this commodity yet.",
  7: "The cancellation grace period has not elapsed yet.",
  8: "The connected wallet is not authorized for this action, or no agreement exists on this instance yet.",
  9: "The amount must be positive.",
  10: "Payout arithmetic overflowed, check that floor_price and notional are reasonable.",
};

function friendlyContractError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  const known = match ? CONTRACT_ERROR_MESSAGES[Number(match[1])] : undefined;
  if (known) {
    return new OracleError(`${known}\n\nRaw: ${message.split("\n")[0]}`);
  }
  return err instanceof Error ? err : new OracleError(message);
}

/**
 * Builds, has the wallet sign, and submits a contract-invoking transaction,
 * then polls the RPC server until the transaction reaches a final status.
 * Single-signer only: `sourcePublicKey` is both the transaction's source
 * account and the only address `signAndSend` will authorize. A call that
 * needs more than one address's authorization (AgriPriceFloor's
 * `initialize`) cannot go through this path, see
 * `multiparty.ts`'s `prepareMultiPartyInvocation`/
 * `submitMultiPartyInvocation` instead.
 */
async function invokeAndConfirm(
  config: AgriPriceFloorConfig,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
  signAndSend: SignAndSend,
): Promise<xdr.ScVal | undefined> {
  try {
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

    const prepared = await server.prepareTransaction(built);
    const signedXdr = await signAndSend(prepared.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);

    return await submitAndConfirm(server, signedTx, method);
  } catch (err) {
    throw friendlyContractError(err);
  }
}

function assetToScVal(asset: Asset): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(asset.tag),
    asset.tag === "Stellar"
      ? nativeToScVal(asset.values[0], { type: "address" })
      : nativeToScVal(asset.values[0], { type: "symbol" }),
  ]);
}

export interface InitializePriceFloorParams {
  farmer: string;
  buyer: string;
  commodity: Asset;
  floorPrice: bigint;
  notional: bigint;
  settlementToken: string;
  maturityTs: bigint;
  oracle: string;
}

/**
 * Initializes a fresh AgriPriceFloor instance.
 *
 * The contract requires independent authorization from *both*
 * `params.farmer` and `params.buyer` (`farmer.require_auth()` and
 * `buyer.require_auth()`). This function signs with exactly one signer,
 * `callerPublicKey`/`signAndSend`, so it can only ever succeed when farmer,
 * buyer, and the caller are the same connected wallet, the on-chain auth
 * check does not relax for a same-wallet demo case, it just happens to be
 * satisfiable by one signature when all three addresses are identical.
 * For a real deal where farmer and buyer are different people, use
 * `prepareMultiPartyInvocation`/`submitMultiPartyInvocation` from
 * `multiparty.ts` instead, which collects an independent signature from
 * each party before submitting.
 */
export async function initialize(
  config: AgriPriceFloorConfig,
  params: InitializePriceFloorParams,
  callerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(
    config,
    "initialize",
    [
      nativeToScVal(params.farmer, { type: "address" }),
      nativeToScVal(params.buyer, { type: "address" }),
      assetToScVal(params.commodity),
      nativeToScVal(params.floorPrice, { type: "i128" }),
      nativeToScVal(params.notional, { type: "i128" }),
      nativeToScVal(params.settlementToken, { type: "address" }),
      nativeToScVal(params.maturityTs, { type: "u64" }),
      nativeToScVal(params.oracle, { type: "address" }),
    ],
    callerPublicKey,
    signAndSend,
  );
}

/**
 * Builds the argument list for `fund(buyer: Address, amount: i128)`.
 * Exported separately, mirroring `cancelArgs`, so this encoding can be
 * asserted directly in a unit test without a live RPC call.
 */
export function fundArgs(buyer: string, amount: bigint): xdr.ScVal[] {
  return [nativeToScVal(buyer, { type: "address" }), nativeToScVal(amount, { type: "i128" })];
}

export async function fund(
  config: AgriPriceFloorConfig,
  buyer: string,
  amount: bigint,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(config, "fund", fundArgs(buyer, amount), buyer, signAndSend);
}

export async function settle(
  config: AgriPriceFloorConfig,
  callerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(config, "settle", [], callerPublicKey, signAndSend);
}

/**
 * Builds the argument list for `cancel(caller: Address)`. Exported
 * separately from `cancel()` so the encoding itself, one address argument,
 * matching the contract's real one-argument signature, can be asserted
 * directly in a unit test without needing a live RPC call.
 */
export function cancelArgs(callerPublicKey: string): xdr.ScVal[] {
  return [nativeToScVal(callerPublicKey, { type: "address" })];
}

export async function cancel(
  config: AgriPriceFloorConfig,
  callerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(config, "cancel", cancelArgs(callerPublicKey), callerPublicKey, signAndSend);
}

export async function getState(
  config: AgriPriceFloorConfig,
): Promise<Partial<AgriPriceFloorState>> {
  // AgriPriceFloor exposes no dedicated getter in the contract interface;
  // full state is reconstructed by the indexer from initialize/fund/settle
  // events (see services/indexer). This stub exists so the SDK's exported
  // surface matches AgriPriceFloorState without pretending a getter exists
  // on-chain that does not.
  void config;
  return {};
}
