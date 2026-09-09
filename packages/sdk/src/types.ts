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

/**
 * AgriPriceFloor is one-instance-per-deal (see agrifeed-contract's
 * docs/testnet-deployment.md): every real deal is a fresh contract
 * instance deployed from a shared WASM hash, never a reused singleton.
 * `AgriPriceFloorConfig.contractId` above is for calling an *already
 * deployed* instance; this config is for deploying a *new* one, and
 * carries no `contractId` because none exists yet.
 */
export interface AgriPriceFloorDeploymentConfig {
  wasmHash: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * One address's still-unsigned share of a multi-party Soroban invocation,
 * produced by `prepareMultiPartyInvocation` and handed to that address's
 * own signer (its own Freighter session, not the invocation's initiator).
 */
export interface PendingAuthEntry {
  /** The G... address this entry authorizes on behalf of. */
  address: string;
  /** Base64 XDR of the unsigned `SorobanAuthorizationEntry`. */
  entryXdr: string;
}

/**
 * Everything needed to submit a multi-party invocation once every
 * `pendingAuthEntries` member has been independently signed. `transactionXdr`
 * is the *unsimulated* transaction (built once, never rebuilt), preserved
 * so `submitMultiPartyInvocation` can re-derive resource fees without
 * touching the nonces baked into the already-signed auth entries: a second
 * simulation would mint fresh nonces and invalidate signatures collected
 * against the first one.
 */
export interface PreparedMultiPartyInvocation {
  transactionXdr: string;
  pendingAuthEntries: PendingAuthEntry[];
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
