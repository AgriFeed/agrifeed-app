import { Networks } from "@stellar/stellar-sdk";
import { oracle } from "@agrifeed/sdk";
import { loadEnv, TRACKED_COMMODITIES } from "./env.js";
import { logger } from "./logger.js";
import { fetchFaoPrice } from "./adapters/fao.js";
import { fetchImfPrice } from "./adapters/imf.js";
import { fetchAmisPrice } from "./adapters/amis.js";
import { aggregatePrice } from "./normalize/aggregate.js";
import { submitPrice } from "./submit/submit.js";
import { logSubmitFailure } from "./submitFailureLog.js";

const ADAPTERS = [fetchFaoPrice, fetchImfPrice, fetchAmisPrice];

async function tick(env: ReturnType<typeof loadEnv>, decimals: number): Promise<void> {
  for (const commodity of TRACKED_COMMODITIES) {
    try {
      const aggregated = await aggregatePrice(commodity, decimals, ADAPTERS);
      await submitPrice(
        { rpcUrl: env.rpcUrl, oracleContractId: env.oracleContractId },
        env.nodeKeypair,
        commodity,
        aggregated.rawPrice,
        aggregated.sourceTs,
      );
      logger.info("submitted price", {
        commodity,
        rawPrice: aggregated.rawPrice,
        sources: aggregated.contributingSources,
      });
    } catch (err) {
      logSubmitFailure(err, commodity);
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  const oracleConfig = {
    contractId: env.oracleContractId,
    rpcUrl: env.rpcUrl,
    networkPassphrase: Networks.TESTNET,
  };
  const decimals = await oracle.decimals(oracleConfig);
  logger.info("node-relayer starting", {
    node: env.nodeKeypair.publicKey(),
    oracleContractId: env.oracleContractId,
    decimals,
    intervalSeconds: env.submitIntervalSeconds,
  });

  await tick(env, decimals);
  setInterval(() => {
    void tick(env, decimals);
  }, env.submitIntervalSeconds * 1000);
}

main().catch((err) => {
  logger.error("node-relayer failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
