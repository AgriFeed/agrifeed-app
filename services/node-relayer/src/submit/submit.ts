import { Contract, Keypair, Networks, nativeToScVal, rpc as StellarRpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { refreshTimeBounds, submitAndConfirm } from "@agrifeed/sdk";
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

/**
 * Signs and submits one submit_price call with the node's own keypair,
 * then polls until it lands. Builds the transaction itself (Oracle's
 * `submit_price` shape is node-relayer's own concern, not the SDK's), but
 * reuses the SDK's shared write-path primitives (`refreshTimeBounds`,
 * `submitAndConfirm`, packages/sdk/src/soroban-tx.ts) for everything after
 * simulation -- the same freshen-then-submit-then-poll lifecycle every
 * other write path in this project already uses, instead of a second,
 * independently-maintained copy of it (see
 * docs/phase6-step2-submit-lifecycle-audit.md, decision: CONSOLIDATE).
 *
 * Signs directly with a server-held `Keypair`, unlike
 * packages/sdk/src/pricefloor.ts's `invokeAndConfirm` (which signs via a
 * `SignAndSend` callback across a Freighter/browser-extension boundary,
 * needing an XDR string round trip): no wallet is involved here, so
 * `.sign(keypair)` is called directly on the `Transaction` object
 * `refreshTimeBounds` returns, one step simpler than the browser path.
 *
 * Deliberately does NOT reuse `invokeAndConfirm` itself, only the two
 * lower-level primitives it's built from: `invokeAndConfirm`'s
 * `friendlyContractError` maps `agripricefloor`'s own error-code enum to
 * human messages, which would be wrong for AgriFeedOracle's entirely
 * different error enum (see the audit's "D. Node-relayer-specific
 * requirements").
 */
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
  // Freshen the signing window right before signing, exactly as every
  // other write path in this project does (Phase 5 Step 4) -- unlike
  // those paths there is no human approval delay here, but this still
  // narrows the window that can elapse between simulation and submission
  // to a transient RPC/network slowdown, and (via submitAndConfirm below)
  // makes that specific failure diagnosable if it ever happens instead of
  // indistinguishable from every other rejection reason.
  const readyToSign = refreshTimeBounds(prepared);
  readyToSign.sign(keypair);

  const hash = Buffer.from(readyToSign.hash()).toString("hex");
  await submitAndConfirm(server, readyToSign, `submit_price(${commodity})`);
  logger.info("submit_price confirmed", { commodity, hash, rawPrice });
}
