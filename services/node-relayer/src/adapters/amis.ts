import { SourceUnavailableError } from "@agrifeed/sdk";
import { logger } from "../logger.js";
import type { SourcePrice } from "./types.js";

/**
 * AMIS (Agricultural Market Information System, amis-outlook.org).
 *
 * Verified live 2026-09-07: AMIS has no API or dataset of its own that
 * publishes commodity PRICES. Its Market Database — served through
 * https://api.data.apps.fao.org/api/v2/bigquery — covers only supply,
 * demand, and stocks (production, imports, domestic utilization,
 * exports, closing stocks, in million tonnes) for four commodities
 * (wheat, maize, rice, soybean). A real query against it returned rows
 * with columns like production/opening_stocks/exports_nmy/closing_stocks
 * and zero price fields. AMIS also only covers 4 of AgriFeed's 8
 * commodities, never cocoa, coffee, sugar, or cotton.
 *
 * Rather than dropping this file or faking a price from balance-sheet
 * data (explicitly forbidden by this project's own rules), this adapter
 * makes a real best-effort fetch of that supply/demand context for
 * logging/diagnostics, then always throws SourceUnavailableError for the
 * price role it structurally cannot fill. normalize/aggregate.ts treats
 * AMIS as permanently absent from the price median, not as a third
 * source that sometimes fails.
 */

const AMIS_PRODUCT_CODE: Record<string, number> = {
  WHEAT: 1,
  RICE: 4,
  MAIZE: 5,
  SOYBEAN: 6,
};

export async function fetchAmisPrice(commodity: string): Promise<SourcePrice> {
  await logSupplyDemandContext(commodity);
  throw new SourceUnavailableError(
    "AMIS",
    `AMIS publishes supply/demand balance sheets, not prices, for ${commodity}; it cannot contribute to submit_price`,
  );
}

async function logSupplyDemandContext(commodity: string): Promise<void> {
  const productCode = AMIS_PRODUCT_CODE[commodity];
  if (!productCode) return;

  const base = process.env.AMIS_API_BASE_URL ?? "https://api.data.apps.fao.org/api/v2/bigquery";
  const year = new Date().getUTCFullYear();
  const url = `${base}?product=${productCode}&year=${year}&region=all&database=CBS`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const rows = (await response.json()) as unknown[];
    logger.info("AMIS supply/demand context fetched (not used as a price)", {
      commodity,
      rows: Array.isArray(rows) ? rows.length : 0,
    });
  } catch {
    // Purely informational; a failure here must never block price submission.
  }
}
