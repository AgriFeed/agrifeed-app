import { Keypair } from "@stellar/stellar-sdk";

export interface NodeRelayerEnv {
  nodeKeypair: Keypair;
  submitIntervalSeconds: number;
  rpcUrl: string;
  oracleContractId: string;
}

const TRACKED_COMMODITIES = ["COCOA", "COFFEE", "WHEAT", "MAIZE", "RICE", "SOYBEAN", "SUGAR", "COTTON"];

/**
 * Parses and validates `NODE_RELAYER_SUBMIT_INTERVAL_SECONDS`. Exported
 * separately (Phase 5 Step 7) so this is directly, deterministically
 * testable without spinning up the process. Bare `Number(...)` with no
 * validation was the previous behavior: a malformed value (a typo, an
 * empty string, a negative number) silently became `NaN`, and
 * `setInterval(fn, NaN * 1000)` fires almost immediately and repeatedly
 * in Node.js rather than throwing -- a real runaway-submission risk for
 * an unattended process, not merely a cosmetic config error. This fails
 * fast instead, with a message naming the actual invalid value, never a
 * bare "NaN".
 */
export function parseSubmitIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined) return 3600;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`NODE_RELAYER_SUBMIT_INTERVAL_SECONDS must be a positive number of seconds, got "${raw}"`);
  }
  return value;
}

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
    submitIntervalSeconds: parseSubmitIntervalSeconds(process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS),
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    oracleContractId,
  };
}

export { TRACKED_COMMODITIES };
