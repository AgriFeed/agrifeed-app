import express from "express";
import type { Pool } from "pg";
import { logger } from "../logger.js";
import type { IndexerEnv } from "../env.js";
import { registerInstance } from "../instances.js";

interface CommodityRow {
  symbol: string;
  decimals: number;
  latest_price: string | null;
  latest_price_timestamp: string | null;
  previous_price: string | null;
  nodes_reporting: number;
}

interface NodeRow {
  address: string;
  added_at: string;
  removed_at: string | null;
  submission_count: string;
  last_submission_at: string | null;
}

interface PriceFloorInstanceRow {
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

/** Every field here has the source-of-truth documented in
 * docs/phase4-pricefloor-deal-registry.md: settlementToken and oracle are
 * always null (never fabricated, see that document's Q13), not omitted, so
 * a caller can see the field exists but isn't established yet rather than
 * inferring its absence means something else. */
function serializePriceFloorInstance(row: PriceFloorInstanceRow) {
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

export function createApp(env: IndexerEnv, pool: Pool): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      oracleConfigured: Boolean(env.oracleContractId),
      pricefloorConfigured: Boolean(env.pricefloorContractId),
    });
  });

  app.get("/commodities", async (_req, res) => {
    const totalNodesResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nodes WHERE removed_at IS NULL`,
    );
    const totalNodes = Number(totalNodesResult.rows[0]?.count ?? 0);

    // PriceFinalized carries only {asset, price, timestamp}, the contract
    // emits no contributor list (see agrifeed-contract's lib.rs), so
    // "which nodes reported" cannot come from price_finalizations. It is
    // reconstructed instead from node_submissions: finalize_price folds in
    // every pending submission since the previous finalize and clears them
    // atomically, so the contributing set for the latest finalization is
    // exactly the distinct nodes that submitted in the ledger range
    // (previous finalization's ledger, latest finalization's ledger].
    const result = await pool.query<CommodityRow>(`
      SELECT
        c.symbol,
        c.decimals,
        latest.price AS latest_price,
        latest.price_timestamp AS latest_price_timestamp,
        previous.price AS previous_price,
        coalesce(reporting.reporting_count, 0) AS nodes_reporting
      FROM commodities c
      LEFT JOIN LATERAL (
        SELECT price, price_timestamp FROM price_history
        WHERE symbol = c.symbol ORDER BY price_timestamp DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT price FROM price_history
        WHERE symbol = c.symbol ORDER BY price_timestamp DESC OFFSET 1 LIMIT 1
      ) previous ON true
      LEFT JOIN LATERAL (
        SELECT ledger FROM price_finalizations
        WHERE symbol = c.symbol ORDER BY ledger DESC LIMIT 1
      ) latest_final ON true
      LEFT JOIN LATERAL (
        SELECT ledger FROM price_finalizations
        WHERE symbol = c.symbol AND ledger < latest_final.ledger
        ORDER BY ledger DESC LIMIT 1
      ) prev_final ON true
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT node_address)::int AS reporting_count
        FROM node_submissions
        WHERE symbol = c.symbol
          AND ledger <= latest_final.ledger
          AND ledger > coalesce(prev_final.ledger, 0)
      ) reporting ON latest_final.ledger IS NOT NULL
      ORDER BY c.symbol ASC
    `);

    res.json({
      commodities: result.rows.map((row) => ({
        symbol: row.symbol,
        decimals: row.decimals,
        price: row.latest_price,
        priceTimestamp: row.latest_price_timestamp,
        previousPrice: row.previous_price,
        nodesReporting: row.nodes_reporting,
        nodesTotal: totalNodes,
        sourceAvailable: row.latest_price !== null,
      })),
    });
  });

  app.get("/commodities/:symbol/history", async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();

    const commodity = await pool.query<{ decimals: number }>(
      `SELECT decimals FROM commodities WHERE symbol = $1`,
      [symbol],
    );
    if (commodity.rows.length === 0) {
      res.status(404).json({ error: "unknown commodity" });
      return;
    }

    const history = await pool.query<{ price: string; price_timestamp: string }>(
      `SELECT price, price_timestamp FROM price_history
       WHERE symbol = $1 ORDER BY price_timestamp DESC LIMIT 200`,
      [symbol],
    );

    const finalizations = await pool.query<{
      price: string;
      price_timestamp: string;
      contributing_nodes: string[];
      tx_hash: string;
    }>(
      `SELECT price, price_timestamp, contributing_nodes, tx_hash FROM price_finalizations
       WHERE symbol = $1 ORDER BY price_timestamp DESC LIMIT 50`,
      [symbol],
    );

    const submissions = await pool.query<{
      node_address: string;
      price: string;
      source_ts: string;
      tx_hash: string;
    }>(
      `SELECT node_address, price, source_ts, tx_hash FROM node_submissions
       WHERE symbol = $1 ORDER BY source_ts DESC LIMIT 100`,
      [symbol],
    );

    res.json({
      symbol,
      decimals: commodity.rows[0]?.decimals,
      history: history.rows.map((r) => ({ price: r.price, timestamp: r.price_timestamp })),
      finalizations: finalizations.rows.map((r) => ({
        price: r.price,
        timestamp: r.price_timestamp,
        contributingNodes: r.contributing_nodes,
        txHash: r.tx_hash,
      })),
      submissions: submissions.rows.map((r) => ({
        nodeAddress: r.node_address,
        price: r.price,
        timestamp: r.source_ts,
        txHash: r.tx_hash,
      })),
    });
  });

  app.get("/nodes", async (_req, res) => {
    const result = await pool.query<NodeRow>(`
      SELECT
        n.address,
        n.added_at,
        n.removed_at,
        coalesce(s.submission_count, '0') AS submission_count,
        s.last_submission_at
      FROM nodes n
      LEFT JOIN LATERAL (
        SELECT count(*)::text AS submission_count, max(source_ts) AS last_submission_at
        FROM node_submissions WHERE node_address = n.address
      ) s ON true
      ORDER BY n.added_at ASC
    `);

    res.json({
      nodes: result.rows.map((row) => ({
        address: row.address,
        addedAt: row.added_at,
        removedAt: row.removed_at,
        active: row.removed_at === null,
        submissionCount: Number(row.submission_count),
        lastSubmissionAt: row.last_submission_at,
      })),
    });
  });

  // Phase 4: client-initiated, RPC-verified PriceFloor discovery, see
  // docs/phase4-pricefloor-deal-registry.md. Never trusts the submitted
  // contractId as fact; registerInstance independently confirms it over
  // RPC before persisting anything (Q7/Q12 of that document).
  app.post("/pricefloor-instances", async (req, res) => {
    const contractId = req.body?.contractId;
    if (typeof contractId !== "string" || contractId.length === 0) {
      res.status(400).json({ error: "contractId is required" });
      return;
    }

    const result = await registerInstance(env, pool, contractId);
    if (result.outcome === "refused") {
      res.status(422).json({ error: result.reason });
      return;
    }

    const row = await pool.query<PriceFloorInstanceRow>(
      `SELECT * FROM pricefloor_instances WHERE contract_id = $1`,
      [contractId],
    );
    res.status(result.outcome === "registered" ? 201 : 200).json({
      instance: row.rows[0] ? serializePriceFloorInstance(row.rows[0]) : null,
    });
  });

  app.get("/pricefloor-instances", async (req, res) => {
    const { farmer, buyer } = req.query;
    const conditions: string[] = [];
    const params: string[] = [];
    if (typeof farmer === "string") {
      params.push(farmer);
      conditions.push(`farmer = $${params.length}`);
    }
    if (typeof buyer === "string") {
      params.push(buyer);
      conditions.push(`buyer = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query<PriceFloorInstanceRow>(
      `SELECT * FROM pricefloor_instances ${where} ORDER BY registered_at DESC`,
      params,
    );
    res.json({ instances: result.rows.map(serializePriceFloorInstance) });
  });

  app.get("/pricefloor-instances/:contractId", async (req, res) => {
    const result = await pool.query<PriceFloorInstanceRow>(
      `SELECT * FROM pricefloor_instances WHERE contract_id = $1`,
      [req.params.contractId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "unknown or unregistered pricefloor instance" });
      return;
    }
    res.json({ instance: serializePriceFloorInstance(result.rows[0]!) });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("api request failed", { error: String(err) });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
