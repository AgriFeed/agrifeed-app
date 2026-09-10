import { StrKey } from "@stellar/stellar-sdk";
import type { Pool } from "pg";

/**
 * The canonical Deal API (Phase 4 Step 5), built directly on the
 * pricefloor_instances registry (Phase 4 Step 2) with no new storage and
 * no new on-chain contract. contract_id is the canonical deal identity,
 * exactly as the registry's own schema comment already states -- this
 * module adds nothing new to that model, only a stable, validated,
 * allowlisted read surface over it for future frontend recovery / "My
 * Deals" use, per docs/phase4-step5-deals-api.md.
 *
 * Field-by-field source of truth (also documented in that doc, kept here
 * too since this is the one place the allowlist itself lives):
 * - status: indexed lifecycle state, advanced forward only by observed
 *   events (poll.ts's handleEvent). 'cancelled' in particular comes from
 *   the Cancelled event alone -- the contract writes no corresponding
 *   storage flag (see docs/phase4-step4-lifecycle-and-decision.md's
 *   refined finding on this) -- so this API never re-derives it from a
 *   storage snapshot and never will.
 * - farmer/buyer/commodity/floorPrice/notional/maturityTs: from the
 *   Initialized event's own payload, null until observed.
 * - settlementToken/oracleContractId: not present in any PriceFloor
 *   event; read separately from the contract's own instance storage by
 *   instances.ts's enrichInstanceStorage, null until that read succeeds.
 * - registeredAt/registeredAtLedger: when this indexer's own
 *   registerInstance() verified and persisted the row, RPC-derived, not
 *   an on-chain event.
 * - initializedAt/fundedAt/settledAt/cancelledAt: the ledger-close time of
 *   the transaction that produced each respective event, null until that
 *   event is observed.
 */
export interface DealRow {
  contract_id: string;
  status: string;
  farmer: string | null;
  buyer: string | null;
  commodity: unknown | null;
  floor_price: string | null;
  notional: string | null;
  settlement_token: string | null;
  maturity_ts: string | null;
  oracle_contract_id: string | null;
  registered_at: string;
  registered_at_ledger: string;
  initialized_at: string | null;
  funded_at: string | null;
  settled_at: string | null;
  cancelled_at: string | null;
}

export interface Deal {
  contractId: string;
  status: string;
  farmer: string | null;
  buyer: string | null;
  commodity: unknown | null;
  floorPrice: string | null;
  notional: string | null;
  settlementToken: string | null;
  maturityTs: string | null;
  oracleContractId: string | null;
  registeredAt: string;
  registeredAtLedger: number;
  initializedAt: string | null;
  fundedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
}

/** Explicit allowlist, never `...row`: this is what stands between an
 * internal database row (which could grow columns this API never meant to
 * expose) and the public response, per this step's own "no accidental
 * disclosure of internal fields" requirement. */
export function serializeDeal(row: DealRow): Deal {
  return {
    contractId: row.contract_id,
    status: row.status,
    farmer: row.farmer,
    buyer: row.buyer,
    commodity: row.commodity,
    floorPrice: row.floor_price,
    notional: row.notional,
    settlementToken: row.settlement_token,
    maturityTs: row.maturity_ts,
    oracleContractId: row.oracle_contract_id,
    registeredAt: row.registered_at,
    registeredAtLedger: Number(row.registered_at_ledger),
    initializedAt: row.initialized_at,
    fundedAt: row.funded_at,
    settledAt: row.settled_at,
    cancelledAt: row.cancelled_at,
  };
}

/** Same check NewDealFlow.tsx already uses client-side
 * (apps/web/components/NewDealFlow.tsx) for farmer/buyer input, reused
 * here rather than reinvented: a Stellar account address (G...), not a
 * contract id (C...). */
export function isValidStellarAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

export const DEFAULT_DEAL_LIST_LIMIT = 50;
export const MAX_DEAL_LIST_LIMIT = 200;

export interface DealListQuery {
  farmer?: string;
  buyer?: string;
  limit: number;
  offset: number;
}

export type ParsedDealListQuery = { ok: true; query: DealListQuery } | { ok: false; error: string };

/**
 * Validates and normalizes GET /api/deals' query parameters. Kept as a
 * pure function, separate from the route handler, so its rules (what
 * counts as a malformed limit/offset, what counts as a malformed address)
 * are independently testable without spinning up the app.
 */
export function parseDealListQuery(raw: Record<string, unknown>): ParsedDealListQuery {
  let farmer: string | undefined;
  let buyer: string | undefined;

  if (raw.farmer !== undefined) {
    if (typeof raw.farmer !== "string" || !isValidStellarAddress(raw.farmer)) {
      return { ok: false, error: "farmer must be a valid Stellar account address" };
    }
    farmer = raw.farmer;
  }
  if (raw.buyer !== undefined) {
    if (typeof raw.buyer !== "string" || !isValidStellarAddress(raw.buyer)) {
      return { ok: false, error: "buyer must be a valid Stellar account address" };
    }
    buyer = raw.buyer;
  }

  let limit = DEFAULT_DEAL_LIST_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "string" || !/^\d+$/.test(raw.limit) || Number(raw.limit) < 1) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    // A client asking for more than the ceiling is clamped, not rejected:
    // it is not a malformed request, just one this API caps the cost of.
    limit = Math.min(Number(raw.limit), MAX_DEAL_LIST_LIMIT);
  }

  let offset = 0;
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "string" || !/^\d+$/.test(raw.offset)) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    offset = Number(raw.offset);
  }

  return { ok: true, query: { farmer, buyer, limit, offset } };
}

/**
 * Lists deals, most recently registered first (registered_at DESC, the
 * same order the pre-existing GET /pricefloor-instances already used),
 * optionally filtered by farmer and/or buyer. Both filters can be given
 * together (an address that is farmer on one deal can be buyer on
 * another; this is an AND, not an OR, matching how a caller would read
 * "deals where I am farmer X and buyer Y" -- a narrower, not broader,
 * query than either filter alone).
 */
export async function listDeals(pool: Pool, query: DealListQuery): Promise<Deal[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.farmer !== undefined) {
    params.push(query.farmer);
    conditions.push(`farmer = $${params.length}`);
  }
  if (query.buyer !== undefined) {
    params.push(query.buyer);
    conditions.push(`buyer = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(query.limit);
  const limitParam = params.length;
  params.push(query.offset);
  const offsetParam = params.length;

  const result = await pool.query<DealRow>(
    `SELECT * FROM pricefloor_instances ${where} ORDER BY registered_at DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
  return result.rows.map(serializeDeal);
}

/** contractId is validated for Soroban contract-id *shape* here (StrKey),
 * distinct from "exists and is a real registered deal": a syntactically
 * invalid id is the caller's mistake (400), a syntactically valid but
 * unregistered/unknown one is a real "no such deal" (404, decided by the
 * route handler based on this returning null). */
export function isValidContractId(contractId: string): boolean {
  return StrKey.isValidContract(contractId);
}

export async function getDealByContractId(pool: Pool, contractId: string): Promise<Deal | null> {
  const result = await pool.query<DealRow>(`SELECT * FROM pricefloor_instances WHERE contract_id = $1`, [contractId]);
  return result.rows[0] ? serializeDeal(result.rows[0]) : null;
}
