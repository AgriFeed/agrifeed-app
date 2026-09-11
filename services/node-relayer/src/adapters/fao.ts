import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import unzipper from "unzipper";
import { SourceUnavailableError } from "@agrifeed/sdk";
import { logger } from "../logger.js";
import type { SourcePrice } from "./types.js";

/**
 * FAOSTAT Producer Prices (domain "PP").
 *
 * Verified 2026-09-07 by live fetch:
 *  - The classic query API (fenixservices.fao.org/faostat/api/v1) timed
 *    out / was unreachable during verification. It's still attempted
 *    first below, with a short timeout, in case it's back by the time
 *    this runs.
 *  - The bulk data product IS live and confirmed:
 *    https://bulks-faostat.fao.org/production/Prices_E_All_Data_(Normalized).zip
 *    (11.7MB zip, ~214MB normalized CSV inside). Columns confirmed from a
 *    real download: Area Code, Item Code, Element Code, Year, Unit, Value.
 *    Element 5532 = "Producer Price (USD/tonne)" (confirmed against
 *    Prices_E_Elements.csv in the same archive).
 *
 * FAOSTAT does NOT publish a world-aggregate producer price in USD (only
 * per-country farm-gate prices exist for that element), confirmed by
 * querying area code 5000 ("World") + element 5532 against the live file
 * and getting zero rows. So each commodity below uses a specific
 * reference producer country instead of a "world price": the world's
 * largest producer where FAO has recent USD data, chosen the same way
 * IMF's own "Rice, Thailand" PCPS series does. This is a real,
 * FAO-published number for a specific country, not a fabricated global
 * average, and is disclosed here and in research/METHODOLOGY.md.
 */

const ELEMENT_PRODUCER_PRICE_USD = "5532";

const REFERENCE: Record<string, { area: string; item: string; country: string; note: string }> = {
  COCOA: { area: "107", item: "661", country: "Côte d'Ivoire", note: "Cocoa beans" },
  COFFEE: { area: "21", item: "656", country: "Brazil", note: "Coffee, green" },
  WHEAT: { area: "231", item: "15", country: "United States of America", note: "Wheat" },
  MAIZE: { area: "231", item: "56", country: "United States of America", note: "Maize (corn)" },
  RICE: { area: "216", item: "27", country: "Thailand", note: "Rice, paddy" },
  SOYBEAN: { area: "21", item: "236", country: "Brazil", note: "Soya beans" },
  SUGAR: { area: "21", item: "156", country: "Brazil", note: "Sugar cane (farm-gate, not refined sugar)" },
  COTTON: { area: "21", item: "328", country: "Brazil", note: "Seed cotton, unginned" },
};

const BULK_ZIP_URL = "https://bulks-faostat.fao.org/production/Prices_E_All_Data_(Normalized).zip";
const CACHE_DIR = path.join(tmpdir(), "agrifeed-fao-cache");
const CACHE_CSV_PATH = path.join(CACHE_DIR, "Prices_E_All_Data_(Normalized).csv");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchFaoPrice(commodity: string): Promise<SourcePrice> {
  const reference = REFERENCE[commodity];
  if (!reference) {
    throw new SourceUnavailableError("FAO", `no reference producer mapped for ${commodity}`);
  }

  const viaApi = await tryClassicApi(commodity, reference);
  if (viaApi) return viaApi;

  return fetchFromBulkCsv(commodity, reference);
}

/** Exported for direct testing (Phase 5 Step 7) via a stubbed `fetch`,
 * the same boundary-stub convention apps/web's own api.test.ts already
 * uses -- this is the real decision logic (parse the response, fall back
 * to null on any failure), not a network integration test. */
export async function tryClassicApi(
  commodity: string,
  reference: { area: string; item: string },
): Promise<SourcePrice | null> {
  const base = process.env.FAO_API_BASE_URL ?? "https://fenixservices.fao.org/faostat/api/v1";
  const url = `${base}/en/data/PP?area=${reference.area}&item=${reference.item}&element=${ELEMENT_PRODUCER_PRICE_USD}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: Array<{ Year: string; Value: number }> };
    const rows = body.data ?? [];
    if (rows.length === 0) return null;

    const latest = rows.reduce((a, b) => (Number(b.Year) > Number(a.Year) ? b : a));
    return {
      source: "FAO",
      commodity,
      price: String(latest.Value),
      unit: "USD/MT",
      asOf: new Date(Date.UTC(Number(latest.Year), 11, 31)),
    };
  } catch {
    logger.warn("FAO classic API unreachable, falling back to bulk CSV", { commodity });
    return null;
  }
}

async function ensureBulkCsvCached(): Promise<void> {
  if (existsSync(CACHE_CSV_PATH)) {
    const age = Date.now() - statSync(CACHE_CSV_PATH).mtimeMs;
    if (age < CACHE_TTL_MS) return;
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, "prices.zip");

  const response = await fetch(BULK_ZIP_URL);
  if (!response.ok || !response.body) {
    throw new SourceUnavailableError("FAO", `bulk CSV download failed with HTTP ${response.status}`);
  }

  const fileStream = createWriteStream(zipPath);
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as never).pipe(fileStream).on("finish", resolve).on("error", reject);
  });

  const directory = await unzipper.Open.file(zipPath);
  const entry = directory.files.find((f) => f.path.endsWith("Prices_E_All_Data_(Normalized).csv"));
  if (!entry) {
    throw new SourceUnavailableError("FAO", "normalized CSV not found inside bulk zip");
  }

  await new Promise<void>((resolve, reject) => {
    entry
      .stream()
      .pipe(createWriteStream(CACHE_CSV_PATH))
      .on("finish", resolve)
      .on("error", reject);
  });

  await rm(zipPath, { force: true });
}

/** Splits one FAOSTAT normalized-CSV row. Every field is quoted and
 * comma-separated with no escaped quotes in this file, confirmed against
 * a real download, so a plain split on `","` is sufficient here. Exported
 * for direct testing (Phase 5 Step 7): the actual parsing risk in this
 * adapter is here, not in the network fetch around it. */
export function splitFaoRow(line: string): string[] {
  return line.slice(1, -1).split('","');
}

async function fetchFromBulkCsv(
  commodity: string,
  reference: { area: string; item: string },
): Promise<SourcePrice> {
  try {
    await ensureBulkCsvCached();
  } catch (err) {
    throw new SourceUnavailableError("FAO", `could not obtain bulk CSV for ${commodity}`, err);
  }

  const rl = createInterface({ input: createReadStream(CACHE_CSV_PATH), crlfDelay: Infinity });

  let best: { year: number; value: string } | null = null;
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const fields = splitFaoRow(line);
    const [areaCode, , , itemCode, , , elementCode, , yearCode, , , , , value] = fields;
    if (areaCode !== reference.area || itemCode !== reference.item || elementCode !== ELEMENT_PRODUCER_PRICE_USD) {
      continue;
    }
    const year = Number(yearCode);
    if (!best || year > best.year) {
      best = { year, value: value ?? "" };
    }
  }

  if (!best) {
    throw new SourceUnavailableError(
      "FAO",
      `no producer price rows found for ${commodity} (area ${reference.area}, item ${reference.item})`,
    );
  }

  return {
    source: "FAO",
    commodity,
    price: best.value,
    unit: "USD/MT",
    asOf: new Date(Date.UTC(best.year, 11, 31)),
  };
}
