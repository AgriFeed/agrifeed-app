import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildEventFilters,
  chunkContractIds,
  isKnownPriceFloorInstance,
  loadKnownInstanceIds,
  MAX_CONTRACT_IDS_PER_FILTER,
  MAX_CONTRACT_IDS_PER_REQUEST,
  MAX_FILTERS_PER_REQUEST,
  readInstanceStorageFields,
  registerInstance,
} from "./instances.js";
import type { IndexerEnv } from "./env.js";

const TEST_DATABASE_URL =
  process.env.INDEXER_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable";

// The real, deployed, verified AgriPriceFloor WASM hash for this project
// (re-confirmed via a fresh `stellar contract build --package agripricefloor`
// during Phase 4 Step 2, matches apps/web/.env.local's
// NEXT_PUBLIC_PRICEFLOOR_WASM_HASH). Used to exercise registerInstance's
// real RPC verification against real Testnet contracts below.
const PRICEFLOOR_WASM_HASH = "05faa5704ac6f8fe0d21268b16782315a6573946bc6ab40b8277faf70eb43d53";
const RPC_URL = "https://soroban-testnet.stellar.org";

// Real, live, independently deployed and initialized AgriPriceFloor
// instance (Phase 4 Step 2's own Testnet fixture, see the implementation
// report). Real oracle contract id, real settlement token contract id
// (native XLM's SAC), both already used elsewhere in this project.
const REAL_PRICEFLOOR_INSTANCE = "CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN";
const REAL_ORACLE_CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";
const REAL_SETTLEMENT_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

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
  await pool.query("TRUNCATE pricefloor_instances CASCADE");
});

describe("chunkContractIds (pure)", () => {
  it("splits into chunks no larger than the given size", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const chunks = chunkContractIds(ids, 5);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5);
    expect(chunks[1]).toHaveLength(5);
    expect(chunks[2]).toHaveLength(2);
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns an empty array for no ids", () => {
    expect(chunkContractIds([])).toEqual([]);
  });

  it("returns one chunk when input is already within the limit", () => {
    expect(chunkContractIds(["a", "b"], 5)).toEqual([["a", "b"]]);
  });
});

describe("buildEventFilters (pure) -- isolates the getEvents contractIds limit", () => {
  it("uses documented real limits: 5 contract ids per filter, up to 5 filters", () => {
    // Cited, not guessed: developers.stellar.org's getEvents API reference
    // ("Maximum 5 contract IDs are allowed per request" / "Maximum 5
    // filters are allowed per request"), confirmed during Phase 4 Step 2 --
    // see instances.ts's own doc comment and the implementation report.
    expect(MAX_CONTRACT_IDS_PER_FILTER).toBe(5);
    expect(MAX_FILTERS_PER_REQUEST).toBe(5);
    expect(MAX_CONTRACT_IDS_PER_REQUEST).toBe(25);
  });

  it("spreads ids across multiple filter objects rather than one oversized filter", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `id-${i}`);
    const filters = buildEventFilters(ids);
    expect(filters).toHaveLength(2);
    expect(filters[0]?.contractIds).toHaveLength(5);
    expect(filters[1]?.contractIds).toHaveLength(3);
    expect(filters.every((f) => f.type === "contract")).toBe(true);
  });

  it("covers exactly MAX_CONTRACT_IDS_PER_REQUEST ids without warning", () => {
    const ids = Array.from({ length: MAX_CONTRACT_IDS_PER_REQUEST }, (_, i) => `id-${i}`);
    const filters = buildEventFilters(ids);
    expect(filters.flatMap((f) => f.contractIds ?? [])).toHaveLength(MAX_CONTRACT_IDS_PER_REQUEST);
  });

  it("truncates rather than silently dropping ids when more are known than one request can cover", () => {
    const ids = Array.from({ length: MAX_CONTRACT_IDS_PER_REQUEST + 3 }, (_, i) => `id-${i}`);
    const filters = buildEventFilters(ids);
    const covered = filters.flatMap((f) => f.contractIds ?? []);
    expect(covered).toHaveLength(MAX_CONTRACT_IDS_PER_REQUEST);
    expect(covered).toEqual(ids.slice(0, MAX_CONTRACT_IDS_PER_REQUEST));
  });
});

describe("readInstanceStorageFields (pure) -- empirically-verified DataKey encoding", () => {
  // Builds real xdr.ScMapEntry values matching exactly what
  // getContractInstance() returned for a real, live AgriPriceFloor
  // instance during Phase 4 Step 2 (confirmed by inspecting
  // CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN's real
  // instance storage, see the implementation report): a fieldless DataKey
  // enum variant like `Oracle` or `SettlementToken` encodes as
  // `ScVal::Vec([ScVal::Symbol(variant_name)])`.
  function storageEntry(variantName: string, value: xdr.ScVal): xdr.ScMapEntry {
    return new xdr.ScMapEntry({
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variantName)]),
      val: value,
    });
  }

  it("decodes SettlementToken and Oracle from real-shaped instance storage", () => {
    const storage = [
      storageEntry("Farmer", nativeToScVal("GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62", { type: "address" })),
      storageEntry("Oracle", nativeToScVal(REAL_ORACLE_CONTRACT_ID, { type: "address" })),
      storageEntry("Funded", xdr.ScVal.scvBool(true)),
      storageEntry("SettlementToken", nativeToScVal(REAL_SETTLEMENT_TOKEN, { type: "address" })),
    ];

    const fields = readInstanceStorageFields(storage);
    expect(fields.oracleContractId).toBe(REAL_ORACLE_CONTRACT_ID);
    expect(fields.settlementToken).toBe(REAL_SETTLEMENT_TOKEN);
    expect(fields.cancelledFlagObserved).toBe(false);
  });

  it("returns nulls/false for empty or missing storage rather than guessing", () => {
    expect(readInstanceStorageFields(null)).toEqual({
      settlementToken: null,
      oracleContractId: null,
      cancelledFlagObserved: false,
    });
    expect(readInstanceStorageFields([])).toEqual({
      settlementToken: null,
      oracleContractId: null,
      cancelledFlagObserved: false,
    });
  });

  it("ignores entries that don't match the expected key shape", () => {
    const storage = [storageEntry("Funded", xdr.ScVal.scvBool(false)), storageEntry("Settled", xdr.ScVal.scvBool(false))];
    expect(readInstanceStorageFields(storage)).toEqual({
      settlementToken: null,
      oracleContractId: null,
      cancelledFlagObserved: false,
    });
  });

  // Phase 5 Step 6: DataKey::Cancelled, confirmed against a real instance
  // deployed from the updated wasm (see
  // docs/phase5-step6-cancelled-state.md) to encode the same way every
  // other fieldless DataKey variant already does.
  it("decodes DataKey::Cancelled = true as cancelledFlagObserved", () => {
    const storage = [storageEntry("Cancelled", xdr.ScVal.scvBool(true))];
    expect(readInstanceStorageFields(storage).cancelledFlagObserved).toBe(true);
  });

  it("does not report cancelledFlagObserved for an instance that was never cancelled (key absent)", () => {
    const storage = [
      storageEntry("Farmer", nativeToScVal("GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62", { type: "address" })),
      storageEntry("Funded", xdr.ScVal.scvBool(true)),
    ];
    expect(readInstanceStorageFields(storage).cancelledFlagObserved).toBe(false);
  });
});

describe("loadKnownInstanceIds / isKnownPriceFloorInstance (DB only, no RPC)", () => {
  it("returns every registered contract id regardless of status", async () => {
    await pool.query(
      `INSERT INTO pricefloor_instances (contract_id, status, registered_at_ledger) VALUES
       ('CAAA1111111111111111111111111111111111111111111111AAAA', 'registered', 1),
       ('CBBB2222222222222222222222222222222222222222222222BBBB', 'initialized', 2)`,
    );
    const ids = await loadKnownInstanceIds(pool);
    expect(ids.sort()).toEqual(
      ["CAAA1111111111111111111111111111111111111111111111AAAA", "CBBB2222222222222222222222222222222222222222222222BBBB"].sort(),
    );
  });

  it("recognizes a registered instance and the legacy instance, and nothing else", async () => {
    const legacy = "CDHPDF4TZDJVBFGSOGVTNEKQNNJQR326JSATYXY7ZWD63L6PS2NTJB47";
    await pool.query(
      `INSERT INTO pricefloor_instances (contract_id, status, registered_at_ledger) VALUES ($1, 'registered', 1)`,
      [REAL_PRICEFLOOR_INSTANCE],
    );

    expect(await isKnownPriceFloorInstance(pool, REAL_PRICEFLOOR_INSTANCE, legacy)).toBe(true);
    expect(await isKnownPriceFloorInstance(pool, legacy, legacy)).toBe(true);
    expect(await isKnownPriceFloorInstance(pool, "CUNKNOWN0000000000000000000000000000000000000000000000", legacy)).toBe(false);
  });
});

describe("registerInstance -- live Soroban Testnet RPC verification (real network, no mocks)", () => {
  const env: IndexerEnv = {
    databaseUrl: TEST_DATABASE_URL,
    apiPort: 0,
    rpcUrl: RPC_URL,
    pricefloorWasmHash: PRICEFLOOR_WASM_HASH,
  };

  it("refuses a syntactically invalid contract id without any RPC call", async () => {
    const result = await registerInstance(env, pool, "not-a-contract-id");
    expect(result).toEqual({ outcome: "refused", reason: "not a valid Soroban contract id" });
  });

  it("refuses to register when PRICEFLOOR_WASM_HASH is not configured", async () => {
    const result = await registerInstance({ ...env, pricefloorWasmHash: undefined }, pool, REAL_PRICEFLOOR_INSTANCE);
    expect(result.outcome).toBe("refused");
  });

  it(
    "verifies and registers a real, live, correctly-deployed PriceFloor instance",
    async () => {
      const result = await registerInstance(env, pool, REAL_PRICEFLOOR_INSTANCE);
      expect(result).toEqual({ outcome: "registered" });

      const row = await pool.query(`SELECT contract_id, status, registered_at_ledger FROM pricefloor_instances WHERE contract_id = $1`, [
        REAL_PRICEFLOOR_INSTANCE,
      ]);
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]?.status).toBe("registered");
      expect(Number(row.rows[0]?.registered_at_ledger)).toBeGreaterThan(0);
    },
    20000,
  );

  it(
    "is idempotent: registering the same real instance twice succeeds once and no-ops the second time",
    async () => {
      const first = await registerInstance(env, pool, REAL_PRICEFLOOR_INSTANCE);
      const second = await registerInstance(env, pool, REAL_PRICEFLOOR_INSTANCE);
      expect(first.outcome).toBe("registered");
      expect(second).toEqual({ outcome: "already-registered" });

      const rows = await pool.query(`SELECT * FROM pricefloor_instances WHERE contract_id = $1`, [REAL_PRICEFLOOR_INSTANCE]);
      expect(rows.rows).toHaveLength(1);
    },
    20000,
  );

  it(
    "refuses a real contract that exists but was not deployed from PRICEFLOOR_WASM_HASH (wrong wasm)",
    async () => {
      // The real Oracle contract: exists on Testnet, genuinely readable over
      // RPC, but built from agrifeed-oracle's wasm, not agripricefloor's --
      // exactly the "client claims a contract id that isn't actually a
      // PriceFloor deployment" case registerInstance must catch.
      const result = await registerInstance(env, pool, REAL_ORACLE_CONTRACT_ID);
      expect(result.outcome).toBe("refused");

      const row = await pool.query(`SELECT 1 FROM pricefloor_instances WHERE contract_id = $1`, [REAL_ORACLE_CONTRACT_ID]);
      expect(row.rows).toHaveLength(0);
    },
    20000,
  );
});
