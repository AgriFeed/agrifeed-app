import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "./server.js";
import type { IndexerEnv } from "../env.js";

/**
 * Real Postgres, real HTTP server, real fetch -- no mocked chain state and
 * no mocked HTTP layer, matching this project's existing test convention
 * (see instances.test.ts/poll.test.ts's own doc comments). The one thing
 * that is *not* a real on-chain event in every fixture below is noted
 * inline: a `cancelled` row is seeded directly rather than produced by a
 * real cancel() call, since a live cancel() cannot complete inside a test
 * run (see docs/phase4-step4-lifecycle-and-decision.md -- its grace
 * periods are real 48-96 hour waits on Testnet). Event-ingestion coverage
 * for cancelled (a real Cancelled event actually advancing the row) is
 * poll.test.ts's job, already covered there with a synthetic event for the
 * same reason. This file only tests the read API layer: given a row in
 * this shape, does GET /api/deals serve it correctly.
 */
const TEST_DATABASE_URL =
  process.env.INDEXER_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable";

// Real, valid (StrKey-checksummed) contract ids and account addresses,
// reused from this project's own real Testnet fixtures (Phase 4 Steps 2
// and 4, see their implementation reports) rather than invented strings,
// so /api/deals/:contractId's format validation (StrKey.isValidContract)
// accepts them exactly as it would a real caller's.
const INSTANCE_1 = "CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN";
const INSTANCE_2 = "CC4YDCQJL4PYXJGC3QSPW3WXNQMEVL6QDJEHH3E556EOEEPUN4RVC6P7";
const INSTANCE_3 = "CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272";
// Real, valid, but never inserted into this test database's
// pricefloor_instances -- the oracle's own contract id, a genuine Soroban
// contract id that is simply not a registered PriceFloor deal.
const UNKNOWN_BUT_VALID_CONTRACT = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";

const FARMER_1 = "GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62";
const BUYER_1 = "GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3";
const FARMER_2 = "GDWU5YGNHNL3ZW35732OU5C2ORTNYFM32YVL2LMTC4UAWHXFS3MNTW7T";
const BUYER_2 = "GABZIONIHNKUA2YLWDWESPJC7R23UQJ2GPM6CM4RSZJQ7VZ73WQ25AES";

const env: IndexerEnv = {
  databaseUrl: TEST_DATABASE_URL,
  apiPort: 0,
  rpcUrl: "https://soroban-testnet.stellar.org",
};

let pool: pg.Pool;
let server: Server;
let baseUrl: string;

interface DealFixture {
  contractId: string;
  status: "registered" | "initialized" | "funded" | "settled" | "cancelled";
  farmer?: string | null;
  buyer?: string | null;
  registeredAtLedger?: number;
}

async function insertDeal(f: DealFixture): Promise<void> {
  const now = new Date();
  const initializedAt = f.status === "registered" ? null : now;
  const fundedAt = ["funded", "settled", "cancelled"].includes(f.status) ? now : null;
  const settledAt = f.status === "settled" ? now : null;
  const cancelledAt = f.status === "cancelled" ? now : null;
  await pool.query(
    `INSERT INTO pricefloor_instances
       (contract_id, status, farmer, buyer, commodity, floor_price, notional, settlement_token, maturity_ts,
        oracle_contract_id, registered_at_ledger, initialized_at, funded_at, settled_at, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15)`,
    [
      f.contractId,
      f.status,
      f.farmer ?? null,
      f.buyer ?? null,
      f.status === "registered" ? null : JSON.stringify(["Other", "COCOA"]),
      f.status === "registered" ? null : "40000000000",
      f.status === "registered" ? null : "100",
      f.status === "registered" ? null : "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      f.status === "registered" ? null : Math.floor(Date.now() / 1000) + 3600,
      f.status === "registered" ? null : "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T",
      f.registeredAtLedger ?? 1,
      initializedAt,
      fundedAt,
      settledAt,
      cancelledAt,
    ],
  );
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(schema);

  const app = createApp(env, pool);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE pricefloor_instances CASCADE");
});

describe("GET /api/deals -- empty registry", () => {
  it("returns an empty list, not an error, when nothing is registered", async () => {
    const res = await fetch(`${baseUrl}/api/deals`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deals: [], limit: 50, offset: 0 });
  });
});

describe("GET /api/deals -- one deal", () => {
  it("returns exactly that deal, fields allowlisted and camelCased", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "funded", farmer: FARMER_1, buyer: BUYER_1, registeredAtLedger: 42 });

    const res = await fetch(`${baseUrl}/api/deals`);
    const body = (await res.json()) as { deals: Array<Record<string, unknown>> };
    expect(body.deals).toHaveLength(1);
    const deal = body.deals[0]!;
    expect(deal).toMatchObject({
      contractId: INSTANCE_1,
      status: "funded",
      farmer: FARMER_1,
      buyer: BUYER_1,
      registeredAtLedger: 42,
    });
    // Never a raw DB column name (snake_case) alongside or instead of the
    // allowlisted camelCase field -- this is the "no internal field
    // disclosure" requirement made concrete.
    expect(deal).not.toHaveProperty("contract_id");
    expect(deal).not.toHaveProperty("registered_at_ledger");
    expect(Object.keys(deal).sort()).toEqual(
      [
        "buyer",
        "cancelledAt",
        "commodity",
        "contractId",
        "farmer",
        "floorPrice",
        "fundedAt",
        "initializedAt",
        "maturityTs",
        "notional",
        "oracleContractId",
        "registeredAt",
        "registeredAtLedger",
        "settledAt",
        "settlementToken",
        "status",
      ].sort(),
    );
  });
});

describe("GET /api/deals -- multiple deals, ordering and isolation", () => {
  it("returns every deal, most recently registered first, with no cross-instance contamination", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "registered", registeredAtLedger: 100 });
    await insertDeal({ contractId: INSTANCE_2, status: "funded", farmer: FARMER_2, buyer: BUYER_2, registeredAtLedger: 200 });
    await insertDeal({ contractId: INSTANCE_3, status: "settled", farmer: FARMER_1, buyer: BUYER_1, registeredAtLedger: 300 });

    const res = await fetch(`${baseUrl}/api/deals`);
    const body = (await res.json()) as { deals: Array<{ contractId: string; status: string }> };
    expect(body.deals.map((d) => d.contractId)).toEqual([INSTANCE_3, INSTANCE_2, INSTANCE_1]);
    expect(body.deals.map((d) => d.status)).toEqual(["settled", "funded", "registered"]);
  });
});

describe("GET /api/deals?farmer=", () => {
  it("returns only that farmer's deals, never the buyer's or an unrelated instance's", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "funded", farmer: FARMER_1, buyer: BUYER_1 });
    await insertDeal({ contractId: INSTANCE_2, status: "funded", farmer: FARMER_2, buyer: BUYER_2 });

    const res = await fetch(`${baseUrl}/api/deals?farmer=${FARMER_1}`);
    const body = (await res.json()) as { deals: Array<{ contractId: string }> };
    expect(body.deals).toHaveLength(1);
    expect(body.deals[0]?.contractId).toBe(INSTANCE_1);
  });
});

describe("GET /api/deals?buyer=", () => {
  it("returns only that buyer's deals, isolated from the other instance", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "funded", farmer: FARMER_1, buyer: BUYER_1 });
    await insertDeal({ contractId: INSTANCE_2, status: "funded", farmer: FARMER_2, buyer: BUYER_2 });

    const res = await fetch(`${baseUrl}/api/deals?buyer=${BUYER_2}`);
    const body = (await res.json()) as { deals: Array<{ contractId: string }> };
    expect(body.deals).toHaveLength(1);
    expect(body.deals[0]?.contractId).toBe(INSTANCE_2);
  });

  it("combines farmer and buyer as AND, not OR, when both are given", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "funded", farmer: FARMER_1, buyer: BUYER_1 });
    await insertDeal({ contractId: INSTANCE_2, status: "funded", farmer: FARMER_2, buyer: BUYER_2 });

    // FARMER_1 is never BUYER_2 on any deal, so this must return nothing,
    // not INSTANCE_1 (which matches farmer alone) or INSTANCE_2 (which
    // matches buyer alone).
    const res = await fetch(`${baseUrl}/api/deals?farmer=${FARMER_1}&buyer=${BUYER_2}`);
    const body = (await res.json()) as { deals: unknown[] };
    expect(body.deals).toHaveLength(0);
  });
});

describe("GET /api/deals -- pagination", () => {
  beforeEach(async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "registered", registeredAtLedger: 1 });
    await insertDeal({ contractId: INSTANCE_2, status: "registered", registeredAtLedger: 2 });
    await insertDeal({ contractId: INSTANCE_3, status: "registered", registeredAtLedger: 3 });
  });

  it("limits the page size and echoes back the effective limit/offset", async () => {
    const res = await fetch(`${baseUrl}/api/deals?limit=2`);
    const body = (await res.json()) as { deals: unknown[]; limit: number; offset: number };
    expect(body.deals).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it("offset moves the window forward without repeating or skipping rows", async () => {
    const page1 = (await (await fetch(`${baseUrl}/api/deals?limit=2&offset=0`)).json()) as {
      deals: Array<{ contractId: string }>;
    };
    const page2 = (await (await fetch(`${baseUrl}/api/deals?limit=2&offset=2`)).json()) as {
      deals: Array<{ contractId: string }>;
    };
    expect(page1.deals).toHaveLength(2);
    expect(page2.deals).toHaveLength(1);
    const allIds = [...page1.deals, ...page2.deals].map((d) => d.contractId);
    expect(new Set(allIds).size).toBe(3);
  });

  it("clamps an excessive limit rather than rejecting it", async () => {
    const res = await fetch(`${baseUrl}/api/deals?limit=999999`);
    const body = (await res.json()) as { limit: number };
    expect(res.status).toBe(200);
    expect(body.limit).toBe(200);
  });
});

describe("GET /api/deals -- malformed query parameters", () => {
  it("rejects a farmer address that isn't a valid Stellar account address", async () => {
    const res = await fetch(`${baseUrl}/api/deals?farmer=not-an-address`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("farmer") });
  });

  it("rejects a buyer address that isn't a valid Stellar account address", async () => {
    // A contract id, not an account address -- a real, easy-to-make
    // mistake this must still catch, not silently treat as a query that
    // simply matches nothing.
    const res = await fetch(`${baseUrl}/api/deals?buyer=${INSTANCE_1}`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("buyer") });
  });

  it("rejects a non-numeric limit", async () => {
    const res = await fetch(`${baseUrl}/api/deals?limit=abc`);
    expect(res.status).toBe(400);
  });

  it("rejects a negative offset", async () => {
    const res = await fetch(`${baseUrl}/api/deals?offset=-1`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/deals/:contractId", () => {
  it("returns the settled deal's full terms and lifecycle timestamps", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "settled", farmer: FARMER_1, buyer: BUYER_1 });

    const res = await fetch(`${baseUrl}/api/deals/${INSTANCE_1}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { status: string; settledAt: string | null; fundedAt: string | null } };
    expect(body.deal.status).toBe("settled");
    expect(body.deal.settledAt).not.toBeNull();
    expect(body.deal.fundedAt).not.toBeNull();
  });

  it(
    "returns a cancelled deal's status honestly, without claiming a storage-derived flag " +
      "(seeded state: a real cancel() cannot complete inside a test run, see " +
      "docs/phase4-step4-lifecycle-and-decision.md; real event-ingestion coverage for cancelled " +
      "is poll.test.ts's job)",
    async () => {
      await insertDeal({ contractId: INSTANCE_2, status: "cancelled", farmer: FARMER_2, buyer: BUYER_2 });

      const res = await fetch(`${baseUrl}/api/deals/${INSTANCE_2}`);
      const body = (await res.json()) as { deal: { status: string; cancelledAt: string | null } };
      expect(body.deal.status).toBe("cancelled");
      expect(body.deal.cancelledAt).not.toBeNull();
    },
  );

  it("returns 404, not a fabricated deal, for a real but unregistered contract id", async () => {
    const res = await fetch(`${baseUrl}/api/deals/${UNKNOWN_BUT_VALID_CONTRACT}`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it("returns 400, distinct from 404, for a syntactically invalid contract id", async () => {
    const res = await fetch(`${baseUrl}/api/deals/not-a-real-contract-id`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/deals/:contractId -- instance isolation", () => {
  it("never returns another instance's terms for the requested contract id", async () => {
    await insertDeal({ contractId: INSTANCE_1, status: "funded", farmer: FARMER_1, buyer: BUYER_1, registeredAtLedger: 10 });
    await insertDeal({ contractId: INSTANCE_2, status: "settled", farmer: FARMER_2, buyer: BUYER_2, registeredAtLedger: 20 });

    const res1 = await fetch(`${baseUrl}/api/deals/${INSTANCE_1}`);
    const res2 = await fetch(`${baseUrl}/api/deals/${INSTANCE_2}`);
    const body1 = (await res1.json()) as { deal: { farmer: string; status: string } };
    const body2 = (await res2.json()) as { deal: { farmer: string; status: string } };
    expect(body1.deal.farmer).toBe(FARMER_1);
    expect(body1.deal.status).toBe("funded");
    expect(body2.deal.farmer).toBe(FARMER_2);
    expect(body2.deal.status).toBe("settled");
  });
});
