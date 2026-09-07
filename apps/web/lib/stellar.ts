import { Networks } from "@stellar/stellar-sdk";

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

export function pricefloorContractId(): string | undefined {
  return process.env.NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID || undefined;
}
