import { Networks, rpc as StellarRpc, scValToNative } from "@stellar/stellar-sdk";
import { assetSymbol, oracle } from "@agrifeed/sdk";
import type { Pool } from "pg";
import { logger } from "./logger.js";
import { asBigInt, asString, pick, toRecord } from "./native.js";
import type { IndexerEnv } from "./env.js";
import {
  buildEventFilters,
  enrichInstanceStorage,
  isKnownPriceFloorInstance,
  loadInstancesNeedingEnrichment,
  loadKnownInstanceIds,
  loadStillRegisteredIds,
} from "./instances.js";

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
 * The shared events cursor (loadStartLedger/saveCursor above) only ever
 * moves forward, so it is the wrong tool for a newly *registered* instance:
 * the common real case is registering a deal that was already deployed
 * (and often already initialized) some time before registration, whose
 * real events sit at an earlier ledger than wherever the shared cursor
 * already is by the time the instance becomes known. Confirmed live during
 * Phase 4 Step 2: two real instances, deployed/initialized ~20 minutes
 * before being registered, were invisible to the next several ticks of the
 * main cursor-based poll for exactly this reason, see that step's
 * implementation report.
 *
 * This runs a separate, one-off getEvents call scoped to a single
 * still-'registered' contract id, using the same FRESH_CURSOR_LOOKBACK_LEDGERS
 * window loadStartLedger already relies on for a brand-new cursor, so it
 * shares that same empirically-confirmed retention boundary rather than a
 * second, independently guessed one. Never touches indexer_cursor: this is
 * strictly additive catch-up for one contract, not a replacement for the
 * main poll's own cursor continuity.
 */
async function backfillRegisteredInstance(
  env: IndexerEnv,
  pool: Pool,
  server: StellarRpc.Server,
  contractId: string,
): Promise<void> {
  const health = await server.getHealth();
  const startLedger = Math.max(health.oldestLedger, health.latestLedger - FRESH_CURSOR_LOOKBACK_LEDGERS);

  const response = await server.getEvents({
    filters: [{ type: "contract", contractIds: [contractId] }],
    startLedger,
    limit: EVENTS_PAGE_LIMIT,
  });

  for (const event of response.events) {
    try {
      await handleEvent(event, pool, env);
    } catch (err) {
      logger.warn("failed to index backfilled event, skipping", { contractId, txHash: event.txHash, error: String(err) });
    }
  }
  logger.info("backfilled registered instance", { contractId, eventsFound: response.events.length, startLedger });
}

/**
 * Reconstructs which nodes actually contributed to the finalization of
 * `symbol` at `ledger`. finalize_price (agrifeed-contract's ingest.rs) folds
 * in every pending submission for the asset and clears them atomically in
 * one transaction, so the contributing set for a given finalization is
 * exactly the distinct nodes that submitted in the ledger range
 * (previous finalization's ledger, this finalization's ledger] — the same
 * window server.ts's /commodities nodesReporting count already uses, just
 * resolved to actual addresses instead of a count. Deterministic and never
 * fabricated: an empty result here means node_submissions genuinely has no
 * matching rows (not yet indexed, or lost history), not "unknown."
 */
async function computeContributingNodes(pool: Pool, symbol: string, ledger: number): Promise<string[]> {
  const previous = await pool.query<{ ledger: string }>(
    `SELECT ledger FROM price_finalizations WHERE symbol = $1 AND ledger < $2 ORDER BY ledger DESC LIMIT 1`,
    [symbol, ledger],
  );
  const previousLedger = previous.rows[0] ? Number(previous.rows[0].ledger) : 0;

  const contributors = await pool.query<{ node_address: string }>(
    `SELECT DISTINCT node_address FROM node_submissions
     WHERE symbol = $1 AND ledger > $2 AND ledger <= $3
     ORDER BY node_address`,
    [symbol, previousLedger, ledger],
  );
  return contributors.rows.map((row) => row.node_address);
}

/**
 * One-time repair for price_finalizations rows written before this fix
 * existed, when poll.ts hardcoded contributing_nodes as []. Recomputes them
 * with the same windowing computeContributingNodes uses for new events, from
 * node_submissions data that was never lost, so this is real reconstruction,
 * not fabrication. Only touches rows still empty, so it is safe to run on
 * every indexer startup: already-backfilled or genuinely-empty rows are
 * left untouched.
 */
export async function backfillContributingNodes(pool: Pool): Promise<void> {
  const stale = await pool.query<{ id: number; symbol: string; ledger: string }>(
    `SELECT id, symbol, ledger FROM price_finalizations WHERE contributing_nodes = '{}' ORDER BY symbol, ledger ASC`,
  );
  for (const row of stale.rows) {
    const ledger = Number(row.ledger);
    const contributingNodes = await computeContributingNodes(pool, row.symbol, ledger);
    if (contributingNodes.length === 0) continue;
    await pool.query(`UPDATE price_finalizations SET contributing_nodes = $2 WHERE id = $1`, [
      row.id,
      contributingNodes,
    ]);
    logger.info("backfilled contributing_nodes", { symbol: row.symbol, ledger, count: contributingNodes.length });
  }
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
// Watches ORACLE_CONTRACT_ID, the fixed legacy PRICEFLOOR_CONTRACT_ID, and
// every PriceFloor instance registered in pricefloor_instances (Phase 4,
// see docs/phase4-pricefloor-deal-registry.md and instances.ts) -- not just
// one configured id. The known-instance set is re-read from the database
// on every tick, so a newly registered instance starts being polled on the
// very next call, no restart required.
export async function pollEvents(env: IndexerEnv, pool: Pool): Promise<void> {
  const knownInstanceIds = await loadKnownInstanceIds(pool);
  const contractIds = [env.oracleContractId, env.pricefloorContractId, ...knownInstanceIds].filter(
    (id): id is string => Boolean(id),
  );
  if (contractIds.length === 0) {
    logger.warn("no contract ids configured, skipping event poll");
    return;
  }

  const server = new StellarRpc.Server(env.rpcUrl);
  const { startLedger, cursor } = await loadStartLedger(server, pool);
  const filters = buildEventFilters(contractIds);

  const response = await server.getEvents(
    cursor
      ? { filters, cursor, limit: EVENTS_PAGE_LIMIT }
      : {
          filters,
          startLedger: startLedger!,
          limit: EVENTS_PAGE_LIMIT,
        },
  );

  for (const event of response.events) {
    try {
      await handleEvent(event, pool, env);
    } catch (err) {
      logger.warn("failed to index event, skipping", {
        txHash: event.txHash,
        error: String(err),
      });
    }
  }

  await saveCursor(pool, response.cursor);
  logger.info("polled events", { count: response.events.length, cursor: response.cursor });

  // Catch up any instance the main cursor-based poll above could never see
  // (see backfillRegisteredInstance's own doc comment for why this is
  // necessary, not merely defensive). Includes the fixed legacy instance
  // whenever it has no pricefloor_instances row yet: it is recognized by
  // env.pricefloorContractId alone (never goes through registerInstance),
  // so it would otherwise never get this same catch-up, and "keep the
  // existing fixed legacy instance queryable" requires it too.
  const stillRegistered = await loadStillRegisteredIds(pool);
  const legacyNeedsBackfill =
    env.pricefloorContractId && !(await isKnownPriceFloorInstance(pool, env.pricefloorContractId, undefined));
  const toBackfill = legacyNeedsBackfill ? [...stillRegistered, env.pricefloorContractId!] : stillRegistered;
  for (const contractId of toBackfill) {
    try {
      await backfillRegisteredInstance(env, pool, server, contractId);
    } catch (err) {
      logger.warn("failed to backfill registered instance", { contractId, error: String(err) });
    }
  }

  // settlement_token/oracle aren't in the Initialized event (see Q13 of
  // docs/phase4-pricefloor-deal-registry.md), so instances that just moved
  // past 'registered' still need a direct instance-storage read to fill
  // them in. Deliberately after, and separate from, the event loop above:
  // handleEvent stays RPC-free and offline-testable (see poll.test.ts),
  // and a lookup failure here never blocks event ingestion, only leaves
  // these two fields NULL for the next tick to retry.
  const needsEnrichment = await loadInstancesNeedingEnrichment(pool);
  for (const contractId of needsEnrichment) {
    await enrichInstanceStorage(env, pool, contractId);
  }
}

export async function handleEvent(
  event: StellarRpc.Api.EventResponse,
  pool: Pool,
  env: Pick<IndexerEnv, "oracleContractId" | "pricefloorContractId">,
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
      // PriceFinalized carries only {asset, price, timestamp}; agrifeed-contract
      // emits no contributor list on this event, so contributing_nodes is
      // reconstructed here from node_submissions instead (see
      // computeContributingNodes), not read off the event.
      const contributingNodes = await computeContributingNodes(pool, symbol, event.ledger);
      await pool.query(
        `INSERT INTO price_finalizations (symbol, price, price_timestamp, ledger, tx_hash, contributing_nodes)
         VALUES ($1, $2, to_timestamp($3), $4, $5, $6)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [symbol, price, Number(timestamp), event.ledger, event.txHash, contributingNodes],
      );
      return;
    }

    // threshold_updated/retention_updated/commodity_added have no getter on
    // the SEP-40 read interface (base/decimals/resolution/assets/price(s)/
    // lastprice expose none of this), and only the oracle contract emits
    // them, so they always route to oracle_events, keyed by the real
    // #[topic] field each event struct declares (agrifeed-oracle's lib.rs):
    // ThresholdUpdated{threshold: u32}, RetentionUpdated{retention: u32},
    // CommodityAdded{asset: Asset}. None of these three carry non-topic
    // fields, so `body`/`value` is always empty for them; the topic itself
    // is the payload.
    case "threshold_updated": {
      if (!event.contractId) return;
      const threshold = asBigInt(topics[1]);
      if (threshold === null) {
        logger.warn("unrecognized threshold_updated event shape", { txHash: event.txHash });
        return;
      }
      await pool.query(
        `INSERT INTO oracle_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, 'threshold_updated', $2, $3, $4)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [event.contractId.contractId(), event.ledger, event.txHash, JSON.stringify({ threshold: threshold.toString() })],
      );
      return;
    }

    case "retention_updated": {
      if (!event.contractId) return;
      const retention = asBigInt(topics[1]);
      if (retention === null) {
        logger.warn("unrecognized retention_updated event shape", { txHash: event.txHash });
        return;
      }
      await pool.query(
        `INSERT INTO oracle_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, 'retention_updated', $2, $3, $4)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [event.contractId.contractId(), event.ledger, event.txHash, JSON.stringify({ retention: retention.toString() })],
      );
      return;
    }

    case "commodity_added": {
      if (!event.contractId) return;
      const assetTopic = topics[1];
      const symbol = Array.isArray(assetTopic) ? asString(assetTopic[1]) : null;
      if (!symbol) {
        logger.warn("unrecognized commodity_added event shape", { txHash: event.txHash });
        return;
      }
      await pool.query(
        `INSERT INTO oracle_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, 'commodity_added', $2, $3, $4)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [event.contractId.contractId(), event.ledger, event.txHash, JSON.stringify({ symbol })],
      );
      return;
    }

    // Same bug as node_added/price_submitted/price_finalized above: these
    // cases matched the contract's function names instead of the real
    // snake_case event names #[contractevent] emits. Confirmed against
    // agripricefloor's actual event structs (agrifeed-contract@b11df10,
    // contracts/agripricefloor/src/lib.rs): Initialized -> "initialized",
    // Funded -> "funded", Settled -> "settled", Cancelled -> "cancelled".
    //
    // "initialized" is ambiguous on its own: agrifeed-oracle's own
    // Contract::initialize publishes an event with the exact same name (see
    // agrifeed-oracle's lib.rs). Matching on fnName alone would let an
    // oracle Initialized event land in pricefloor_events, whose event_type
    // CHECK constraint happens to allow 'initialized' too, so it would not
    // even fail loudly. Disambiguate by contract identity: route by *which*
    // contract actually emitted it, checking it against ORACLE_CONTRACT_ID
    // versus "is this a known PriceFloor instance" (Phase 4: the fixed
    // legacy contract, or a row already in pricefloor_instances), not by
    // the event's name alone.
    case "initialized": {
      if (!event.contractId) return;
      const contractId = event.contractId.contractId();
      const data = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
      if (contractId === env.oracleContractId) {
        await pool.query(
          `INSERT INTO oracle_events (contract_id, event_type, ledger, tx_hash, data)
           VALUES ($1, 'initialized', $2, $3, $4)
           ON CONFLICT (tx_hash, event_type) DO NOTHING`,
          [contractId, event.ledger, event.txHash, data],
        );
        return;
      }
      if (!(await isKnownPriceFloorInstance(pool, contractId, env.pricefloorContractId))) {
        logger.warn("initialized event from unrecognized contract, skipping", { contractId, txHash: event.txHash });
        return;
      }
      await pool.query(
        `INSERT INTO pricefloor_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, 'initialized', $2, $3, $4)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [contractId, event.ledger, event.txHash, data],
      );

      // Only farmer/buyer/commodity/floor_price/notional/maturity_ts come
      // from this event: settlement_token and oracle_contract_id are left
      // untouched here (still NULL for a brand-new row) since neither is
      // in the Initialized event at all. They are filled in separately, by
      // enrichInstanceStorage's direct instance-storage read, called from
      // pollEvents after this event loop, never guessed here. ON CONFLICT
      // ... DO UPDATE both upserts a fresh row for an instance registered
      // via the new flow (moving 'registered' -> 'initialized') and
      // creates one for the fixed legacy instance the first time its own
      // Initialized event is (re)observed, so it stays queryable through
      // the same table without special-casing it.
      const farmer = asString(topics[1]);
      const buyer = asString(topics[2]);
      const floorPrice = asBigInt(pick(body, "floor_price"));
      const notional = asBigInt(pick(body, "notional"));
      const maturityTs = asBigInt(pick(body, "maturity_ts"));
      const commodity = pick(body, "commodity");
      if (!farmer || !buyer || floorPrice === null || notional === null || maturityTs === null) {
        logger.warn("unrecognized pricefloor initialized event shape, instance status not updated", {
          contractId,
          txHash: event.txHash,
        });
        return;
      }
      await pool.query(
        `INSERT INTO pricefloor_instances
           (contract_id, status, farmer, buyer, commodity, floor_price, notional, maturity_ts, registered_at_ledger, initialized_at)
         VALUES ($1, 'initialized', $2, $3, $4, $5, $6, to_timestamp($7), $8, $9)
         ON CONFLICT (contract_id) DO UPDATE SET
           status = 'initialized', farmer = $2, buyer = $3, commodity = $4,
           floor_price = $5, notional = $6, maturity_ts = to_timestamp($7), initialized_at = $9`,
        [
          contractId,
          farmer,
          buyer,
          JSON.stringify(commodity),
          floorPrice.toString(),
          notional.toString(),
          Number(maturityTs),
          event.ledger,
          ledgerTime.toISOString(),
        ],
      );
      return;
    }

    case "funded":
    case "settled":
    case "cancelled": {
      if (!event.contractId) return;
      const contractId = event.contractId.contractId();
      await pool.query(
        `INSERT INTO pricefloor_events (contract_id, event_type, ledger, tx_hash, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tx_hash, event_type) DO NOTHING`,
        [
          contractId,
          fnName,
          event.ledger,
          event.txHash,
          JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
        ],
      );

      // Advances pricefloor_instances' status forward from whatever
      // Initialized already wrote. 'cancelled' is set from this event
      // alone (see the schema comment on why: the contract writes no
      // corresponding storage flag), never inferred any other way. If no
      // row exists yet (Funded/Settled/Cancelled observed before this
      // indexer ever saw Initialized for the same instance), this is a
      // no-op rather than fabricating one from partial data.
      const column = fnName === "funded" ? "funded_at" : fnName === "settled" ? "settled_at" : "cancelled_at";
      await pool.query(
        `UPDATE pricefloor_instances SET status = $2, ${column} = $3 WHERE contract_id = $1`,
        [contractId, fnName, ledgerTime.toISOString()],
      );
      return;
    }

    default:
      return;
  }
}
