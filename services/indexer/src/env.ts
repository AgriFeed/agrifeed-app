/** Reads and validates the indexer's process environment once at startup. */

export interface IndexerEnv {
  databaseUrl: string;
  apiPort: number;
  rpcUrl: string;
  /** Undefined until agrifeed-contract is deployed and the id is filled in. */
  oracleContractId?: string;
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
