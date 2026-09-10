# Phase 4 Step 5: Persistent PriceFloor Deal REST/API

Exposes the `pricefloor_instances` registry (Step 1 architecture, Step 2
implementation, Step 3 frontend wiring, Step 4 lifecycle validation)
through a stable, documented, validated REST surface: `GET /api/deals`,
`GET /api/deals/:contractId`, and `?farmer=`/`?buyer=` filters on the
list endpoint. No new storage, no new on-chain contract, no My Deals UI
(explicitly out of scope, deferred to a future step).

## Endpoint behavior

`GET /api/deals` — every registered deal, most recently registered first
(`registered_at DESC`). Optional `?farmer=<G...>` and `?buyer=<G...>`
filter; given together, both must match the same deal (AND, not OR).
Optional `?limit=` (default 50, invalid values rejected, values above the
200 ceiling clamped rather than rejected) and `?offset=` page the result.
Response: `{ deals: Deal[], limit: number, offset: number }`. No total
count is returned (see "Remaining limitations").

`GET /api/deals/:contractId` — one deal. `404 { error }` for a
syntactically valid but unregistered/unknown contract id; `400 { error }`
for a string that isn't even shaped like a real Soroban contract id
(distinct from 404, matching this project's existing convention of
separating "malformed" from "not found," e.g. `registerInstance`'s own
refusal path). Response: `{ deal: Deal }`.

Both routes are additive: the pre-existing `GET /pricefloor-instances`
family (Step 2/3) is untouched, same code path (both now share
`services/indexer/src/api/deals.ts`'s `serializeDeal`), same response
shape, so the existing frontend (`apps/web/lib/api.ts`,
`NewDealFlow.tsx`) is unaffected.

## Response schema and source of truth for every field

| Field | Source of truth |
|---|---|
| `contractId` | The registry's primary key; the deal's canonical identity, nothing else names a deal |
| `status` | Indexed lifecycle state, advanced only by an observed on-chain event (`poll.ts`'s `handleEvent`), **never** re-derived from a storage snapshot |
| `farmer`, `buyer`, `commodity`, `floorPrice`, `notional`, `maturityTs` | The `Initialized` event's own payload; `null` until observed |
| `settlementToken`, `oracleContractId` | Not present in any PriceFloor event; read separately from the contract's own instance storage by `enrichInstanceStorage` (`instances.ts`); `null` until that read succeeds |
| `registeredAt`, `registeredAtLedger` | When this indexer's `registerInstance()` independently verified and persisted the row over RPC; not an on-chain event |
| `initializedAt`, `fundedAt`, `settledAt`, `cancelledAt` | Ledger-close time of the transaction that produced the respective event; `null` until observed |

`serializeDeal` (`services/indexer/src/api/deals.ts`) is an explicit
allowlist mapping — never `...row` — so a future column added to
`pricefloor_instances` for internal bookkeeping cannot leak into an API
response without a deliberate code change here.

### `cancelled` is event-only, by design

`status: "cancelled"` is set exclusively by `poll.ts` observing a real
`Cancelled` event. The contract writes no corresponding storage flag
(confirmed by reading `cancel()`'s body directly, see
[phase4-step4-lifecycle-and-decision.md](./phase4-step4-lifecycle-and-decision.md)'s
refined finding: a funded-then-cancelled instance's storage even becomes
indistinguishable from "never funded"). This API inherits that constraint
by construction — it only ever reads `pricefloor_instances.status`, never
touches contract storage directly — so it cannot and does not fabricate a
cancelled state from anything but real event history.

## Filtering behavior

`farmer`/`buyer` are validated with `StrKey.isValidEd25519PublicKey`
(`@stellar/stellar-sdk`), the same check `NewDealFlow.tsx` already uses
client-side for the same kind of input — reused, not reinvented. An
invalid address returns `400`, never a silently-empty result, so a caller
can tell "no deals for this real address" apart from "this wasn't a real
address to begin with." Filters compose as AND: `?farmer=X&buyer=Y`
returns only a deal where X is farmer **and** Y is buyer on the same
instance, confirmed by a dedicated test (two real fixture deals, one
matching farmer alone, one matching buyer alone, neither matching both).

Multi-instance isolation (the core guarantee Step 2 built): every query
is scoped by exact `contract_id`/`farmer`/`buyer` equality against
`pricefloor_instances`, the same table and columns Step 2's own isolation
tests already cover at the ingestion layer; this step adds isolation
tests at the read/API layer specifically (see "Test evidence").

## Pagination/order behavior

No pagination existed anywhere else in this API before this step
(`/commodities`, `/nodes`, and the pre-existing `/pricefloor-instances`
are all unbounded lists), so this step adds the minimum useful
convention rather than a general abstraction: `limit`/`offset` on the one
endpoint likely to grow unbounded over time (every deal ever registered),
ordered by `registered_at DESC` — the same order `/pricefloor-instances`
already used. `/pricefloor-instances` itself is deliberately **not**
retrofitted with pagination in this step, to keep its behavior byte-for-
byte unchanged for the existing frontend.

## Test evidence

New file `services/indexer/src/api/deals.test.ts`, 18 tests, run against
real Postgres (`agrifeed_test`) and a real HTTP server (`app.listen(0)` +
real `fetch`, no mocked chain state and no mocked HTTP layer, matching
this project's existing test convention):

- Empty registry → `{ deals: [] }`, not an error.
- One deal → correct camelCase shape, explicit assertion that no raw
  `snake_case` DB column name is present on the response object (the "no
  internal field disclosure" requirement made concrete).
- Multiple deals → correct `registered_at DESC` ordering.
- `?farmer=`, `?buyer=`, and both together (AND semantics) → correct
  isolation, no cross-instance contamination.
- Pagination: page size, offset windowing (no repeats/gaps across pages),
  clamping an excessive `limit` rather than rejecting it.
- Malformed `farmer`/`buyer` (including the realistic mistake of passing
  a contract id instead of an account address) and malformed
  `limit`/`offset` → `400`.
- `GET /api/deals/:contractId` for a `settled` deal (full terms and
  timestamps) and a seeded `cancelled` deal (see below), an unknown-but-
  valid contract id (`404`), a syntactically invalid one (`400`), and
  two real instances requested back to back to confirm neither leaks the
  other's terms.

**One disclosed limitation in the cancelled-deal test**: it seeds a
`cancelled` row directly into the test database rather than producing it
via a real `cancel()` call, because a live `cancel()` cannot complete
inside a test run — its grace periods are real 48–96 hour waits on
Testnet (see Step 4's report). This test only exercises the read-API
layer (given a row in this shape, is it served correctly); real
event-ingestion coverage for `cancelled` (a genuine `Cancelled` event
actually advancing a row) is `poll.test.ts`'s job, already covered there
with the same kind of synthetic event, for the identical reason.

Full suite after this step: **104 tests** (27 SDK + 24 web + 53 indexer,
up from 35 indexer tests before this step's 18 additions). `pnpm
typecheck`, `pnpm build`, and `pnpm test` all pass. No formatting script
exists anywhere in this repo (checked `package.json` at every workspace
root); nothing to run there.

Also manually verified against the live, real Testnet-backed `agrifeed`
database (not just the test database): `GET /api/deals/:contractId` for
the real settled instance from Step 4
(`CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272`) returns the
same data as the pre-existing `GET /pricefloor-instances/:contractId`;
`GET /api/deals?farmer=not-an-address` returns `400` live; `GET
/api/deals/<real oracle contract id, never registered as a deal>`
returns `404` live.

## Remaining limitations

- **No total count in list responses.** A client can tell it received a
  full page (`deals.length === limit`) but not how many deals exist in
  total without paging through everything. Not added here: a `COUNT(*)`
  query on every list call is a real, avoidable cost this step doesn't
  need to pay before anything actually needs a total.
- **Cancelled ingestion still depends on unbroken event coverage**,
  exactly Step 1/Step 4's finding, unchanged by this step: this API
  layer cannot close that gap, only the contract-level fix Step 4
  recommended (a `DataKey::Cancelled` storage flag) can.
- **`/pricefloor-instances` and `/api/deals` are two routes over one
  table.** Deliberate, not an oversight: keeps existing frontend behavior
  provably unchanged. A future step could migrate the frontend onto
  `/api/deals` and retire the older route, but that is a frontend change
  this step's own constraints put out of scope.
- **No My Deals UI.** Explicitly out of scope per this step's
  instructions; this step only builds the API surface such a UI would
  read from.

## Files changed

```
apps/web/app/docs/page.tsx                   | +77 -9
docs/phase4-step5-deals-api.md               | new (this file)
services/indexer/src/api/deals.ts            | new (205 lines)
services/indexer/src/api/deals.test.ts       | new (334 lines)
services/indexer/src/api/server.ts           | +32
```
