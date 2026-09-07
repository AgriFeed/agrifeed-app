"""Pulls real historical commodity data from FAO, IMF, and AMIS and saves
it as CSV, so the notebooks in ../notebooks can run reproducibly without
live network access. Mirrors the exact sources, reference countries, and
indicator codes used by services/node-relayer/src/adapters/, all verified
live on 2026-09-07 (see those adapter files for how each was confirmed).

Usage: python3 pull_snapshots.py
"""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import requests

SNAPSHOT_DIR = Path(__file__).parent

# Same reference producers as services/node-relayer/src/adapters/fao.ts,
# chosen because FAOSTAT publishes no world-aggregate USD producer price.
FAO_REFERENCE = {
    "COCOA": {"area": "107", "item": "661", "country": "Cote d'Ivoire"},
    "COFFEE": {"area": "21", "item": "656", "country": "Brazil"},
    "WHEAT": {"area": "231", "item": "15", "country": "United States of America"},
    "MAIZE": {"area": "231", "item": "56", "country": "United States of America"},
    "RICE": {"area": "216", "item": "27", "country": "Thailand"},
    "SOYBEAN": {"area": "21", "item": "236", "country": "Brazil"},
    "SUGAR": {"area": "21", "item": "156", "country": "Brazil"},
    "COTTON": {"area": "21", "item": "328", "country": "Brazil"},
}
FAO_ELEMENT_PRODUCER_PRICE_USD = "5532"
FAO_BULK_ZIP_URL = "https://bulks-faostat.fao.org/production/Prices_E_All_Data_(Normalized).zip"

# Same indicator codes as services/node-relayer/src/adapters/imf.ts.
# COFFEE has two rows (PCOFFOTM, PCOFFROB): PCOFFAVG itself has no data
# series despite being in the live codelist, see imf.ts's comment.
IMF_INDICATOR = {
    "COCOA": ["PCOCO"],
    "COFFEE": ["PCOFFOTM", "PCOFFROB"],
    "WHEAT": ["PWHEAMT"],
    "MAIZE": ["PMAIZMT"],
    "RICE": ["PRICENPQ"],
    "SOYBEAN": ["PSOYB"],
    "SUGAR": ["PSUGAISA"],
    "COTTON": ["PCOTTIND"],
}
IMF_BASE = "https://api.imf.org/external/sdmx/3.0"
IMF_COUNTRY_WORLD = "G001"

AMIS_BASE = "https://api.data.apps.fao.org/api/v2/bigquery"
AMIS_PRODUCT_CODE = {"WHEAT": 1, "RICE": 4, "MAIZE": 5, "SOYBEAN": 6}


def pull_fao() -> None:
    print("Downloading FAO bulk producer prices zip...")
    resp = requests.get(FAO_BULK_ZIP_URL, timeout=120)
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        csv_name = next(n for n in zf.namelist() if n.endswith("Normalized).csv"))
        with zf.open(csv_name) as f:
            reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
            header = next(reader)
            rows = []
            wanted = {(v["area"], v["item"]) for v in FAO_REFERENCE.values()}
            for row in reader:
                if (row[0], row[3]) in wanted and row[6] == FAO_ELEMENT_PRODUCER_PRICE_USD:
                    rows.append(row)

    out_path = SNAPSHOT_DIR / "fao_producer_prices.csv"
    with out_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {out_path}")


def pull_imf() -> None:
    rows = []
    for symbol, indicators in IMF_INDICATOR.items():
        for indicator in indicators:
            url = f"{IMF_BASE}/data/dataflow/IMF.RES/PCPS/9.0.0/{IMF_COUNTRY_WORLD}.{indicator}.USD.M?format=jsondata"
            print(f"Fetching IMF PCPS for {symbol} ({indicator})...")
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            body = resp.json()

            dataset = body["data"]["dataSets"][0]
            series = next(iter(dataset.get("series", {}).values()), None)
            time_values = body["data"]["structures"][0]["dimensions"]["observation"][0]["values"]
            if series is None:
                print(f"  no data for {symbol} ({indicator}), skipping")
                continue

            for index_str, obs in series["observations"].items():
                value = obs[0]
                if value is None:
                    continue
                period = time_values[int(index_str)]["value"]
                rows.append([symbol, indicator, period, value])

    out_path = SNAPSHOT_DIR / "imf_pcps_prices.csv"
    with out_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["symbol", "indicator", "period", "usd_value"])
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {out_path}")


def pull_amis() -> None:
    """AMIS has no price data (see adapters/amis.ts); this snapshot is
    supply/demand/stocks context only, never used in the price backtest."""
    rows = []
    fieldnames: list[str] | None = None
    for symbol, product_code in AMIS_PRODUCT_CODE.items():
        for year in range(2021, 2026):
            url = f"{AMIS_BASE}?product={product_code}&year={year}&region=all&database=CBS"
            try:
                resp = requests.get(url, timeout=30)
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:  # noqa: BLE001 - best-effort context pull
                print(f"  AMIS {symbol} {year} unavailable: {exc}")
                continue
            if not isinstance(data, list):
                continue
            for row in data:
                row["symbol"] = symbol
                rows.append(row)
                if fieldnames is None:
                    fieldnames = list(row.keys())

    out_path = SNAPSHOT_DIR / "amis_supply_demand.csv"
    if rows and fieldnames:
        with out_path.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"Wrote {len(rows)} rows to {out_path}")
    else:
        print("AMIS returned no rows this run; not overwriting any existing snapshot.")


if __name__ == "__main__":
    pull_fao()
    pull_imf()
    pull_amis()
