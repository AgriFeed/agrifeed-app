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
-- event.contractId against the configured ORACLE_CONTRACT_ID /
-- PRICEFLOOR_CONTRACT_ID before routing, so only a genuine PriceFloor
-- Initialized event lands in this table (see oracle_events below for the
-- oracle's own).
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
