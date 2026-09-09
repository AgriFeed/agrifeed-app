import { Address, Operation, rpc as StellarRpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { OracleError } from "./types.js";
import type { AgriPriceFloorDeploymentConfig } from "./types.js";
import type { SignAndSend } from "./wallet.js";
import { submitAndConfirm } from "./soroban-tx.js";

/**
 * AgriPriceFloor is one-instance-per-deal (see agrifeed-contract's
 * docs/testnet-deployment.md): a fixed `NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID`
 * only ever addresses one already-initialized instance, it is not "the"
 * deal contract. This deploys a genuinely new instance from the shared
 * WASM hash (`AgriPriceFloorDeploymentConfig.wasmHash`), which the caller
 * then calls `initialize` against (still a *separate* call: this contract
 * has no on-deploy constructor, matching the deployment doc's own two-step
 * `stellar contract deploy --wasm-hash` then `stellar contract invoke ...
 * initialize` CLI flow).
 *
 * Single-signer: only `deployerPublicKey` authorizes, since deploying a
 * contract instance from an existing WASM hash needs no `initialize`-style
 * counterparty approval, that comes in the following `initialize` call.
 */
/** Exported for testing; not part of the SDK's intended public surface. */
export function wasmHashToBytes(wasmHash: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(wasmHash)) {
    throw new OracleError(`wasmHash must be a 64-character hex string, got "${wasmHash}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(wasmHash.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function deployInstance(
  config: AgriPriceFloorDeploymentConfig,
  deployerPublicKey: string,
  signAndSend: SignAndSend,
): Promise<string> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const account = await server.getAccount(deployerPublicKey);

  const built = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(deployerPublicKey),
        wasmHash: wasmHashToBytes(config.wasmHash),
      }),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  const signedXdr = await signAndSend(prepared.toXDR());
  const signedTx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);

  const returnValue = await submitAndConfirm(server, signedTx, "deployInstance");
  if (!returnValue) {
    throw new OracleError("deployInstance succeeded but returned no contract address");
  }
  return scValToNative(returnValue) as string;
}
