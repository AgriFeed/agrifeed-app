/**
 * Mirrors the on-chain types exposed by AgriFeedOracle and AgriPriceFloor.
 * Keep these in lockstep with agrifeed-contract's Rust definitions; nothing
 * here should drift from what the deployed WASM actually returns.
 */

/** SEP-40 asset identifier. Commodities are always `Other`, e.g. `{ tag: "Other", values: ["COCOA"] }`. */
export type Asset =
  | { tag: "Stellar"; values: [string] }
  | { tag: "Other"; values: [string] };

/**
 * Raw price data as returned by the contract. `price` is an i128 scaled by
 * `10^decimals` and MUST be carried as a string end-to-end: it can exceed
 * Number.MAX_SAFE_INTEGER, so never `parseFloat` or `Number()` it.
 */
export interface PriceData {
  price: string;
  timestamp: bigint;
}

export interface OracleConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export type SorobanNetwork = "testnet" | "futurenet" | "mainnet";

/** A price whose value has been made safe for display, still integer-exact. */
export interface FormattedPrice {
  /** Decimal string, e.g. "6188.00". Never a JS number. */
  formatted: string;
  /** Raw on-chain integer value, as a string. */
  raw: string;
  decimals: number;
}

export class OracleError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OracleError";
  }
}

/**
 * Thrown by node-relayer source adapters when an upstream data source
 * cannot be reached or returns a shape we don't recognize. Callers must
 * treat this as "no data", never substitute a fabricated or stale price.
 */
export class SourceUnavailableError extends Error {
  constructor(
    public readonly source: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`[${source}] ${message}`);
    this.name = "SourceUnavailableError";
  }
}

export interface AgriPriceFloorConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export type AgriPriceFloorState = {
  farmer: string;
  buyer: string;
  commodity: Asset;
  floorPrice: string;
  notional: string;
  settlementToken: string;
  maturityTs: bigint;
  oracle: string;
};
