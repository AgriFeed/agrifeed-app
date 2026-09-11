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

// The pre-cutover AgriPriceFloor WASM hash (re-confirmed via a fresh
// `stellar contract build --package agripricefloor` during Phase 4 Step 2).
// Kept under its original name since REAL_PRICEFLOOR_INSTANCE below was
// genuinely deployed from it and still is on Testnet; used below to prove
// the cutover's refusal behavior, not as this indexer's current
// configuration (see NEW_PRICEFLOOR_WASM_HASH for that).
const PRICEFLOOR_WASM_HASH = "05faa5704ac6f8fe0d21268b16782315a6573946bc6ab40b8277faf70eb43d53";
const RPC_URL = "https://soroban-testnet.stellar.org";

// Real, live, independently deployed and initialized AgriPriceFloor
// instance (Phase 4 Step 2's own Testnet fixture, see the implementation
// report). Real oracle contract id, real settlement token contract id
// (native XLM's SAC), both already used elsewhere in this project.
const REAL_PRICEFLOOR_INSTANCE = "CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN";
const REAL_ORACLE_CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";
const REAL_SETTLEMENT_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Phase 6 Step 1 (PriceFloor Cancelled-flag WASM cutover): the
// post-Cancelled-flag AgriPriceFloor WASM hash (agrifeed-contract commit
// 9347841), independently rebuilt and sha256-verified this step, and
// matching this indexer's current PRICEFLOOR_WASM_HASH configuration (see
// docs/phase6-step1-pricefloor-wasm-cutover.md). Real, live, deployed and
// initialized instances built from it, used below to prove the cutover
// accepts the new WASM and still decodes the Cancelled diagnostic
// correctly.
const NEW_PRICEFLOOR_WASM_HASH = "5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b";
const NEW_WASM_INSTANCE_STEP6 = "CBNCQWUFRDNH75SFPSWJCXY3NHA7RUM3G6U4N2ITOPXDMHBFMHV63PAF";
const NEW_WASM_INSTANCE_STEP1 = "CDAO5WFFNI4KTRA43BBEIHUE4SKVRPL45DJQ2P7TE7R4NELCLFS7WC7S";

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

describe("registerInstance -- Phase 6 Step 1 WASM cutover (real network, no mocks)", () => {
  const newHashEnv: IndexerEnv = {
    databaseUrl: TEST_DATABASE_URL,
    apiPort: 0,
    rpcUrl: RPC_URL,
    pricefloorWasmHash: NEW_PRICEFLOOR_WASM_HASH,
  };

  it(
    "accepts a real, live instance deployed from the new Cancelled-flag-bearing WASM once configured with its hash",
    async () => {
      const result = await registerInstance(newHashEnv, pool, NEW_WASM_INSTANCE_STEP1);
      expect(result).toEqual({ outcome: "registered" });

      const row = await pool.query(
        `SELECT contract_id, status, registered_at_ledger FROM pricefloor_instances WHERE contract_id = $1`,
        [NEW_WASM_INSTANCE_STEP1],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]?.status).toBe("registered");
      expect(Number(row.rows[0]?.registered_at_ledger)).toBeGreaterThan(0);
    },
    20000,
  );

  it(
    "also accepts the Step 6 verification instance, deployed from the same new WASM",
    async () => {
      const result = await registerInstance(newHashEnv, pool, NEW_WASM_INSTANCE_STEP6);
      expect(result).toEqual({ outcome: "registered" });
    },
    20000,
  );

  it(
    "refuses a real, live instance deployed from the OLD WASM once configured with the NEW hash -- " +
      "the intended, documented hard-cutover behavior for new registrations (see " +
      "docs/phase6-step1-pricefloor-wasm-cutover.md): only already-registered legacy instances remain " +
      "reachable after cutover, a not-yet-registered old-WASM instance is refused going forward",
    async () => {
      const result = await registerInstance(newHashEnv, pool, REAL_PRICEFLOOR_INSTANCE);
      expect(result.outcome).toBe("refused");

      const row = await pool.query(`SELECT 1 FROM pricefloor_instances WHERE contract_id = $1`, [REAL_PRICEFLOOR_INSTANCE]);
      expect(row.rows).toHaveLength(0);
    },
    20000,
  );

  it(
    "a legacy instance already registered before cutover remains registered and readable after cutover " +
      "(registration is never re-validated against the currently configured hash)",
    async () => {
      // Simulates the pre-cutover world: register REAL_PRICEFLOOR_INSTANCE
      // (built from the OLD wasm) while the OLD hash is configured, exactly
      // as production would have done before this step.
      const oldHashEnv: IndexerEnv = { ...newHashEnv, pricefloorWasmHash: PRICEFLOOR_WASM_HASH };
      const beforeCutover = await registerInstance(oldHashEnv, pool, REAL_PRICEFLOOR_INSTANCE);
      expect(beforeCutover).toEqual({ outcome: "registered" });

      // After cutover (newHashEnv), the same already-registered instance is
      // still recognized -- isKnownPriceFloorInstance checks the database,
      // never re-checks the wasm hash.
      expect(await isKnownPriceFloorInstance(pool, REAL_PRICEFLOOR_INSTANCE, undefined)).toBe(true);
      const afterCutover = await registerInstance(newHashEnv, pool, REAL_PRICEFLOOR_INSTANCE);
      expect(afterCutover).toEqual({ outcome: "already-registered" });
    },
    20000,
  );

  it(
    "decodes the Cancelled diagnostic correctly from a real, live instance built from the new WASM " +
      "(absent/false pre-cancel, matching every legacy instance's shape)",
    async () => {
      const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
      const server = new StellarRpc.Server(RPC_URL);
      const instance = await server.getContractInstance(NEW_WASM_INSTANCE_STEP1);
      const fields = readInstanceStorageFields(instance.storage);
      expect(fields.cancelledFlagObserved).toBe(false);
      expect(fields.settlementToken).toBe(REAL_SETTLEMENT_TOKEN);
      expect(fields.oracleContractId).toBe(REAL_ORACLE_CONTRACT_ID);
    },
    20000,
  );
});
