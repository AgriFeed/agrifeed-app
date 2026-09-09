import { Networks } from "@stellar/stellar-sdk";

/** Raw NEXT_PUBLIC_STELLAR_NETWORK value, defaulted the same way
 * networkPassphrase() is, so callers never derive a different default. */
export function stellarNetwork(): "mainnet" | "futurenet" | "testnet" {
  const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
  return network === "mainnet" || network === "futurenet" ? network : "testnet";
}

/** Human-readable network name for the global network indicator (Phase 3
 * Step 4). Never abbreviate this to a color-only dot: the whole point is
 * that a user can't miss which network they're looking at. */
export function networkLabel(): string {
  switch (stellarNetwork()) {
    case "mainnet":
      return "Stellar Public Network";
    case "futurenet":
      return "Stellar Futurenet";
    case "testnet":
    default:
      return "Stellar Testnet";
  }
}

export function networkPassphrase(): string {
  const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
  switch (network) {
    case "mainnet":
      return Networks.PUBLIC;
    case "futurenet":
      return Networks.FUTURENET;
    case "testnet":
    default:
      return Networks.TESTNET;
  }
}

export function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
}

export function oracleContractId(): string | undefined {
  return process.env.NEXT_PUBLIC_ORACLE_CONTRACT_ID || undefined;
}

/**
 * A single, already-deployed, already-initialized AgriPriceFloor instance.
 * AgriPriceFloor is one-instance-per-deal (see agrifeed-contract's
 * docs/testnet-deployment.md), so this is deliberately NOT "the" PriceFloor
 * contract: it's a legacy/demo fallback for continuing to fund/settle/cancel
 * one already-existing deal, kept because services/indexer's own
 * PRICEFLOOR_CONTRACT_ID still needs exactly one instance to watch, and
 * because it lets the demo's fund/settle/cancel steps work without first
 * running through the full deploy+initialize flow every time. It is never
 * used by that flow: a new deal deploys its own fresh instance via
 * `pricefloorWasmHash()` instead.
 */
export function pricefloorContractId(): string | undefined {
  return process.env.NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID || undefined;
}

/**
 * The uploaded AgriPriceFloor WASM's hash, from which a new instance is
 * deployed per deal (`stellar contract deploy --wasm-hash`, see
 * agrifeed-contract's docs/testnet-deployment.md step 8). This is what the
 * deploy-a-new-deal flow actually uses, not `pricefloorContractId()`.
 */
export function pricefloorWasmHash(): string | undefined {
  return process.env.NEXT_PUBLIC_PRICEFLOOR_WASM_HASH || undefined;
}
