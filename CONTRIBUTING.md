# Contributing to AgriFeed

## Workspace layout

```
apps/web            Next.js frontend, pnpm workspace
packages/sdk         TypeScript SDK, pnpm workspace
services/indexer      pnpm workspace
services/node-relayer  pnpm workspace
research/             Python, isolated from the pnpm workspace on purpose
```

`apps/`, `packages/`, and `services/*` (except `research/`) all belong to
the single pnpm workspace defined in `pnpm-workspace.yaml`. Root-level
commands (`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`) run
across all of them via `pnpm -r`.

## Getting set up

```bash
pnpm install
cp .env.example .env.local   # apps/web reads this
docker compose up -d          # local Postgres for services/indexer
pnpm --filter @agrifeed/indexer migrate
pnpm dev:web
pnpm dev:indexer
pnpm dev:node-relayer
```

`services/node-relayer` needs `NODE_RELAYER_SECRET_KEY` set to a funded
testnet account that has already been added as a node via `add_node`, and
`ORACLE_CONTRACT_ID` pointing at a deployed `AgriFeedOracle`. Without
those it will refuse to start rather than run against nothing.

For `research/`:

```bash
cd research
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Coding standards

- TypeScript strict mode everywhere in `apps/`, `packages/`, and
  `services/*` (excluding `research/`). No `any` without a comment
  explaining why it's unavoidable.
- React: functional components and hooks only.
- Every async function that can fail returns a typed result or throws a
  typed error (see `OracleError` and `SourceUnavailableError` in
  `packages/sdk/src/types.ts`). No silent `catch {}` blocks.
- Every component that touches a price value imports the formatting
  helpers from `@agrifeed/sdk` (`formatPrice`, `formatPriceWithUnit`,
  `parseAmountToRaw`); never re-implement i128 decimal handling locally,
  and never cast a raw price to a JS `number` for display.
- Never show a price without its source count and freshness timestamp
  next to it (see `DESIGN.md` section 4, the ticker-row pattern).
- If a data source isn't wired up or a call fails, show that honestly
  (a "source unavailable" state). Never fabricate or fall back to a
  stale-but-unlabeled number.
- `services/indexer` and `services/node-relayer` both log structured JSON
  (see `logger.ts` in each), since both run unattended.
- Follow `DESIGN.md` exactly. If a component needs something the design
  system doesn't cover, extend `DESIGN.md` first, in its own commit, then
  build the component.

## Commit and PR conventions

- Conventional commits: `type(scope): description` (`feat`, `fix`,
  `chore`, `docs`, `research`, `refactor`, `test`).
- One commit per logical unit. Stage specific files, never `git add .`.
- No em dash in commit messages, docs, or UI copy (see the writing style
  note in the root instructions this project was built from); use a
  period, comma, or colon instead.
- Before opening a PR: `pnpm typecheck`, `pnpm lint`, `pnpm build` across
  the workspace, and `pnpm --filter @agrifeed/indexer migrate` against a
  clean database to confirm schema.sql still applies cleanly.

## Adding a new commodity

1. `add_commodity` on the deployed `AgriFeedOracle` (out of scope for
   this repo, see `agrifeed-contract`).
2. Add its unit to `COMMODITY_UNITS` in `packages/sdk/src/format.ts`.
3. Add a FAO reference producer and IMF indicator code to
   `services/node-relayer/src/adapters/fao.ts` and `imf.ts`, each
   confirmed against the live source the same way the existing ones were
   (see the comments at the top of each file), never guessed.
4. Add it to `TRACKED_COMMODITIES` in `services/node-relayer/src/env.ts`.
