import express from "express";
import type { Pool } from "pg";
import { logger } from "../logger.js";
import type { IndexerEnv } from "../env.js";

interface CommodityRow {
  symbol: string;
  decimals: number;
  latest_price: string | null;
  latest_price_timestamp: string | null;
  previous_price: string | null;
  contributing_nodes: string[] | null;
}

interface NodeRow {
  address: string;
  added_at: string;
  removed_at: string | null;
  submission_count: string;
  last_submission_at: string | null;
}

export function createApp(env: IndexerEnv, pool: Pool): express.Express {
  const app = express();

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

    const result = await pool.query<CommodityRow>(`
      SELECT
        c.symbol,
        c.decimals,
        latest.price AS latest_price,
        latest.price_timestamp AS latest_price_timestamp,
        previous.price AS previous_price,
        finalized.contributing_nodes
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
        SELECT contributing_nodes FROM price_finalizations
        WHERE symbol = c.symbol ORDER BY price_timestamp DESC LIMIT 1
      ) finalized ON true
      ORDER BY c.symbol ASC
    `);

    res.json({
      commodities: result.rows.map((row) => ({
        symbol: row.symbol,
        decimals: row.decimals,
        price: row.latest_price,
        priceTimestamp: row.latest_price_timestamp,
        previousPrice: row.previous_price,
        nodesReporting: row.contributing_nodes?.length ?? 0,
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

  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("api request failed", { error: String(err) });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
