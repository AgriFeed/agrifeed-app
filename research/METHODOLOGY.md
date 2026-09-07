# Methodology: raw source data to on-chain price

This is the exact path a number takes from a public statistics agency to a
`PriceData` record on `AgriFeedOracle`, and the specific choices made along
the way, disclosed rather than buried.

## 1. Sources

AgriFeed reads from two sources that actually publish prices, and is
honest about a third that does not.

- **IMF**, Primary Commodity Price System (PCPS), SDMX 3.0 REST API. A
  single global nominal USD price per commodity, published monthly. This
  is the one source here that is a genuine world price.
- **FAO**, FAOSTAT Producer Prices. FAOSTAT does not publish a
  world-aggregate producer price in USD, only per-country farm-gate
  prices, confirmed by querying the "World" area code directly and
  getting zero rows for that element. AgriFeed uses a specific,
  disclosed reference producer country per commodity instead (see the
  table below), the same approach IMF's own PCPS series takes for rice
  ("Rice, Thailand").
- **AMIS**, Agricultural Market Information System. AMIS's Market
  Database publishes supply, demand, and stocks (production, imports,
  utilization, exports, closing stocks), never prices, confirmed by a
  live query that returned exactly those columns and no price field.
  AMIS is fetched for diagnostic context only, in
  `services/node-relayer/src/adapters/amis.ts`, and never contributes to
  a submitted price. `research/snapshots/amis_supply_demand.csv` exists
  to document this, not to feed the backtest.

## 2. FAO reference producers

| Commodity | Reference country | FAOSTAT item | Note |
|---|---|---|---|
| COCOA | Cote d'Ivoire | Cocoa beans | World's largest producer |
| COFFEE | Brazil | Coffee, green | World's largest producer |
| WHEAT | United States of America | Wheat | |
| MAIZE | United States of America | Maize (corn) | |
| RICE | Thailand | Rice, paddy | Matches IMF's own rice benchmark |
| SOYBEAN | Brazil | Soya beans | World's largest producer |
| SUGAR | Brazil | Sugar cane | Farm-gate cane price, not refined sugar |
| COTTON | Brazil | Seed cotton, unginned | Raw seed cotton, not ginned lint |

## 3. Unit normalization

Sources report in different units: FAO and most IMF series in USD per
metric tonne, but IMF's coffee, sugar, and cotton series in US cents per
pound. `services/node-relayer/src/normalize/units.ts` converts everything
to USD/MT before combining, using the standard conversion
1 metric tonne = 2204.622622 lb.

## 4. Combining sources into one submission

A single node-relayer process fetches from every configured source for a
commodity, drops any source that failed (logged, never silently), and
takes the **median of whatever succeeded**. With only FAO and IMF
providing real prices, this is a median of at most two values (their
average), or the single value if one source is down that cycle. A node
never submits when every source fails; there is no fallback to a stale or
fabricated number.

This local median is one node's `submit_price` call. The oracle's
`finalize_price` then computes a second median across every independent
node's submission for that commodity, which is the actual decentralization
guarantee: no single node, and no single upstream source, determines the
finalized price. `notebooks/median_backtest.ipynb` backtests this
two-layer median against the real historical data in `snapshots/`.

## 5. What "source_ts" means

Each submission's `source_ts` is the **oldest** contributing observation's
date, not the time of submission. If FAO's figure is a year old and IMF's
is from last month, the combined submission is timestamped to FAO's older
date, so `source_ts` never overstates how fresh the combined number is.
