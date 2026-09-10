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

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new IndexerUnavailableError(`could not reach indexer at ${path}`, undefined, err);
  }
  if (!response.ok) {
    // The indexer's refusal endpoints (e.g. registration verification
    // failing) return a real, specific reason in the body, never just a
    // bare status code, so surface that instead of a generic message
    // whenever the body actually has one.
    const reason = await response
      .json()
      .then((data: unknown) => (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null))
      .catch(() => null);
    throw new IndexerUnavailableError(reason ?? `indexer returned ${response.status} for ${path}`, response.status);
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

/**
 * Mirrors services/indexer/src/api/server.ts's serializePriceFloorInstance
 * field-for-field (Phase 4). Every field's source of truth is documented in
 * docs/phase4-pricefloor-deal-registry.md; settlementToken/oracleContractId
 * are real fields once populated, not omitted when unset, so a caller can
 * tell "not established yet" (null) apart from "this field doesn't exist."
 */
export interface PriceFloorInstance {
  contractId: string;
  status: "registered" | "initialized" | "funded" | "settled" | "cancelled";
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

/**
 * Registers a freshly deployed PriceFloor instance for discovery (Phase 4).
 * This is a pointer only, never a claim of fact: the indexer independently
 * verifies the contract over RPC before persisting anything (see
 * registerInstance in services/indexer/src/instances.ts), so a successful
 * call here does not mean the terms are trusted from this call, only that
 * the contract id is now known and will be indexed going forward.
 *
 * Deliberately separate from the deploy flow itself: deployInstance() has
 * already produced a real, on-chain contract by the time this is called,
 * so a failure here (the indexer being unreachable, or refusing the id)
 * must never be presented as the deal itself having failed, only as "not
 * discoverable later" -- see NewDealFlow.tsx's own handling of this.
 */
export async function registerPriceFloorInstance(contractId: string): Promise<PriceFloorInstance> {
  const data = await post<{ instance: PriceFloorInstance }>("/pricefloor-instances", { contractId });
  return data.instance;
}

export async function getPriceFloorInstance(contractId: string): Promise<PriceFloorInstance | null> {
  try {
    const data = await get<{ instance: PriceFloorInstance }>(`/pricefloor-instances/${encodeURIComponent(contractId)}`);
    return data.instance;
  } catch (err) {
    if (err instanceof IndexerUnavailableError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function getPriceFloorInstancesByFarmer(farmer: string): Promise<PriceFloorInstance[]> {
  const data = await get<{ instances: PriceFloorInstance[] }>(`/pricefloor-instances?farmer=${encodeURIComponent(farmer)}`);
  return data.instances;
}

export async function getPriceFloorInstancesByBuyer(buyer: string): Promise<PriceFloorInstance[]> {
  const data = await get<{ instances: PriceFloorInstance[] }>(`/pricefloor-instances?buyer=${encodeURIComponent(buyer)}`);
  return data.instances;
}
