import { Networks, rpc as StellarRpc, scValToNative } from "@stellar/stellar-sdk";
import { assetSymbol, oracle } from "@agrifeed/sdk";
import type { Pool } from "pg";
import { logger } from "./logger.js";
import { asBigInt, asString, pick, toRecord } from "./native.js";
import type { IndexerEnv } from "./env.js";

const PRICE_HISTORY_RECORDS = 50;
const EVENTS_PAGE_LIMIT = 100;

/**
 * Refreshes commodities and price_history from the oracle's own read
 * calls (assets/decimals/resolution/lastprice/prices). These match the
 * documented SEP-40 interface exactly, so unlike event decoding below,
 * nothing here is a guess.
 */
export async function pollOracleState(env: IndexerEnv, pool: Pool): Promise<void> {
  if (!env.oracleContractId) {
    logger.warn("ORACLE_CONTRACT_ID not configured, skipping price poll");
    return;
  }

  const config = {
    contractId: env.oracleContractId,
    rpcUrl: env.rpcUrl,
    networkPassphrase: Networks.TESTNET,
  };

  const [decimals, resolution, assets] = await Promise.all([
    oracle.decimals(config),
    oracle.resolution(config),
    oracle.assets(config),
  ]);

  for (const asset of assets) {
    const symbol = assetSymbol(asset);

    await pool.query(
      `INSERT INTO commodities (symbol, decimals, resolution)
       VALUES ($1, $2, $3)
       ON CONFLICT (symbol) DO UPDATE SET decimals = $2, resolution = $3`,
      [symbol, decimals, resolution],
    );

    const records = await oracle.prices(config, asset, PRICE_HISTORY_RECORDS);
    for (const record of records ?? []) {
      await pool.query(
        `INSERT INTO price_history (symbol, price, price_timestamp)
         VALUES ($1, $2, to_timestamp($3))
         ON CONFLICT (symbol, price_timestamp) DO NOTHING`,
        [symbol, record.price, Number(record.timestamp)],
      );
    }

    logger.info("polled oracle price history", { symbol, records: records?.length ?? 0 });
  }
}

interface EventCursorRow {
  last_ledger: string;
}

/**
 * How far back a fresh cursor is allowed to start from. `getHealth()`'s
 * `oldestLedger` reflects ledger/state retention, not this RPC's actual
 * events index: confirmed empirically against soroban-testnet.stellar.org
 * on 2026-09-07 that `getEvents` silently returns zero events (not an
 * error) once `startLedger` is too far behind latest, well before
 * `oldestLedger` and even though matching events exist inside that wider
 * range. Binary search pinned the actual wall between 10,000 (works) and
 * 12,000 (returns nothing) ledgers back; 9,000 leaves margin below that
 * measured boundary. Pick a value here, not `oldestLedger`, for a fresh
 * cursor's starting point.
 */
const FRESH_CURSOR_LOOKBACK_LEDGERS = 9000;

async function loadStartLedger(
  server: StellarRpc.Server,
  pool: Pool,
): Promise<{ startLedger?: number; cursor?: string }> {
  const result = await pool.query<EventCursorRow>(
    `SELECT last_ledger FROM indexer_cursor WHERE id = 'events'`,
  );
  if (result.rows[0]) {
    return { cursor: result.rows[0].last_ledger };
  }
  const health = await server.getHealth();
  const startLedger = Math.max(health.oldestLedger, health.latestLedger - FRESH_CURSOR_LOOKBACK_LEDGERS);
  return { startLedger };
}

async function saveCursor(pool: Pool, cursor: string): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_cursor (id, last_ledger) VALUES ('events', $1)
     ON CONFLICT (id) DO UPDATE SET last_ledger = $1`,
    [cursor],
  );
}

/**
 * Best-effort event indexing for data the oracle's read interface has no
 * getter for: the authorized node set and which nodes contributed to each
 * finalized price. This follows the common Soroban convention of a
 * contract publishing `env.events().publish((symbol_short!("fn_name"),), payload)`
 * per state-changing call, decoding topic[0] as the function name. Since
 * agrifeed-contract's actual event payload shapes are not available to
 * this repo, every handler below verifies the decoded shape before
 * writing a row, and skips (logging a warning) rather than guess.
 */
export async function pollEvents(env: IndexerEnv, pool: Pool): Promise<void> {
  const contractIds = [env.oracleContractId, env.pricefloorContractId].filter(
    (id): id is string => Boolean(id),
  );
  if (contractIds.length === 0) {
    logger.warn("no contract ids configured, skipping event poll");
    return;
  }

  const server = new StellarRpc.Server(env.rpcUrl);
  const { startLedger, cursor } = await loadStartLedger(server, pool);

  const response = await server.getEvents(
    cursor
      ? { filters: [{ type: "contract", contractIds }], cursor, limit: EVENTS_PAGE_LIMIT }
      : {
          filters: [{ type: "contract", contractIds }],
          startLedger: startLedger!,
          limit: EVENTS_PAGE_LIMIT,
        },
  );

  for (const event of response.events) {
    try {
      await handleEvent(event, pool);
    } catch (err) {
      logger.warn("failed to index event, skipping", {
        txHash: event.txHash,
        error: String(err),
      });
    }
  }

  await saveCursor(pool, response.cursor);
  logger.info("polled events", { count: response.events.length, cursor: response.cursor });
}

async function handleEvent(
  event: StellarRpc.Api.EventResponse,
  pool: Pool,
): Promise<void> {
  // `#[contractevent]` publishes topic[0] as the snake_case event name
  // (from the struct name: NodeAdded -> "node_added", PriceSubmitted ->
  // "price_submitted"), not the function name ("add_node", "submit_price").
  // Confirmed against real events on 2026-09-07; matching on the function
  // name here previously meant these cases never fired at all.
  const topics = event.topic.map((t) => scValToNative(t));
  const fnName = asString(topics[0]);
  if (!fnName) return;

  // Fields declared `#[topic]` on the event struct live in `event.topic`
  // (after the name), in struct declaration order; only the remaining,
  // non-topic fields are in `event.value`. Confirmed against a real
  // PriceSubmitted event: topics = [name, asset, node], value = {price}.
  const value = scValToNative(event.value);
  const body = toRecord(value) ?? {};
  const ledgerTime = new Date(event.ledgerClosedAt);

  switch (fnName) {
    case "node_added":
    case "node_removed": {
      const address = asString(topics[1]);
      if (!address) {
        logger.warn(`unrecognized ${fnName} event shape`, { txHash: event.txHash });
        return;
      }
      if (fnName === "node_added") {
        await pool.query(
          `INSERT INTO nodes (address, added_at, added_at_ledger)
           VALUES ($1, $2, $3)
           ON CONFLICT (address) DO UPDATE SET removed_at = NULL, removed_at_ledger = NULL`,
          [address, ledgerTime.toISOString(), event.ledger],
        );
      } else {
        await pool.query(
          `UPDATE nodes SET removed_at = $2, removed_at_ledger = $3 WHERE address = $1`,
          [address, ledgerTime.toISOString(), event.ledger],
        );
      }
      return;
    }

    case "price_submitted": {
      // topics: [name, asset, node]; value: {price}. PriceSubmitted carries
      // no source_ts (see agrifeed-contract's lib.rs), so the ledger's own
      // close time is used as source_ts here instead.
      const assetTopic = topics[1];
      const symbol = Array.isArray(assetTopic) ? asString(assetTopic[1]) : null;
      const node = asString(topics[2]);
      const price = asBigInt(pick(body, "price"))?.toString() ?? null;
      if (!node || !symbol || !price) {
        logger.warn("unrecognized price_submitted event shape", { txHash: event.txHash });
        return;
      }
      await pool.query(
        `INSERT INTO node_submissions (node_address, symbol, price, source_ts, ledger, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [node, symbol, price, ledgerTime.toISOString(), event.ledger, event.txHash],
      );
      return;
    }

    case "price_finalized": {
      // topics: [name, asset]; value: {price, timestamp}.
      const assetTopic = topics[1];
      const symbol = Array.isArray(assetTopic) ? asString(assetTopic[1]) : null;
      const price = asBigInt(pick(body, "price"))?.toString() ?? null;
      const timestamp = asBigInt(pick(body, "timestamp"));
      if (!symbol || !price || timestamp === null) {
        logger.warn("unrecognized price_finalized event shape", { txHash: event.txHash });
        return;
      }
      // PriceFinalized carries only {asset, price, timestamp}, agrifeed-contract
      // emits no contributor list on this event, so contributing_nodes is not
      // derivable here. The API layer (server.ts /commodities) reconstructs it
      // from node_submissions instead; this column is kept only as a record of
      // that limitation, not filled in from the event.
      await pool.query(
        `INSERT INTO price_finalizations (symbol, price, price_timestamp, ledger, tx_hash, contributing_nodes)
         VALUES ($1, $2, to_timestamp($3), $4, $5, $6)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [symbol, price, Number(timestamp), event.ledger, event.txHash, []],
      );
      return;
    }

    // Same bug as node_added/price_submitted/price_finalized above: these
    // cases matched the contract's function names instead of the real
    // snake_case event names #[contractevent] emits. Confirmed against
    // agripricefloor's actual event structs (agrifeed-contract@b11df10,
    // contracts/agripricefloor/src/lib.rs): Initialized -> "initialized",
    // Funded -> "funded", Settled -> "settled", Cancelled -> "cancelled".
    case "initialized":
    case "funded":
    case "settled":
    case "cancelled": {
      if (!event.contractId) return;
      await pool.query(
        `INSERT INTO pricefloor_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [
          event.contractId.contractId(),
          fnName,
          event.ledger,
          event.txHash,
          JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
        ],
      );
      return;
    }

    default:
      return;
  }
}
