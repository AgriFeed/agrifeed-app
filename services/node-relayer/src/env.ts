import { Keypair } from "@stellar/stellar-sdk";

export interface NodeRelayerEnv {
  nodeKeypair: Keypair;
  submitIntervalSeconds: number;
  rpcUrl: string;
  oracleContractId: string;
}

const TRACKED_COMMODITIES = ["COCOA", "COFFEE", "WHEAT", "MAIZE", "RICE", "SOYBEAN", "SUGAR", "COTTON"];

export function loadEnv(): NodeRelayerEnv {
  const secretKey = process.env.NODE_RELAYER_SECRET_KEY;
  if (!secretKey) {
    throw new Error("NODE_RELAYER_SECRET_KEY is required, must belong to a node already added via add_node");
  }
  const oracleContractId = process.env.ORACLE_CONTRACT_ID;
  if (!oracleContractId) {
    throw new Error("ORACLE_CONTRACT_ID is required");
  }

  return {
    nodeKeypair: Keypair.fromSecret(secretKey),
    submitIntervalSeconds: Number(process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS ?? 3600),
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    oracleContractId,
  };
}

export { TRACKED_COMMODITIES };
