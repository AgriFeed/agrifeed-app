/** Typed client for services/indexer's REST API. Every function here either
 * returns real data or throws IndexerUnavailableError; callers render an
 * honest "source unavailable" state, never a fabricated fallback. */

export class IndexerUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IndexerUnavailableError";
  }
}

export interface CommodityTicker {
  symbol: string;
  decimals: number;
  price: string | null;
  priceTimestamp: string | null;
  previousPrice: string | null;
  nodesReporting: number;
  nodesTotal: number;
  sourceAvailable: boolean;
}

export interface CommodityHistoryPoint {
  price: string;
  timestamp: string;
}

export interface CommodityFinalization {
  price: string;
  timestamp: string;
  contributingNodes: string[];
  txHash: string;
}

export interface CommoditySubmission {
  nodeAddress: string;
  price: string;
  timestamp: string;
  txHash: string;
}

export interface CommodityHistory {
  symbol: string;
  decimals: number;
  history: CommodityHistoryPoint[];
  finalizations: CommodityFinalization[];
  submissions: CommoditySubmission[];
}

export interface OracleNode {
  address: string;
  addedAt: string;
  removedAt: string | null;
  active: boolean;
  submissionCount: number;
  lastSubmissionAt: string | null;
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_INDEXER_API_URL ?? "http://localhost:4000";
}

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { cache: "no-store" });
  } catch (err) {
    throw new IndexerUnavailableError(`could not reach indexer at ${path}`, undefined, err);
  }
  if (!response.ok) {
    throw new IndexerUnavailableError(`indexer returned ${response.status} for ${path}`, response.status);
  }
  return (await response.json()) as T;
}

export async function getCommodities(): Promise<CommodityTicker[]> {
  const data = await get<{ commodities: CommodityTicker[] }>("/commodities");
  return data.commodities;
}

export async function getCommodityHistory(symbol: string): Promise<CommodityHistory | null> {
  try {
    return await get<CommodityHistory>(`/commodities/${encodeURIComponent(symbol)}/history`);
  } catch (err) {
    if (err instanceof IndexerUnavailableError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function getNodes(): Promise<OracleNode[]> {
  const data = await get<{ nodes: OracleNode[] }>("/nodes");
  return data.nodes;
}
