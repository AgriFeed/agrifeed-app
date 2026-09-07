import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadEnv } from "../env.js";
import { logger } from "../logger.js";
import { getPool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(databaseUrl: string): Promise<void> {
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const pool = getPool(databaseUrl);
  await pool.query(schema);
}

async function main(): Promise<void> {
  const env = loadEnv();
  await migrate(env.databaseUrl);
  logger.info("migration complete");
  await getPool(env.databaseUrl).end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error("migration failed", { error: String(err) });
    process.exitCode = 1;
  });
}
