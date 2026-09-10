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

// Two genuinely, independently deployed AND initialized AgriPriceFloor
// instances on Stellar Testnet (Phase 4 Step 2's own real E2E evidence,
// deployed/initialized via the stellar CLI, see that step's implementation
// report for the exact commands and transaction hashes). Real contract ids,
// real farmer/buyer accounts, real terms, not fabricated: this is the
// "deterministic fixture/test path for at least two PriceFloor instances"
// requirement, using the actual chain data rather than invented strings.
const PF_INSTANCE_1 = "CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN";
const PF_INSTANCE_1_FARMER = "GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62";
const PF_INSTANCE_1_BUYER = "GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3";
const PF_INSTANCE_1_INIT_TX = "87e9b50c0150122c187d263b45d9cae4001f21dcd7482588328e311a48986283";
const PF_INSTANCE_1_FUND_TX = "03a0bb979878f4a8d2819b4432bcacde37cedb365c1dc1f3100929b308158b5d";

const PF_INSTANCE_2 = "CC4YDCQJL4PYXJGC3QSPW3WXNQMEVL6QDJEHH3E556EOEEPUN4RVC6P7";
const PF_INSTANCE_2_FARMER = "GDWU5YGNHNL3ZW35732OU5C2ORTNYFM32YVL2LMTC4UAWHXFS3MNTW7T";
const PF_INSTANCE_2_BUYER = "GABZIONIHNKUA2YLWDWESPJC7R23UQJ2GPM6CM4RSZJQ7VZ73WQ25AES";
const PF_INSTANCE_2_INIT_TX = "5cb837d1300bd962fbf3b617cb9e213a4af97adfd7e16b3b2ff46022997ba6c5";

/** Registers a PriceFloor instance the same way registerInstance() would
 * after a real RPC verification, without hitting the network in these
 * offline handleEvent tests: seeds the row directly at 'registered', which
 * is exactly the state registerInstance leaves it in. */
async function seedRegisteredInstance(contractId: string, ledger = 1): Promise<void> {
  await pool.query(
    `INSERT INTO pricefloor_instances (contract_id, status, registered_at_ledger) VALUES ($1, 'registered', $2)`,
    [contractId, ledger],
  );
}

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
    "TRUNCATE nodes, node_submissions, price_finalizations, pricefloor_events, oracle_events, price_history, commodities, indexer_cursor, pricefloor_instances CASCADE",
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

function pricefloorInitializedEvent(opts: {
  contractId: string;
  ledger: number;
  txHash: string;
  farmer: string;
  buyer: string;
  commodity: string;
  floorPrice: bigint;
  notional: bigint;
  maturityTs: bigint;
}) {
  return makeEvent({
    contractId: opts.contractId,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [
      xdr.ScVal.scvSymbol("initialized"),
      nativeToScVal(opts.farmer, { type: "address" }),
      nativeToScVal(opts.buyer, { type: "address" }),
    ],
    data: {
      commodity: assetTopicScVal(opts.commodity),
      floor_price: nativeToScVal(opts.floorPrice, { type: "i128" }),
      notional: nativeToScVal(opts.notional, { type: "i128" }),
      maturity_ts: nativeToScVal(opts.maturityTs, { type: "u64" }),
    },
  });
}

function pricefloorFundedEvent(opts: { contractId: string; ledger: number; txHash: string; buyer: string; amount: bigint }) {
  return makeEvent({
    contractId: opts.contractId,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [xdr.ScVal.scvSymbol("funded"), nativeToScVal(opts.buyer, { type: "address" })],
    data: { amount: nativeToScVal(opts.amount, { type: "i128" }) },
  });
}

function pricefloorSettledEvent(opts: { contractId: string; ledger: number; txHash: string; farmer: string; payout: bigint; marketPrice: bigint }) {
  return makeEvent({
    contractId: opts.contractId,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [xdr.ScVal.scvSymbol("settled"), nativeToScVal(opts.farmer, { type: "address" })],
    data: { payout: nativeToScVal(opts.payout, { type: "i128" }), market_price: nativeToScVal(opts.marketPrice, { type: "i128" }) },
  });
}

function pricefloorCancelledEvent(opts: { contractId: string; ledger: number; txHash: string; caller: string }) {
  return makeEvent({
    contractId: opts.contractId,
    ledger: opts.ledger,
    txHash: opts.txHash,
    topics: [xdr.ScVal.scvSymbol("cancelled"), nativeToScVal(opts.caller, { type: "address" })],
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

describe("handleEvent: Phase 4 multi-instance PriceFloor discovery", () => {
  it("indexes two independently registered PriceFloor instances without confusing their state (real Testnet fixture)", async () => {
    await seedRegisteredInstance(PF_INSTANCE_1);
    await seedRegisteredInstance(PF_INSTANCE_2);

    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_1,
        ledger: nextLedger(),
        txHash: PF_INSTANCE_1_INIT_TX,
        farmer: PF_INSTANCE_1_FARMER,
        buyer: PF_INSTANCE_1_BUYER,
        commodity: "COCOA",
        floorPrice: 61880000000n,
        notional: 10000000n,
        maturityTs: 1791626527n,
      }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_2,
        ledger: nextLedger(),
        txHash: PF_INSTANCE_2_INIT_TX,
        farmer: PF_INSTANCE_2_FARMER,
        buyer: PF_INSTANCE_2_BUYER,
        commodity: "COFFEE",
        floorPrice: 48950000000n,
        notional: 5000000n,
        maturityTs: 1792922556n,
      }),
      pool,
      ENV,
    );

    const rows = await pool.query<{
      contract_id: string;
      status: string;
      farmer: string;
      buyer: string;
      commodity: unknown;
      floor_price: string;
      notional: string;
    }>(`SELECT contract_id, status, farmer, buyer, commodity, floor_price, notional FROM pricefloor_instances ORDER BY contract_id`);

    expect(rows.rows).toHaveLength(2);
    const byId = new Map(rows.rows.map((r) => [r.contract_id, r]));

    const instance1 = byId.get(PF_INSTANCE_1);
    expect(instance1?.status).toBe("initialized");
    expect(instance1?.farmer).toBe(PF_INSTANCE_1_FARMER);
    expect(instance1?.buyer).toBe(PF_INSTANCE_1_BUYER);
    expect(instance1?.commodity).toEqual(["Other", "COCOA"]);
    expect(instance1?.floor_price).toBe("61880000000");
    expect(instance1?.notional).toBe("10000000");

    const instance2 = byId.get(PF_INSTANCE_2);
    expect(instance2?.status).toBe("initialized");
    expect(instance2?.farmer).toBe(PF_INSTANCE_2_FARMER);
    expect(instance2?.buyer).toBe(PF_INSTANCE_2_BUYER);
    expect(instance2?.commodity).toEqual(["Other", "COFFEE"]);
    expect(instance2?.floor_price).toBe("48950000000");
    expect(instance2?.notional).toBe("5000000");
  });

  it("keeps events from two different instances isolated in pricefloor_events by contract_id", async () => {
    await seedRegisteredInstance(PF_INSTANCE_1);
    await seedRegisteredInstance(PF_INSTANCE_2);

    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_1,
        ledger: nextLedger(),
        txHash: PF_INSTANCE_1_INIT_TX,
        farmer: PF_INSTANCE_1_FARMER,
        buyer: PF_INSTANCE_1_BUYER,
        commodity: "COCOA",
        floorPrice: 61880000000n,
        notional: 10000000n,
        maturityTs: 1791626527n,
      }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_2,
        ledger: nextLedger(),
        txHash: PF_INSTANCE_2_INIT_TX,
        farmer: PF_INSTANCE_2_FARMER,
        buyer: PF_INSTANCE_2_BUYER,
        commodity: "COFFEE",
        floorPrice: 48950000000n,
        notional: 5000000n,
        maturityTs: 1792922556n,
      }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorFundedEvent({ contractId: PF_INSTANCE_1, ledger: nextLedger(), txHash: PF_INSTANCE_1_FUND_TX, buyer: PF_INSTANCE_1_BUYER, amount: 100000000n }),
      pool,
      ENV,
    );

    const instance1Events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM pricefloor_events WHERE contract_id = $1 ORDER BY event_type`,
      [PF_INSTANCE_1],
    );
    const instance2Events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM pricefloor_events WHERE contract_id = $1 ORDER BY event_type`,
      [PF_INSTANCE_2],
    );

    expect(instance1Events.rows.map((r) => r.event_type)).toEqual(["funded", "initialized"]);
    expect(instance2Events.rows.map((r) => r.event_type)).toEqual(["initialized"]);

    // Funding instance 1 must never advance instance 2's status.
    const instance2Row = await pool.query<{ status: string }>(
      `SELECT status FROM pricefloor_instances WHERE contract_id = $1`,
      [PF_INSTANCE_2],
    );
    expect(instance2Row.rows[0]?.status).toBe("initialized");

    const instance1Row = await pool.query<{ status: string }>(
      `SELECT status FROM pricefloor_instances WHERE contract_id = $1`,
      [PF_INSTANCE_1],
    );
    expect(instance1Row.rows[0]?.status).toBe("funded");
  });

  it("advances funded -> settled -> cancelled only for the instance the event actually came from", async () => {
    await seedRegisteredInstance(PF_INSTANCE_1);
    await seedRegisteredInstance(PF_INSTANCE_2);
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_1,
        ledger: nextLedger(),
        txHash: "tx-iso-init-1",
        farmer: PF_INSTANCE_1_FARMER,
        buyer: PF_INSTANCE_1_BUYER,
        commodity: "COCOA",
        floorPrice: 100n,
        notional: 10n,
        maturityTs: 2000000000n,
      }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PF_INSTANCE_2,
        ledger: nextLedger(),
        txHash: "tx-iso-init-2",
        farmer: PF_INSTANCE_2_FARMER,
        buyer: PF_INSTANCE_2_BUYER,
        commodity: "COFFEE",
        floorPrice: 200n,
        notional: 20n,
        maturityTs: 2000000000n,
      }),
      pool,
      ENV,
    );

    await handleEvent(
      pricefloorSettledEvent({ contractId: PF_INSTANCE_1, ledger: nextLedger(), txHash: "tx-iso-settled-1", farmer: PF_INSTANCE_1_FARMER, payout: 5n, marketPrice: 90n }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorCancelledEvent({ contractId: PF_INSTANCE_2, ledger: nextLedger(), txHash: "tx-iso-cancelled-2", caller: PF_INSTANCE_2_FARMER }),
      pool,
      ENV,
    );

    const statuses = await pool.query<{ contract_id: string; status: string }>(
      `SELECT contract_id, status FROM pricefloor_instances ORDER BY contract_id`,
    );
    const byId = new Map(statuses.rows.map((r) => [r.contract_id, r.status]));
    expect(byId.get(PF_INSTANCE_1)).toBe("settled");
    expect(byId.get(PF_INSTANCE_2)).toBe("cancelled");
  });

  it("is idempotent: re-processing the same Initialized event twice leaves exactly one pricefloor_events row and one pricefloor_instances row", async () => {
    await seedRegisteredInstance(PF_INSTANCE_1);
    const event = pricefloorInitializedEvent({
      contractId: PF_INSTANCE_1,
      ledger: nextLedger(),
      txHash: PF_INSTANCE_1_INIT_TX,
      farmer: PF_INSTANCE_1_FARMER,
      buyer: PF_INSTANCE_1_BUYER,
      commodity: "COCOA",
      floorPrice: 61880000000n,
      notional: 10000000n,
      maturityTs: 1791626527n,
    });

    await handleEvent(event, pool, ENV);
    await handleEvent(event, pool, ENV); // simulates getEvents redelivering the same event on a retry

    const events = await pool.query(`SELECT * FROM pricefloor_events WHERE tx_hash = $1`, [PF_INSTANCE_1_INIT_TX]);
    const instances = await pool.query(`SELECT * FROM pricefloor_instances WHERE contract_id = $1`, [PF_INSTANCE_1]);
    expect(events.rows).toHaveLength(1);
    expect(instances.rows).toHaveLength(1);
  });

  it("rejects an Initialized event from a contract id that was never registered and is not the legacy instance", async () => {
    // A real, valid-checksum contract id (native XLM's Stellar Asset
    // Contract, also used elsewhere in this project as a settlement token),
    // but never a PriceFloor instance and never registered here -- exactly
    // the "some other real contract emitted an event shaped like ours"
    // case this check must still reject.
    const unregistered = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: unregistered,
        ledger: nextLedger(),
        txHash: "tx-unregistered-init",
        farmer: NODE_A,
        buyer: NODE_B,
        commodity: "COCOA",
        floorPrice: 100n,
        notional: 10n,
        maturityTs: 2000000000n,
      }),
      pool,
      ENV,
    );

    const events = await pool.query(`SELECT * FROM pricefloor_events WHERE tx_hash = 'tx-unregistered-init'`);
    const instances = await pool.query(`SELECT * FROM pricefloor_instances WHERE contract_id = $1`, [unregistered]);
    expect(events.rows).toHaveLength(0);
    expect(instances.rows).toHaveLength(0);
  });

  it("still indexes the fixed legacy PriceFloor instance (PRICEFLOOR_CONTRACT_ID) without it being pre-registered", async () => {
    // The legacy instance is recognized by env.pricefloorContractId alone,
    // matching how it already worked before Phase 4 -- it is never required
    // to appear in pricefloor_instances first.
    await handleEvent(
      pricefloorInitializedEvent({
        contractId: PRICEFLOOR_CONTRACT_ID,
        ledger: nextLedger(),
        txHash: "tx-legacy-init",
        farmer: NODE_A,
        buyer: NODE_B,
        commodity: "COCOA",
        floorPrice: 618800n,
        notional: 1000n,
        maturityTs: 2000000000n,
      }),
      pool,
      ENV,
    );
    await handleEvent(
      pricefloorFundedEvent({ contractId: PRICEFLOOR_CONTRACT_ID, ledger: nextLedger(), txHash: "tx-legacy-funded", buyer: NODE_B, amount: 5000n }),
      pool,
      ENV,
    );

    const row = await pool.query<{ status: string; farmer: string; buyer: string }>(
      `SELECT status, farmer, buyer FROM pricefloor_instances WHERE contract_id = $1`,
      [PRICEFLOOR_CONTRACT_ID],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.status).toBe("funded");
    expect(row.rows[0]?.farmer).toBe(NODE_A);
    expect(row.rows[0]?.buyer).toBe(NODE_B);
  });
});
