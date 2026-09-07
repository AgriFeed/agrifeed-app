# agrifeed-app

The public-facing half of AgriFeed, an open, decentralized commodity price
oracle on Stellar. This repo holds everything except the Soroban contracts
themselves (`AgriFeedOracle` and `AgriPriceFloor`), which live in
[`agrifeed-contract`](https://github.com/AgriFeed/agrifeed-contract): the
frontend, the TypeScript SDK, the on-chain event indexer, the off-chain
node relayer that feeds real prices into the oracle, and the research
documenting exactly how those prices are sourced.

See `PRODUCT.md` for what problem this solves and who it's for, and
`DESIGN.md` for the visual language every page in `apps/web` follows.

## Why `indexer` and `node-relayer` live here, not in their own repos

They're kept out of `agrifeed-contract` on purpose, and kept together with
the SDK they both depend on rather than split into separate repos a
reviewer would have to go find:

- **`services/node-relayer`** is the write side of the oracle. Anyone can
  run their own instance against their own node address, it's meant to be
  forked and operated independently, not something only this org runs.
- **`services/indexer`** is the read side, serving `apps/web` (and anyone
  else) without requiring a Soroban RPC dependency for simple reads.

Both depend on `packages/sdk`, which is also what `apps/web` uses to talk
to the contracts directly. Splitting these into separate repos would mean
three copies of the same contract-interface code drifting independently;
one workspace keeps them honest against each other.

## Repo layout

```
apps/web            Next.js frontend: live ticker, commodity history,
                     node list, the AgriPriceFloor demo, integration docs
packages/sdk         TypeScript SDK wrapping Soroban calls
services/indexer      Polls the oracle, writes to Postgres, serves REST
services/node-relayer  Fetches real prices, submits them on-chain
research/             Python: real historical snapshots, the median-of-N
                     backtest, and the methodology writeup
```

## Quickstart

```bash
pnpm install
cp .env.example .env.local

docker compose up -d                       # local Postgres
pnpm --filter @agrifeed/indexer migrate

pnpm dev:web          # http://localhost:3000
pnpm dev:indexer      # http://localhost:4000
pnpm dev:node-relayer # needs NODE_RELAYER_SECRET_KEY + ORACLE_CONTRACT_ID
```

Until `NEXT_PUBLIC_ORACLE_CONTRACT_ID` and the other contract-id
env vars are filled in with a real `agrifeed-contract` testnet
deployment, every page in `apps/web` shows an honest "source unavailable"
state rather than placeholder data, this is intentional, see `DESIGN.md`.

## Routes

| Route | Purpose |
|---|---|
| `/` | Live ticker: every tracked commodity, price, delta, node count, freshness |
| `/commodity/[symbol]` | Price history, finalizations, and every contributing node |
| `/nodes` | The authorized node set and their real submission activity |
| `/demo` | Connect Freighter and walk through a real `AgriPriceFloor` contract |
| `/docs` | Integration guide for developers consuming the oracle |

## Contributing

See `CONTRIBUTING.md` for workspace setup, coding standards, and commit
conventions.
