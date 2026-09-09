import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Contract, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { rpc as StellarRpc } from "@stellar/stellar-sdk";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { backfillContributingNodes, handleEvent } from "./poll.js";

/**
 * Real Postgres, not a mock: this project's own convention (see the
 * indexer-migration CI job's real postgres:16-alpine service) is to run
 * these against an actual database, and these tests need to inspect real
 * stored/query results, not just that a function executed. Uses a
 * dedicated agrifeed_test database on the same already-running local
 * Postgres container this session has been using, so the real, historical
 * agrifeed database (real indexed Testnet data) is never touched.
 */
const TEST_DATABASE_URL =
  process.env.INDEXER_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable";

// Real, valid-checksum, publicly-known contract strkeys already used
// elsewhere in this project (agrifeed-app's own .env.local): the actual
// deployed oracle and the actual deployed pricefloor demo instance. Only
// their validity/distinctness as two different contract identities matters
// here, matching this repo's existing test convention (see
// packages/sdk/src/multiparty.test.ts) of using real strkeys instead of
// fabricated ones.
const ORACLE_CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";
const PRICEFLOOR_CONTRACT_ID = "CDHPDF4TZDJVBFGSOGVTNEKQNNJQR326JSATYXY7ZWD63L6PS2NTJB47";
const ENV = { oracleContractId: ORACLE_CONTRACT_ID, pricefloorContractId: PRICEFLOOR_CONTRACT_ID };

// Real, valid-checksum account addresses (Keypair.random(), matching this
// repo's existing test convention in packages/sdk/src/*.test.ts), generated
// once for the whole file: only their validity as real strkeys and their
// distinctness from each other matters here, not which real accounts they
// happen to be.
const NODE_A = Keypair.random().publicKey();
const NODE_B = Keypair.random().publicKey();
const NODE_C = Keypair.random().publicKey();

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(schema);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE nodes, node_submissions, price_finalizations, pricefloor_events, oracle_events, price_history, commodities, indexer_cursor CASCADE",
  );
});

let ledgerCounter = 1;
function nextLedger(): number {
  ledgerCounter += 1;
  return ledgerCounter;
}

/** A real, valid Asset topic ScVal, built the same way pricefloor.ts's own
 * assetToScVal does: an ScVec of [tag Symbol, value], for an Asset::Other. */
function assetTopicScVal(symbol: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), nativeToScVal(symbol, { type: "symbol" })]);
}

function dataMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const keys = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(
    keys.map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
}

/** Builds a real StellarRpc.Api.EventResponse-shaped object, mirroring
 * exactly what #[contractevent] actually publishes (topic[0] = the
 * snake_case event name Symbol, remaining #[topic] fields after it, then a
 * Map of the struct's non-topic fields as `value`, soroban-sdk-macros
 * 27.0.6's default data_format), so handleEvent is exercised against real
 * XDR shapes, not a hand-typed stand-in. */
function makeEvent(opts: {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: xdr.ScVal[];
  data?: Record<string, xdr.ScVal>;
  ledgerClosedAt?: string;
}): StellarRpc.Api.EventResponse {
  return {
    id: `${opts.ledger}-0000000001`,
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(2026, 8, opts.ledger).toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: opts.txHash,
    contractId: new Contract(opts.contractId),
    topic: opts.topics,
    value: dataMap(opts.data ?? {}),
  };
}

function priceSubmittedEvent(opts: { ledger: number; txHash: string; symbol: string; node: string; price: bigint }) {
  return makeEvent({
    contractId: ORACLE_CONTRACT_ID,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [
      xdr.ScVal.scvSymbol("price_submitted"),
      assetTopicScVal(opts.symbol),
      nativeToScVal(opts.node, { type: "address" }),
    ],
    data: { price: nativeToScVal(opts.price, { type: "i128" }) },
  });
}

function priceFinalizedEvent(opts: { ledger: number; txHash: string; symbol: string; price: bigint; timestamp: bigint }) {
  return makeEvent({
    contractId: ORACLE_CONTRACT_ID,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [xdr.ScVal.scvSymbol("price_finalized"), assetTopicScVal(opts.symbol)],
    data: {
      price: nativeToScVal(opts.price, { type: "i128" }),
      timestamp: nativeToScVal(opts.timestamp, { type: "u64" }),
    },
  });
}

describe("handleEvent: price_finalized contributing node reconstruction (F-06)", () => {
  it("attributes a finalized price to exactly the nodes that submitted since the previous finalization", async () => {
    const nodeA = NODE_A;
    const nodeB = NODE_B;
    const l1 = nextLedger();
    const l2 = nextLedger();
    const l3 = nextLedger(); // finalization ledger

    await handleEvent(priceSubmittedEvent({ ledger: l1, txHash: "tx-sub-a", symbol: "COCOA", node: nodeA, price: 600000n }), pool, ENV);
    await handleEvent(priceSubmittedEvent({ ledger: l2, txHash: "tx-sub-b", symbol: "COCOA", node: nodeB, price: 620000n }), pool, ENV);
    await handleEvent(
      priceFinalizedEvent({ ledger: l3, txHash: "tx-final-1", symbol: "COCOA", price: 610000n, timestamp: 1000n }),
      pool,
      ENV,
    );

    const result = await pool.query<{ contributing_nodes: string[] }>(
      `SELECT contributing_nodes FROM price_finalizations WHERE tx_hash = 'tx-final-1'`,
    );

    expect(result.rows[0]?.contributing_nodes.slice().sort()).toEqual([nodeA, nodeB].sort());
  });

  it("gives a later finalization a different contributing set than an earlier one for the same commodity", async () => {
    const nodeA = NODE_A;
    const nodeB = NODE_B;
    const nodeC = NODE_C;

    const l1 = nextLedger();
    const l2 = nextLedger();
    const finalize1 = nextLedger();
    const l3 = nextLedger();
    const finalize2 = nextLedger();

    await handleEvent(priceSubmittedEvent({ ledger: l1, txHash: "tx-a1", symbol: "COFFEE", node: nodeA, price: 100n }), pool, ENV);
    await handleEvent(priceSubmittedEvent({ ledger: l2, txHash: "tx-b1", symbol: "COFFEE", node: nodeB, price: 105n }), pool, ENV);
    await handleEvent(
      priceFinalizedEvent({ ledger: finalize1, txHash: "tx-final-a", symbol: "COFFEE", price: 102n, timestamp: 1n }),
      pool,
      ENV,
    );

    // Only nodeC submits before the second finalize: nodeA/nodeB's earlier
    // submissions were already consumed by finalize_price and must not
    // bleed into this later window.
    await handleEvent(priceSubmittedEvent({ ledger: l3, txHash: "tx-c1", symbol: "COFFEE", node: nodeC, price: 110n }), pool, ENV);
    await handleEvent(
      priceFinalizedEvent({ ledger: finalize2, txHash: "tx-final-b", symbol: "COFFEE", price: 110n, timestamp: 2n }),
      pool,
      ENV,
    );

    const rows = await pool.query<{ tx_hash: string; contributing_nodes: string[] }>(
      `SELECT tx_hash, contributing_nodes FROM price_finalizations WHERE symbol = 'COFFEE' ORDER BY ledger ASC`,
    );

    expect(rows.rows[0]?.contributing_nodes.slice().sort()).toEqual([nodeA, nodeB].sort());
    expect(rows.rows[1]?.contributing_nodes).toEqual([nodeC]);
  });

  it("backfillContributingNodes repairs a historical row stored with the old hardcoded empty array", async () => {
    const nodeA = NODE_A;
    const l1 = nextLedger();
    const finalizeLedger = nextLedger();

    await pool.query(
      `INSERT INTO commodities (symbol, decimals, resolution) VALUES ('CASHEW', 7, 60) ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO node_submissions (node_address, symbol, price, source_ts, ledger, tx_hash)
       VALUES ($1, 'CASHEW', '500', now(), $2, 'tx-old-sub')`,
      [nodeA, l1],
    );
    // Simulates a row written by the pre-fix code, which always hardcoded [].
    await pool.query(
      `INSERT INTO price_finalizations (symbol, price, price_timestamp, ledger, tx_hash, contributing_nodes)
       VALUES ('CASHEW', '500', now(), $1, 'tx-old-final', '{}')`,
      [finalizeLedger],
    );

    await backfillContributingNodes(pool);

    const result = await pool.query<{ contributing_nodes: string[] }>(
      `SELECT contributing_nodes FROM price_finalizations WHERE tx_hash = 'tx-old-final'`,
    );
    expect(result.rows[0]?.contributing_nodes).toEqual([nodeA]);
  });
});

describe("handleEvent: F-07 oracle admin/config events", () => {
  it("indexes threshold_updated with the real threshold value", async () => {
    const ledger = nextLedger();
    await handleEvent(
      makeEvent({
        contractId: ORACLE_CONTRACT_ID,
        ledger,
        txHash: "tx-threshold",
        topics: [xdr.ScVal.scvSymbol("threshold_updated"), nativeToScVal(3, { type: "u32" })],
      }),
      pool,
      ENV,
    );

    const row = await pool.query<{ contract_id: string; event_type: string; data: { threshold: string } }>(
      `SELECT contract_id, event_type, data FROM oracle_events WHERE tx_hash = 'tx-threshold'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.contract_id).toBe(ORACLE_CONTRACT_ID);
    expect(row.rows[0]?.event_type).toBe("threshold_updated");
    expect(row.rows[0]?.data.threshold).toBe("3");
  });

  it("indexes retention_updated with the real retention value", async () => {
    const ledger = nextLedger();
    await handleEvent(
      makeEvent({
        contractId: ORACLE_CONTRACT_ID,
        ledger,
        txHash: "tx-retention",
        topics: [xdr.ScVal.scvSymbol("retention_updated"), nativeToScVal(120, { type: "u32" })],
      }),
      pool,
      ENV,
    );

    const row = await pool.query<{ event_type: string; data: { retention: string } }>(
      `SELECT event_type, data FROM oracle_events WHERE tx_hash = 'tx-retention'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.event_type).toBe("retention_updated");
    expect(row.rows[0]?.data.retention).toBe("120");
  });

  it("indexes commodity_added with the real commodity symbol", async () => {
    const ledger = nextLedger();
    await handleEvent(
      makeEvent({
        contractId: ORACLE_CONTRACT_ID,
        ledger,
        txHash: "tx-commodity",
        topics: [xdr.ScVal.scvSymbol("commodity_added"), assetTopicScVal("MAIZE")],
      }),
      pool,
      ENV,
    );

    const row = await pool.query<{ event_type: string; data: { symbol: string } }>(
      `SELECT event_type, data FROM oracle_events WHERE tx_hash = 'tx-commodity'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.event_type).toBe("commodity_added");
    expect(row.rows[0]?.data.symbol).toBe("MAIZE");
  });
});

describe("handleEvent: Initialized collision disambiguation (F-07)", () => {
  it("routes the oracle's own Initialized event to oracle_events, never pricefloor_events", async () => {
    const admin = NODE_A;
    const ledger = nextLedger();
    await handleEvent(
      makeEvent({
        contractId: ORACLE_CONTRACT_ID,
        ledger,
        txHash: "tx-oracle-init",
        topics: [xdr.ScVal.scvSymbol("initialized"), nativeToScVal(admin, { type: "address" })],
        data: {
          base_asset: assetTopicScVal("USDC"),
          decimals: nativeToScVal(7, { type: "u32" }),
          resolution: nativeToScVal(60, { type: "u32" }),
        },
      }),
      pool,
      ENV,
    );

    const oracleRows = await pool.query(`SELECT * FROM oracle_events WHERE tx_hash = 'tx-oracle-init'`);
    const pricefloorRows = await pool.query(`SELECT * FROM pricefloor_events WHERE tx_hash = 'tx-oracle-init'`);

    expect(oracleRows.rows).toHaveLength(1);
    expect(oracleRows.rows[0].event_type).toBe("initialized");
    expect(oracleRows.rows[0].contract_id).toBe(ORACLE_CONTRACT_ID);
    expect(pricefloorRows.rows).toHaveLength(0);
  });

  it("routes PriceFloor's own Initialized event to pricefloor_events, never oracle_events", async () => {
    const farmer = NODE_A;
    const buyer = NODE_B;
    const ledger = nextLedger();
    await handleEvent(
      makeEvent({
        contractId: PRICEFLOOR_CONTRACT_ID,
        ledger,
        txHash: "tx-pricefloor-init",
        topics: [
          xdr.ScVal.scvSymbol("initialized"),
          nativeToScVal(farmer, { type: "address" }),
          nativeToScVal(buyer, { type: "address" }),
        ],
        data: {
          commodity: assetTopicScVal("COCOA"),
          floor_price: nativeToScVal(618800n, { type: "i128" }),
          notional: nativeToScVal(100000n, { type: "i128" }),
          maturity_ts: nativeToScVal(2_000_000_000n, { type: "u64" }),
        },
      }),
      pool,
      ENV,
    );

    const pricefloorRows = await pool.query(`SELECT * FROM pricefloor_events WHERE tx_hash = 'tx-pricefloor-init'`);
    const oracleRows = await pool.query(`SELECT * FROM oracle_events WHERE tx_hash = 'tx-pricefloor-init'`);

    expect(pricefloorRows.rows).toHaveLength(1);
    expect(pricefloorRows.rows[0].event_type).toBe("initialized");
    expect(pricefloorRows.rows[0].contract_id).toBe(PRICEFLOOR_CONTRACT_ID);
    expect(oracleRows.rows).toHaveLength(0);
  });
});

describe("handleEvent: existing PriceFloor event handling still works (regression)", () => {
  it("still indexes funded, settled, and cancelled correctly", async () => {
    const buyer = NODE_B;
    const farmer = NODE_A;

    await handleEvent(
      makeEvent({
        contractId: PRICEFLOOR_CONTRACT_ID,
        ledger: nextLedger(),
        txHash: "tx-funded",
        topics: [xdr.ScVal.scvSymbol("funded"), nativeToScVal(buyer, { type: "address" })],
        data: { amount: nativeToScVal(100000n, { type: "i128" }) },
      }),
      pool,
      ENV,
    );
    await handleEvent(
      makeEvent({
        contractId: PRICEFLOOR_CONTRACT_ID,
        ledger: nextLedger(),
        txHash: "tx-settled",
        topics: [xdr.ScVal.scvSymbol("settled"), nativeToScVal(farmer, { type: "address" })],
        data: { payout: nativeToScVal(5000n, { type: "i128" }), market_price: nativeToScVal(600000n, { type: "i128" }) },
      }),
      pool,
      ENV,
    );
    await handleEvent(
      makeEvent({
        contractId: PRICEFLOOR_CONTRACT_ID,
        ledger: nextLedger(),
        txHash: "tx-cancelled",
        topics: [xdr.ScVal.scvSymbol("cancelled"), nativeToScVal(farmer, { type: "address" })],
      }),
      pool,
      ENV,
    );

    const rows = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM pricefloor_events WHERE tx_hash IN ('tx-funded', 'tx-settled', 'tx-cancelled') ORDER BY event_type`,
    );
    expect(rows.rows.map((r) => r.event_type)).toEqual(["cancelled", "funded", "settled"]);
  });

  it("still indexes node_added/node_removed correctly (pre-existing behavior, unaffected by this step)", async () => {
    const node = NODE_A;
    await handleEvent(
      makeEvent({
        contractId: ORACLE_CONTRACT_ID,
        ledger: nextLedger(),
        txHash: "tx-node-added",
        topics: [xdr.ScVal.scvSymbol("node_added"), nativeToScVal(node, { type: "address" })],
      }),
      pool,
      ENV,
    );

    const row = await pool.query(`SELECT address, removed_at FROM nodes WHERE address = $1`, [node]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].removed_at).toBeNull();
  });
});
