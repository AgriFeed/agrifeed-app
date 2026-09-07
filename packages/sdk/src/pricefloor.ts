import {
  Account,
  Contract,
  nativeToScVal,
  rpc as StellarRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { OracleError } from "./types.js";
import type { AgriPriceFloorConfig, AgriPriceFloorState, Asset } from "./types.js";
import type { SignAndSend } from "./wallet.js";

/**
 * Builds, has the wallet sign, and submits a contract-invoking transaction,
 * then polls the RPC server until the transaction reaches a final status.
 * `@stellar/stellar-sdk` v17 does not ship a ready-made polling helper for
 * this exact flow, so it is implemented directly against
 * `server.sendTransaction` / `server.getTransaction`.
 */
async function invokeAndConfirm(
  config: AgriPriceFloorConfig,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
  signAndSend: SignAndSend,
): Promise<xdr.ScVal | undefined> {
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

  const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
  const signedTx = TB.fromXDR(signedXdr, config.networkPassphrase);

  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.status === "ERROR") {
    throw new OracleError(`${method} submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  const pollIntervalMs = 1500;
  const maxAttempts = 20;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      return result.returnValue;
    }
    if (result.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      throw new OracleError(`${method} transaction failed on-chain: ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new OracleError(`${method} transaction ${hash} did not confirm in time`);
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

export async function fund(
  config: AgriPriceFloorConfig,
  buyer: string,
  amount: bigint,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(
    config,
    "fund",
    [nativeToScVal(buyer, { type: "address" }), nativeToScVal(amount, { type: "i128" })],
    buyer,
    signAndSend,
  );
}

export async function settle(
  config: AgriPriceFloorConfig,
  callerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(config, "settle", [], callerPublicKey, signAndSend);
}

export async function cancel(
  config: AgriPriceFloorConfig,
  callerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<void> {
  await invokeAndConfirm(config, "cancel", [], callerPublicKey, signAndSend);
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
