-- AgriFeed indexer schema. Every statement is idempotent so migrate.ts can
-- be run repeatedly against a fresh or existing database.

CREATE TABLE IF NOT EXISTS commodities (
  symbol TEXT PRIMARY KEY,
  decimals INTEGER NOT NULL,
  resolution INTEGER NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per on-chain price record returned by prices()/lastprice(). The
-- contract price is an i128, so it is stored as TEXT and never cast to a
-- Postgres numeric/double type that could silently lose precision.
CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL REFERENCES commodities(symbol),
  price TEXT NOT NULL,
  price_timestamp TIMESTAMPTZ NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, price_timestamp)
);

CREATE INDEX IF NOT EXISTS price_history_symbol_ts_idx
  ON price_history (symbol, price_timestamp DESC);

-- Authorized oracle nodes, reconstructed from add_node / remove_node calls.
-- This table is only ever populated by real on-chain events; it starts
-- empty and stays empty until the oracle contract is deployed and
-- ORACLE_CONTRACT_ID is configured.
CREATE TABLE IF NOT EXISTS nodes (
  address TEXT PRIMARY KEY,
  added_at TIMESTAMPTZ NOT NULL,
  added_at_ledger BIGINT NOT NULL,
  removed_at TIMESTAMPTZ,
  removed_at_ledger BIGINT
);

-- One row per submit_price call attributed to a node, used to compute each
-- node's submission count and uptime on the /nodes page.
CREATE TABLE IF NOT EXISTS node_submissions (
  id BIGSERIAL PRIMARY KEY,
  node_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price TEXT NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash)
);

CREATE INDEX IF NOT EXISTS node_submissions_node_idx
  ON node_submissions (node_address, source_ts DESC);
CREATE INDEX IF NOT EXISTS node_submissions_symbol_idx
  ON node_submissions (symbol, source_ts DESC);

-- One row per finalize_price call: which node submissions fed into a given
-- finalized price, so /commodity/[symbol] can show exactly which nodes
-- contributed, never just a count. contributing_nodes is populated by
-- poll.ts at insert time, reconstructed from node_submissions (see
-- computeContributingNodes in poll.ts), not from the PriceFinalized event
-- itself: the contract emits no contributor list on that event.
CREATE TABLE IF NOT EXISTS price_finalizations (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  price TEXT NOT NULL,
  price_timestamp TIMESTAMPTZ NOT NULL,
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  contributing_nodes TEXT[] NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash)
);

-- AgriPriceFloor has no on-chain getter for its own state (see
-- packages/sdk/src/pricefloor.ts getState), so the indexer is the only
-- place that reconstructs it, from initialized/funded/settled/cancelled
-- events (the real event names #[contractevent] emits, not the contract's
-- function names).
--
-- Oracle's own Initialized event shares that same "initialized" name, but
-- it is never written here: poll.ts disambiguates by matching
-- event.contractId against ORACLE_CONTRACT_ID versus "is this a known
-- PriceFloor instance" (the fixed legacy PRICEFLOOR_CONTRACT_ID, or a row
-- in pricefloor_instances below, see Phase 4) before routing, so only a
-- genuine PriceFloor Initialized event lands in this table (see
-- oracle_events below for the oracle's own). contract_id is kept per row
-- here (not assumed to be one global instance) precisely so multiple
-- independent PriceFloor deployments can never have their events confused
-- with each other: every row already carries which specific instance
-- emitted it.
CREATE TABLE IF NOT EXISTS pricefloor_events (
  id BIGSERIAL PRIMARY KEY,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('initialized', 'funded', 'settled', 'cancelled')),
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, event_type)
);

-- CREATE TABLE IF NOT EXISTS above never touches an already-existing
-- table's constraints, so a database that had this table created before
-- the F-07 fix (which corrected event_type's allowed values from the
-- contract's function names -- 'initialize'/'fund'/'settle'/'cancel' -- to
-- the real #[contractevent] names) silently kept the OLD, wrong constraint
-- forever: every real pricefloor_events insert on such a database has been
-- failing its CHECK and getting swallowed by pollEvents' per-event
-- try/catch ever since, with no further symptom than an empty table.
-- Confirmed live against this project's own long-running `agrifeed`
-- database during Phase 4 Step 2's real E2E verification (see that step's
-- implementation report) -- not hypothetical. DROP + ADD unconditionally,
-- every migrate() run, so this table's constraint always converges to
-- whatever this file currently says, regardless of when the table was
-- first created.
ALTER TABLE pricefloor_events DROP CONSTRAINT IF EXISTS pricefloor_events_event_type_check;
ALTER TABLE pricefloor_events ADD CONSTRAINT pricefloor_events_event_type_check
  CHECK (event_type IN ('initialized', 'funded', 'settled', 'cancelled'));

-- Oracle admin/config-change events with no dedicated getter on the SEP-40
-- read interface (base/decimals/resolution/assets/price/prices/lastprice
-- expose none of threshold, retention, or *when* a commodity/admin was set,
-- only add_commodity's cumulative effect via assets()). A separate table
-- from pricefloor_events, not just a distinguishing column, so that an
-- oracle-emitted "initialized" (Contract::initialize's own event) can never
-- land among PriceFloor's initialized/funded/settled/cancelled rows purely
-- because both contracts happen to name an event the same thing.
CREATE TABLE IF NOT EXISTS oracle_events (
  id BIGSERIAL PRIMARY KEY,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('initialized', 'threshold_updated', 'retention_updated', 'commodity_added')),
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, event_type)
);

-- Cursor bookkeeping so poll.ts resumes getEvents from where it left off
-- instead of re-scanning the whole retention window every tick. Despite the
-- column's name, this is the opaque pagination cursor getEvents() returns
-- (e.g. "0019085056546963455-4294967295"), not a bare ledger sequence
-- number, so it must be TEXT: it does not fit, and is not meant to be
-- parsed as, a BIGINT.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id TEXT PRIMARY KEY,
  last_ledger TEXT NOT NULL
);

-- Registered PriceFloor instances (Phase 4, see
-- docs/phase4-pricefloor-deal-registry.md). A row here means the indexer
-- has independently verified, over RPC (getContractInstance), that this
-- contract id exists and was deployed from PRICEFLOOR_WASM_HASH -- it is
-- never inserted from a client's claim alone (see registerInstance in
-- instances.ts). contract_id is the canonical deal identity: nothing else
-- names a deal.
--
-- farmer/buyer/commodity/floor_price/notional/maturity_ts are filled in
-- once the Initialized event is observed for this contract_id; they are
-- nullable until then, since "registered but not yet initialized" is a
-- real, valid state (a deploy that never got initialized still costs the
-- deployer's account reserve and should stay inspectable rather than
-- silently lost).
--
-- settlement_token and oracle_contract_id are NOT in AgriPriceFloor's
-- Initialized event (confirmed against contracts/agripricefloor/src/lib.rs),
-- so they are filled in separately by instances.ts's enrichInstanceStorage,
-- a direct read of the contract's own instance storage rather than a
-- guess: the exact DataKey XDR encoding it relies on
-- (ScVal::Vec([ScVal::Symbol(variant_name)]) for a fieldless enum variant)
-- was empirically confirmed against a real deployed instance during Phase
-- 4 Step 2 (see that step's implementation report), not assumed. Both stay
-- NULL until that read succeeds, which is an honest "not established yet,"
-- never a fabricated value.
--
-- status mirrors the Deal lifecycle the architecture doc defines.
-- 'cancelled' is derived from the Cancelled event alone (the contract
-- writes no corresponding storage flag, see the architecture doc's Q13/
-- Q14): this column is never recomputed from a storage snapshot, only
-- ever advanced forward by observing the real events in order.
CREATE TABLE IF NOT EXISTS pricefloor_instances (
  contract_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('registered', 'initialized', 'funded', 'settled', 'cancelled')),
  farmer TEXT,
  buyer TEXT,
  commodity JSONB,
  floor_price TEXT,
  notional TEXT,
  settlement_token TEXT,
  maturity_ts TIMESTAMPTZ,
  oracle_contract_id TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at_ledger BIGINT NOT NULL,
  initialized_at TIMESTAMPTZ,
  funded_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pricefloor_instances_farmer_idx ON pricefloor_instances (farmer);
CREATE INDEX IF NOT EXISTS pricefloor_instances_buyer_idx ON pricefloor_instances (buyer);
CREATE INDEX IF NOT EXISTS pricefloor_instances_status_idx ON pricefloor_instances (status);
