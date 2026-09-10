import { rpc as StellarRpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import { logger } from "./logger.js";
import type { IndexerEnv } from "./env.js";

/**
 * Soroban RPC's documented per-request limits (developers.stellar.org,
 * "getEvents" API reference, confirmed 2026-09-10): "Maximum 5 contract IDs
 * are allowed per request" and "Maximum 5 filters are allowed per request."
 * These are cited, not guessed (see Phase 4 Step 2's implementation
 * report), and isolated here behind small pure functions rather than
 * inlined into pollEvents, so the one place this assumption lives is easy
 * to find and re-verify if the RPC's behavior ever changes.
 */
export const MAX_CONTRACT_IDS_PER_FILTER = 5;
export const MAX_FILTERS_PER_REQUEST = 5;
/** The real ceiling one getEvents call can cover: 5 filters x 5 ids each.
 * Not solved by this step; see the implementation report's "remaining
 * limitations" for what happens once registered instances exceed this. */
export const MAX_CONTRACT_IDS_PER_REQUEST = MAX_CONTRACT_IDS_PER_FILTER * MAX_FILTERS_PER_REQUEST;

/** Pure: splits a flat list of contract ids into chunks no larger than
 * MAX_CONTRACT_IDS_PER_FILTER, so each chunk is safe to use as one
 * EventFilter's contractIds. */
export function chunkContractIds(ids: string[], size = MAX_CONTRACT_IDS_PER_FILTER): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Builds the `filters` array for one getEvents call, spreading contract ids
 * across up to MAX_FILTERS_PER_REQUEST filter objects of up to
 * MAX_CONTRACT_IDS_PER_FILTER ids each (a single getEvents call accepts
 * multiple filter objects, matched as OR), rather than one oversized filter
 * the RPC would reject. If more ids are known than one request can cover,
 * the excess is dropped with a loud warning (never silently truncated) --
 * this is the real, documented ceiling of this step's approach, not solved
 * here, see the implementation report.
 */
export function buildEventFilters(contractIds: string[]): StellarRpc.Api.EventFilter[] {
  const covered = contractIds.slice(0, MAX_CONTRACT_IDS_PER_REQUEST);
  if (contractIds.length > MAX_CONTRACT_IDS_PER_REQUEST) {
    logger.warn("more known contract ids than one getEvents request can cover, some will not be polled", {
      known: contractIds.length,
      covered: covered.length,
      limit: MAX_CONTRACT_IDS_PER_REQUEST,
    });
  }
  return chunkContractIds(covered).map((contractIds) => ({ type: "contract" as const, contractIds }));
}

/** Every contract id this indexer currently knows about for PriceFloor,
 * regardless of lifecycle status: registered-but-uninitialized instances
 * must still be polled, since their Initialized event is exactly what
 * moves them forward. */
export async function loadKnownInstanceIds(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ contract_id: string }>(`SELECT contract_id FROM pricefloor_instances`);
  return result.rows.map((row) => row.contract_id);
}

/** True for the fixed legacy instance or any instance this indexer has
 * already registered -- the set of contract ids an Initialized/Funded/
 * Settled/Cancelled event is allowed to update pricefloor_instances for.
 * Never true for an arbitrary contract id merely because it emitted an
 * event shaped like one of these: getEvents' own contractIds filter
 * already guarantees every event handleEvent sees came from a contract id
 * this function would also recognize, but this is checked again here
 * explicitly rather than assumed, the same defense-in-depth discipline the
 * rest of this codebase already applies (see dealState.ts's PARTY_SIGNED
 * comment for the same pattern on the frontend). */
export async function isKnownPriceFloorInstance(
  pool: Pool,
  contractId: string,
  legacyContractId: string | undefined,
): Promise<boolean> {
  if (contractId === legacyContractId) return true;
  const result = await pool.query(`SELECT 1 FROM pricefloor_instances WHERE contract_id = $1`, [contractId]);
  return (result.rowCount ?? 0) > 0;
}

export type RegisterResult =
  | { outcome: "registered" }
  | { outcome: "already-registered" }
  | { outcome: "refused"; reason: string };

/**
 * Verifies a client-submitted contract id independently over RPC before
 * ever persisting it, never trusting the claim alone (Phase 4 architecture
 * doc, "what must never be reconstructed from client-local state"): confirms
 * the contract exists and was deployed from the configured
 * PRICEFLOOR_WASM_HASH. Only on a successful match does a 'registered' row
 * get written. Idempotent: registering an already-known contract id is a
 * no-op, not an error, so a frontend can safely call this again after a
 * network retry.
 */
export async function registerInstance(env: IndexerEnv, pool: Pool, contractId: string): Promise<RegisterResult> {
  if (!StrKey.isValidContract(contractId)) {
    return { outcome: "refused", reason: "not a valid Soroban contract id" };
  }
  if (!env.pricefloorWasmHash) {
    return { outcome: "refused", reason: "PRICEFLOOR_WASM_HASH is not configured on this indexer" };
  }

  const existing = await pool.query(`SELECT 1 FROM pricefloor_instances WHERE contract_id = $1`, [contractId]);
  if ((existing.rowCount ?? 0) > 0) {
    return { outcome: "already-registered" };
  }

  const server = new StellarRpc.Server(env.rpcUrl);

  let instance: Awaited<ReturnType<typeof server.getContractInstance>>;
  try {
    instance = await server.getContractInstance(contractId);
  } catch (err) {
    logger.warn("registerInstance: contract instance lookup failed", { contractId, error: String(err) });
    return { outcome: "refused", reason: "contract instance could not be read from the network" };
  }

  if (instance.executable.type !== "contractExecutableWasm") {
    return { outcome: "refused", reason: "contract is not a Wasm-executable instance" };
  }
  // Hash's declared XDR encoding is hex (see @stellar/stellar-sdk's
  // xdr/values/hash.js), so toString() already yields the lowercase hex
  // string PRICEFLOOR_WASM_HASH is configured as, no manual encoding here.
  const wasmHash = instance.executable.wasmHash.toString();
  if (wasmHash !== env.pricefloorWasmHash) {
    logger.warn("registerInstance: wasm hash mismatch, refusing to register", {
      contractId,
      expected: env.pricefloorWasmHash,
      actual: wasmHash,
    });
    return { outcome: "refused", reason: "contract was not deployed from the configured PriceFloor WASM hash" };
  }

  const latestLedger = await server.getLatestLedger();
  await pool.query(
    `INSERT INTO pricefloor_instances (contract_id, status, registered_at_ledger)
     VALUES ($1, 'registered', $2)
     ON CONFLICT (contract_id) DO NOTHING`,
    [contractId, latestLedger.sequence],
  );
  logger.info("registered pricefloor instance", { contractId, ledger: latestLedger.sequence });
  return { outcome: "registered" };
}

export interface InstanceStorageFields {
  settlementToken: string | null;
  oracleContractId: string | null;
}

/**
 * Pure: decodes SettlementToken/Oracle out of a ContractInstance's raw
 * storage entries. Neither field is present in AgriPriceFloor's
 * Initialized event (see docs/phase4-pricefloor-deal-registry.md's Q13),
 * so this reads them from the same instance-storage the contract itself
 * keeps -- not fabricated, and not guessed: the exact encoding used below
 * (a fieldless enum variant like `DataKey::Oracle` becomes
 * `ScVal::Vec([ScVal::Symbol("Oracle")])`) was empirically confirmed
 * against a real deployed AgriPriceFloor instance during this step (see
 * the implementation report), not assumed from soroban-sdk's general
 * derive-macro conventions alone. An entry whose key doesn't match this
 * exact shape is skipped, never partially trusted.
 */
export function readInstanceStorageFields(storage: readonly xdr.ScMapEntry[] | null | undefined): InstanceStorageFields {
  const fields: InstanceStorageFields = { settlementToken: null, oracleContractId: null };
  for (const entry of storage ?? []) {
    const decodedKey = scValToNative(entry.key);
    const name = Array.isArray(decodedKey) ? decodedKey[0] : decodedKey;
    if (name !== "Oracle" && name !== "SettlementToken") continue;
    const decodedValue = scValToNative(entry.val);
    if (typeof decodedValue !== "string") continue;
    if (name === "Oracle") fields.oracleContractId = decodedValue;
    else fields.settlementToken = decodedValue;
  }
  return fields;
}

/**
 * Reads and persists settlement_token/oracle_contract_id for one instance,
 * skipped by handleEvent itself (which stays RPC-free and offline-testable,
 * see poll.test.ts) and instead run as a deliberate, separate enrichment
 * pass by pollEvents, only for instances that are past 'registered' and
 * still missing these fields. Never overwrites an already-populated value
 * (COALESCE), and never writes a partial/guessed value: a lookup failure
 * just leaves the fields NULL for the next poll to retry.
 */
export async function enrichInstanceStorage(env: IndexerEnv, pool: Pool, contractId: string): Promise<void> {
  const server = new StellarRpc.Server(env.rpcUrl);
  let instance: Awaited<ReturnType<typeof server.getContractInstance>>;
  try {
    instance = await server.getContractInstance(contractId);
  } catch (err) {
    logger.warn("enrichInstanceStorage: contract instance lookup failed", { contractId, error: String(err) });
    return;
  }
  const fields = readInstanceStorageFields(instance.storage);
  if (!fields.settlementToken && !fields.oracleContractId) return;
  await pool.query(
    `UPDATE pricefloor_instances
     SET settlement_token = coalesce(settlement_token, $2), oracle_contract_id = coalesce(oracle_contract_id, $3)
     WHERE contract_id = $1`,
    [contractId, fields.settlementToken, fields.oracleContractId],
  );
}

/** Contract ids whose settlement_token/oracle are still unestablished but
 * that are past 'registered' (so Initialized has already been seen, and
 * the instance storage is worth reading). */
export async function loadInstancesNeedingEnrichment(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ contract_id: string }>(
    `SELECT contract_id FROM pricefloor_instances
     WHERE status != 'registered' AND (settlement_token IS NULL OR oracle_contract_id IS NULL)`,
  );
  return result.rows.map((row) => row.contract_id);
}

/** Contract ids registered but never yet seen initialized by the main
 * cursor-based poll -- see loadStillRegisteredIds's caller in pollEvents
 * for why this exists: the shared events cursor only ever moves forward,
 * so an instance registered *after* its own real Initialized event already
 * happened (the common case: a deal is deployed, initialized, and only
 * later registered) would otherwise never be caught by the main loop at
 * all, since that past ledger range is behind the cursor by the time the
 * instance is known. */
export async function loadStillRegisteredIds(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ contract_id: string }>(
    `SELECT contract_id FROM pricefloor_instances WHERE status = 'registered'`,
  );
  return result.rows.map((row) => row.contract_id);
}
