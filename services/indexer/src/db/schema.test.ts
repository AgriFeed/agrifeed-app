import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "./migrate.js";

/**
 * Real Postgres against the same dedicated agrifeed_test database the
 * other indexer tests use (see poll.test.ts's doc comment on why: this
 * project's convention is real Postgres, not a mock).
 */
const TEST_DATABASE_URL =
  process.env.INDEXER_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable";

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

describe("migrate() safety (Phase 4 Step 2)", () => {
  it("is safe to run twice in a row on an already-migrated database", async () => {
    await migrate(TEST_DATABASE_URL);
    await migrate(TEST_DATABASE_URL); // must not throw
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pricefloor_instances'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it(
    "self-heals a pricefloor_events.event_type CHECK constraint left over from before the real event names were known " +
      "(regression test for a real bug found live during Phase 4 Step 2: CREATE TABLE IF NOT EXISTS never updates an " +
      "already-existing table's constraints, so a database whose pricefloor_events predated the F-07 fix silently kept " +
      "the old function-name values forever, and every real event insert since then failed its CHECK and was swallowed " +
      "by pollEvents' per-event try/catch -- confirmed against this project's own long-running `agrifeed` database, see " +
      "the Phase 4 Step 2 implementation report)",
    async () => {
      // Recreate the table with the stale, pre-fix constraint, exactly as
      // it would exist on a database created before that fix.
      await pool.query(`DROP TABLE IF EXISTS pricefloor_events CASCADE`);
      await pool.query(`
        CREATE TABLE pricefloor_events (
          id BIGSERIAL PRIMARY KEY,
          contract_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('initialize', 'fund', 'settle', 'cancel')),
          ledger BIGINT NOT NULL,
          tx_hash TEXT NOT NULL,
          data JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (tx_hash, event_type)
        )
      `);

      // Before migrate(): a real event_type value is rejected.
      await expect(
        pool.query(
          `INSERT INTO pricefloor_events (contract_id, event_type, ledger, tx_hash, data) VALUES ('C123', 'initialized', 1, 'tx-pre', '{}')`,
        ),
      ).rejects.toThrow(/violates check constraint/);

      await migrate(TEST_DATABASE_URL);

      // After migrate(): the same real event_type value is now accepted,
      // and existing rows/columns survive (ALTER, not DROP+recreate).
      await pool.query(
        `INSERT INTO pricefloor_events (contract_id, event_type, ledger, tx_hash, data) VALUES ('C123', 'initialized', 1, 'tx-post', '{}')`,
      );
      const row = await pool.query(`SELECT event_type FROM pricefloor_events WHERE tx_hash = 'tx-post'`);
      expect(row.rows[0]?.event_type).toBe("initialized");
    },
  );
});
