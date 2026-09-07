import { SourceUnavailableError } from "@agrifeed/sdk";
import type { SourcePrice } from "./types.js";

/**
 * IMF Primary Commodity Price System (PCPS), SDMX 3.0 REST API.
 *
 * Confirmed live 2026-09-07 by fetching the actual dataflow, its DSD, and
 * the CL_PCPS_INDICATOR(3.0.0) codelist: base
 * https://api.imf.org/external/sdmx/3.0, dataflow IMF.RES:PCPS(9.0.0), no
 * auth. Key order is COUNTRY.INDICATOR.DATA_TRANSFORMATION.FREQUENCY;
 * COUNTRY=G001 is "World" (from the live CL_COUNTRY(1.6.0) codelist, not
 * "W00" as might be assumed), DATA_TRANSFORMATION=USD selects the actual
 * nominal price series (as opposed to an index), FREQUENCY=M is monthly.
 * A real data query for G001.PCOCO.USD.M returned a live series back to
 * 1992-M01 during verification.
 */

const INDICATOR: Record<string, { code: string; unit: string }> = {
  COCOA: { code: "PCOCO", unit: "USD/MT" },
  COFFEE: { code: "PCOFFAVG", unit: "USD_cents/lb" },
  WHEAT: { code: "PWHEAMT", unit: "USD/MT" },
  MAIZE: { code: "PMAIZMT", unit: "USD/MT" },
  RICE: { code: "PRICENPQ", unit: "USD/MT" },
  SOYBEAN: { code: "PSOYB", unit: "USD/MT" },
  SUGAR: { code: "PSUGAISA", unit: "USD_cents/lb" },
  COTTON: { code: "PCOTTIND", unit: "USD_cents/lb" },
};

const COUNTRY_WORLD = "G001";
const DATAFLOW = "dataflow/IMF.RES/PCPS/9.0.0";

interface JsonDataResponse {
  data?: {
    dataSets?: Array<{ series?: Record<string, { observations?: Record<string, [number | string | null, ...unknown[]]> }> }>;
    structures?: Array<{
      dimensions?: { observation?: Array<{ values?: Array<{ value: string }> }> };
    }>;
  };
}

export async function fetchImfPrice(commodity: string): Promise<SourcePrice> {
  const indicator = INDICATOR[commodity];
  if (!indicator) {
    throw new SourceUnavailableError("IMF", `no PCPS indicator mapped for ${commodity}`);
  }

  const base = process.env.IMF_API_BASE_URL ?? "https://api.imf.org/external/sdmx/3.0";
  const url = `${base}/data/${DATAFLOW}/${COUNTRY_WORLD}.${indicator.code}.USD.M?format=jsondata`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new SourceUnavailableError("IMF", `network error fetching ${commodity}`, err);
  }
  if (!response.ok) {
    throw new SourceUnavailableError("IMF", `HTTP ${response.status} fetching ${commodity}`);
  }

  const body = (await response.json()) as JsonDataResponse;
  const dataSet = body.data?.dataSets?.[0];
  const series = dataSet?.series ? Object.values(dataSet.series)[0] : undefined;
  const timeValues = body.data?.structures?.[0]?.dimensions?.observation?.[0]?.values;

  if (!series?.observations || !timeValues) {
    throw new SourceUnavailableError("IMF", `no PCPS series returned for ${commodity}`);
  }

  const indices = Object.keys(series.observations)
    .map(Number)
    .sort((a, b) => b - a);

  for (const index of indices) {
    const observation = series.observations[String(index)];
    const value = observation?.[0];
    const period = timeValues[index]?.value;
    if (value === null || value === undefined || !period) continue;

    return {
      source: "IMF",
      commodity,
      price: String(value),
      unit: indicator.unit,
      asOf: parsePcpsPeriod(period),
    };
  }

  throw new SourceUnavailableError("IMF", `every recent observation for ${commodity} is null`);
}

/** PCPS monthly periods look like "2026-M07". */
function parsePcpsPeriod(period: string): Date {
  const match = /^(\d{4})-M(\d{2})$/.exec(period);
  if (!match || !match[1] || !match[2]) {
    throw new SourceUnavailableError("IMF", `unrecognized TIME_PERIOD format "${period}"`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}
