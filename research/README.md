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

- `snapshots/`: real historical pulls from FAO, IMF, and AMIS, saved as CSV
  so the notebooks are reproducible without live network access.
- `notebooks/`: analysis, including the median-of-N backtest.
- `METHODOLOGY.md`: the step-by-step path from raw source data to the price
  submitted on-chain.
