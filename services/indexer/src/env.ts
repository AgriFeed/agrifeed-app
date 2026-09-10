/** Reads and validates the indexer's process environment once at startup. */

export interface IndexerEnv {
  databaseUrl: string;
  apiPort: number;
  rpcUrl: string;
  /** Undefined until agrifeed-contract is deployed and the id is filled in. */
  oracleContractId?: string;
  /**
   * A single, already-deployed, already-initialized AgriPriceFloor
   * instance, kept as a legacy/demo fallback (see
   * apps/web/lib/stellar.ts's own pricefloorContractId() doc comment for
   * why the frontend keeps a matching one). Independently deployed
   * instances are discovered and indexed through pricefloor_instances
   * instead (see instances.ts and docs/phase4-pricefloor-deal-registry.md);
   * this env var no longer bounds what the indexer watches, only what it
   * watches *in addition to* every registered instance.
   */
  pricefloorContractId?: string;
  /**
   * The uploaded AgriPriceFloor WASM's hash, used to verify a
   * client-submitted contract id actually is a PriceFloor deployment
   * before registerInstance() ever persists it (see instances.ts). Without
   * this configured, registration refuses rather than trusting an
   * unverified claim.
   */
  pricefloorWasmHash?: string;
}

export function loadEnv(): IndexerEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return {
    databaseUrl,
    apiPort: Number(process.env.INDEXER_API_PORT ?? 4000),
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    oracleContractId: process.env.ORACLE_CONTRACT_ID || undefined,
    pricefloorContractId: process.env.PRICEFLOOR_CONTRACT_ID || undefined,
    pricefloorWasmHash: process.env.PRICEFLOOR_WASM_HASH || undefined,
  };
}
