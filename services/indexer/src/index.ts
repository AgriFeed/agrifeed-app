import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { getPool } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { backfillContributingNodes, pollEvents, pollOracleState } from "./poll.js";
import { createApp } from "./api/server.js";

const POLL_INTERVAL_MS = 60_000;

async function tick(env: ReturnType<typeof loadEnv>, pool: ReturnType<typeof getPool>): Promise<void> {
  try {
    await pollOracleState(env, pool);
  } catch (err) {
    logger.error("oracle state poll failed", { error: String(err) });
  }
  try {
    await pollEvents(env, pool);
  } catch (err) {
    logger.error("event poll failed", { error: String(err) });
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = getPool(env.databaseUrl);

  await migrate(env.databaseUrl);
  logger.info("database migrated");

  await backfillContributingNodes(pool);

  const app = createApp(env, pool);
  app.listen(env.apiPort, () => {
    logger.info("indexer api listening", { port: env.apiPort });
  });

  await tick(env, pool);
  setInterval(() => {
    void tick(env, pool);
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  logger.error("indexer failed to start", { error: String(err) });
  process.exitCode = 1;
});
