import {
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc as StellarRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { OracleError } from "@agrifeed/sdk";
import { logger } from "../logger.js";

function assetToScVal(symbol: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Other"),
    nativeToScVal(symbol, { type: "symbol" }),
  ]);
}

export interface SubmitConfig {
  rpcUrl: string;
  oracleContractId: string;
}

/** Signs and submits one submit_price call with the node's own keypair,
 * then polls until it lands. Mirrors packages/sdk/src/pricefloor.ts's
 * invokeAndConfirm, but signs with a server-held Keypair instead of
 * Freighter, since this runs unattended with no browser involved. */
export async function submitPrice(
  config: SubmitConfig,
  keypair: Keypair,
  commodity: string,
  rawPrice: string,
  sourceTs: bigint,
): Promise<void> {
  const server = new StellarRpc.Server(config.rpcUrl);
  const contract = new Contract(config.oracleContractId);
  const account = await server.getAccount(keypair.publicKey());

  const built = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        "submit_price",
        nativeToScVal(keypair.publicKey(), { type: "address" }),
        assetToScVal(commodity),
        nativeToScVal(BigInt(rawPrice), { type: "i128" }),
        nativeToScVal(sourceTs, { type: "u64" }),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(keypair);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new OracleError(`submit_price(${commodity}) rejected: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      logger.info("submit_price confirmed", { commodity, hash, rawPrice });
      return;
    }
    if (result.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      throw new OracleError(`submit_price(${commodity}) failed on-chain: ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new OracleError(`submit_price(${commodity}) transaction ${hash} did not confirm in time`);
}
