# AgriFeed research

This folder is Python, not part of the pnpm workspace. It exists to document
and backtest, with real historical data, the same median-of-N aggregation
method that `AgriFeedOracle.finalize_price` performs on-chain.

## Setup

```bash
cd research
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
jupyter notebook notebooks/
```

## Layout

- `snapshots/`: real historical pulls from FAO and IMF, saved as CSV so
  the notebooks are reproducible without live network access, plus
  `pull_snapshots.py` to refresh them. AMIS is queried too (see
  `pull_snapshots.py` and `services/node-relayer/src/adapters/amis.ts`),
  but AMIS publishes no price data, so there is no `amis_*.csv` price
  snapshot here, only diagnostic logging in the adapter itself.
- `notebooks/`: analysis, including the median-of-N backtest.
- `METHODOLOGY.md`: the step-by-step path from raw source data to the price
  submitted on-chain.

Refresh the snapshots with:

```bash
cd research && source .venv/bin/activate
python3 snapshots/pull_snapshots.py
jupyter nbconvert --to notebook --execute --inplace notebooks/median_backtest.ipynb
```
