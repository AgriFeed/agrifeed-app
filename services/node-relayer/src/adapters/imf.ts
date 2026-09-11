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
 *
 * COFFEE is a special case: the codelist lists PCOFFAVG ("Average of
 * OFECPAR and COFECPRB") as coffee's headline indicator, but querying it
 * directly returns zero observations, it is not itself a published data
 * series, confirmed live. Its own codelist description says what it is:
 * the average of PCOFFOTM (Other Mild Arabica) and PCOFFROB (Robusta),
 * both of which do have real data, also confirmed live. fetchImfPrice
 * computes that average itself instead of querying PCOFFAVG.
 */

const INDICATOR: Record<string, string[]> = {
  COCOA: ["PCOCO"],
  COFFEE: ["PCOFFOTM", "PCOFFROB"],
  WHEAT: ["PWHEAMT"],
  MAIZE: ["PMAIZMT"],
  RICE: ["PRICENPQ"],
  SOYBEAN: ["PSOYB"],
  SUGAR: ["PSUGAISA"],
  COTTON: ["PCOTTIND"],
};

/** US cents/lb indicators; everything else in INDICATOR is USD/MT. */
const CENTS_PER_LB = new Set(["PCOFFOTM", "PCOFFROB", "PSUGAISA", "PCOTTIND"]);

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

interface IndicatorObservation {
  value: number;
  asOf: Date;
}

async function fetchLatestObservation(indicatorCode: string, commodity: string): Promise<IndicatorObservation> {
  const base = process.env.IMF_API_BASE_URL ?? "https://api.imf.org/external/sdmx/3.0";
  const url = `${base}/data/${DATAFLOW}/${COUNTRY_WORLD}.${indicatorCode}.USD.M?format=jsondata`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new SourceUnavailableError("IMF", `network error fetching ${commodity} (${indicatorCode})`, err);
  }
  if (!response.ok) {
    throw new SourceUnavailableError("IMF", `HTTP ${response.status} fetching ${commodity} (${indicatorCode})`);
  }

  const body = (await response.json()) as JsonDataResponse;
  const dataSet = body.data?.dataSets?.[0];
  const series = dataSet?.series ? Object.values(dataSet.series)[0] : undefined;
  const timeValues = body.data?.structures?.[0]?.dimensions?.observation?.[0]?.values;

  if (!series?.observations || !timeValues) {
    throw new SourceUnavailableError("IMF", `no PCPS series returned for ${commodity} (${indicatorCode})`);
  }

  const indices = Object.keys(series.observations)
    .map(Number)
    .sort((a, b) => b - a);

  for (const index of indices) {
    const value = series.observations[String(index)]?.[0];
    const period = timeValues[index]?.value;
    if (value === null || value === undefined || !period) continue;
    return { value: Number(value), asOf: parsePcpsPeriod(period) };
  }

  throw new SourceUnavailableError("IMF", `every recent observation for ${commodity} (${indicatorCode}) is null`);
}

export async function fetchImfPrice(commodity: string): Promise<SourcePrice> {
  const indicatorCodes = INDICATOR[commodity];
  if (!indicatorCodes) {
    throw new SourceUnavailableError("IMF", `no PCPS indicator mapped for ${commodity}`);
  }

  const observations = await Promise.all(
    indicatorCodes.map((code) => fetchLatestObservation(code, commodity)),
  );

  const value = observations.reduce((sum, o) => sum + o.value, 0) / observations.length;
  const oldest = observations.reduce((a, b) => (b.asOf < a.asOf ? b : a));
  const unit = CENTS_PER_LB.has(indicatorCodes[0]!) ? "USD_cents/lb" : "USD/MT";

  return {
    source: "IMF",
    commodity,
    price: String(value),
    unit,
    asOf: oldest.asOf,
  };
}

/** PCPS monthly periods look like "2026-M07". Exported for direct testing
 * (Phase 5 Step 7): the real format-validation risk in this adapter. */
export function parsePcpsPeriod(period: string): Date {
  const match = /^(\d{4})-M(\d{2})$/.exec(period);
  if (!match || !match[1] || !match[2]) {
    throw new SourceUnavailableError("IMF", `unrecognized TIME_PERIOD format "${period}"`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}
