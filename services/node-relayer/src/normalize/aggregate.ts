import { parseAmountToRaw, SourceUnavailableError } from "@agrifeed/sdk";
import { logger } from "../logger.js";
import type { SourceAdapter, SourcePrice } from "../adapters/types.js";
import { toUsdPerMetricTonne } from "./units.js";

export interface AggregatedPrice {
  commodity: string;
  /** Raw i128 string, already scaled by 10^decimals, ready for submit_price. */
  rawPrice: string;
  contributingSources: string[];
  /** The oldest contributing observation's date, so source_ts never
   * overstates how fresh the combined figure is. */
  sourceTs: bigint;
}

/**
 * Fetches from every adapter, converts each successful result to USD/MT,
 * and takes the median. Median-of-N here mirrors what finalize_price does
 * on-chain across independent nodes, backtested in
 * research/notebooks/median_backtest.ipynb. Requires at least one real
 * source; never fabricates a price when every adapter fails.
 */
export async function aggregatePrice(
  commodity: string,
  decimals: number,
  adapters: SourceAdapter[],
): Promise<AggregatedPrice> {
  const settled = await Promise.allSettled(adapters.map((adapter) => adapter(commodity)));

  const succeeded: SourcePrice[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      succeeded.push(result.value);
    } else {
      const reason = result.reason;
      const message = reason instanceof SourceUnavailableError ? reason.message : String(reason);
      logger.warn("source unavailable", { commodity, error: message });
    }
  }

  if (succeeded.length === 0) {
    throw new SourceUnavailableError("aggregate", `every source failed for ${commodity}, nothing to submit`);
  }

  const normalized = succeeded
    .map((s) => ({ source: s.source, value: toUsdPerMetricTonne(Number(s.price), s.unit), asOf: s.asOf }))
    .sort((a, b) => a.value - b.value);

  const mid = Math.floor(normalized.length / 2);
  const median =
    normalized.length % 2 === 1
      ? normalized[mid]!.value
      : (normalized[mid - 1]!.value + normalized[mid]!.value) / 2;

  const oldest = normalized.reduce((a, b) => (b.asOf < a.asOf ? b : a));

  return {
    commodity,
    rawPrice: parseAmountToRaw(median.toFixed(decimals), decimals),
    contributingSources: succeeded.map((s) => s.source),
    sourceTs: BigInt(Math.floor(oldest.asOf.getTime() / 1000)),
  };
}
