/** Reads and validates the indexer's process environment once at startup. */

export interface IndexerEnv {
  databaseUrl: string;
  apiPort: number;
  rpcUrl: string;
  /** Undefined until agrifeed-contract is deployed and the id is filled in. */
  oracleContractId?: string;
  /**
   * KNOWN LIMITATION, not addressed by this step's F-06/F-07 fixes: exactly
   * one already-deployed, already-initialized AgriPriceFloor instance.
   * AgriPriceFloor is one-instance-per-deal (see agrifeed-contract's
   * docs/testnet-deployment.md and apps/web/lib/stellar.ts's own
   * pricefloorWasmHash() doc comment): every deal deployed via
   * deploy.ts::deployInstance gets its own fresh contract id that this
   * indexer never learns about and never watches or indexes. Nothing in
   * this step makes multiple PriceFloor instances indexed; it only fixes
   * how events *from this one configured instance* are decoded and
   * disambiguated from the oracle's.
   */
  pricefloorContractId?: string;
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
  };
}
