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
import type { Asset, OracleConfig, PriceData } from "./types.js";

/**
 * A throwaway source account used only to build a simulate-only transaction.
 * Read calls never sign or submit, so this account does not need to exist
 * on-chain or hold any funds.
 */
const SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function assetToScVal(asset: Asset): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(asset.tag),
    asset.tag === "Stellar"
      ? nativeToScVal(asset.values[0], { type: "address" })
      : nativeToScVal(asset.values[0], { type: "symbol" }),
  ]);
}

function scValToPriceData(val: xdr.ScVal | undefined): PriceData | null {
  if (!val || val.type === "scvVoid") return null;
  const native = scValToNative(val);
  if (native === null || native === undefined) return null;
  return {
    price: (native.price as bigint).toString(),
    timestamp: BigInt(native.timestamp),
  };
}

/**
 * Wraps a Soroban contract read call in a fresh simulate-only transaction.
 * Falls back to raw simulation here; prefer swapping this out for
 * `stellar contract bindings typescript`-generated clients once bindings
 * are wired into the build (see packages/sdk/README.md).
 */
async function simulateReadCall(
  config: OracleConfig,
  method: string,
  args: xdr.ScVal[],
): Promise<xdr.ScVal | undefined> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const contract = new Contract(config.contractId);
  const account = new Account(SIMULATION_ACCOUNT, "0");

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);

  if (StellarRpc.Api.isSimulationError(simulated)) {
    throw new OracleError(`simulation of ${method} failed: ${simulated.error}`);
  }
  if (!StellarRpc.Api.isSimulationSuccess(simulated)) {
    throw new OracleError(`simulation of ${method} did not succeed`);
  }

  return simulated.result?.retval;
}

export async function base(config: OracleConfig): Promise<Asset> {
  const ret = await simulateReadCall(config, "base", []);
  if (!ret) throw new OracleError("base() returned no value");
  return scValToNative(ret) as Asset;
}

export async function assets(config: OracleConfig): Promise<Asset[]> {
  const ret = await simulateReadCall(config, "assets", []);
  if (!ret) return [];
  return scValToNative(ret) as Asset[];
}

export async function decimals(config: OracleConfig): Promise<number> {
  const ret = await simulateReadCall(config, "decimals", []);
  if (!ret) throw new OracleError("decimals() returned no value");
  return Number(scValToNative(ret));
}

export async function resolution(config: OracleConfig): Promise<number> {
  const ret = await simulateReadCall(config, "resolution", []);
  if (!ret) throw new OracleError("resolution() returned no value");
  return Number(scValToNative(ret));
}

export async function price(
  config: OracleConfig,
  asset: Asset,
  timestamp: bigint,
): Promise<PriceData | null> {
  const ret = await simulateReadCall(config, "price", [
    assetToScVal(asset),
    nativeToScVal(timestamp, { type: "u64" }),
  ]);
  return scValToPriceData(ret);
}

export async function prices(
  config: OracleConfig,
  asset: Asset,
  records: number,
): Promise<PriceData[] | null> {
  const ret = await simulateReadCall(config, "prices", [
    assetToScVal(asset),
    nativeToScVal(records, { type: "u32" }),
  ]);
  if (!ret || ret.type === "scvVoid") return null;
  const native = scValToNative(ret) as Array<{ price: bigint; timestamp: bigint | number }>;
  return native.map((p) => ({
    price: p.price.toString(),
    timestamp: BigInt(p.timestamp),
  }));
}

export async function lastprice(config: OracleConfig, asset: Asset): Promise<PriceData | null> {
  const ret = await simulateReadCall(config, "lastprice", [assetToScVal(asset)]);
  return scValToPriceData(ret);
}
