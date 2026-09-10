# Phase 4 Step 2: Multi-Instance PriceFloor Discovery, Implementation Report

Implements the architecture defined in
[docs/phase4-pricefloor-deal-registry.md](./phase4-pricefloor-deal-registry.md)
(Phase 4 Step 1). Read that document first; this one covers what was
actually built, what real evidence backs it, and what remains open.

## Discovery mechanism

Client-initiated, indexer-verified registration, exactly as Step 1
specified: `POST /pricefloor-instances` accepts a claimed contract id,
`registerInstance()` (`services/indexer/src/instances.ts`) independently
confirms over RPC that the contract exists and was deployed from
`PRICEFLOOR_WASM_HASH` (`getContractInstance`, checking
`executable.type === "contractExecutableWasm"` and comparing
`executable.wasmHash`), and only then inserts a `registered` row. No new
on-chain contract was added.

`pollEvents` (`services/indexer/src/poll.ts`) now reads its working set of
contract ids from `pricefloor_instances` on every tick (`loadKnownInstanceIds`)
instead of one fixed env var, so a newly registered instance starts being
polled on the very next cycle, no restart required.

## Schema changes

One new table, `pricefloor_instances`, added to `services/indexer/src/db/schema.sql`
exactly as Step 1 specified (see that file for the full column list and
comments): `contract_id` primary key, nullable
`farmer`/`buyer`/`commodity`/`floor_price`/`notional`/`maturity_ts` (filled
in once `Initialized` is observed), nullable `settlement_token`/`oracle_contract_id`
(see below), and per-transition timestamp columns. `pricefloor_events`
needed no column changes: it already carried `contract_id` per row.

**One deviation from Step 1's plan, in a good direction**: Step 1
documented `settlement_token`/`oracle_contract_id` as a real gap, to be
left `NULL` and closed in a later step, because it required verifying
Soroban's exact `DataKey` XDR encoding against a real instance first. This
step did that verification live (see "Real Testnet evidence" below) and
implemented it: `readInstanceStorageFields`/`enrichInstanceStorage`
(`instances.ts`) read a contract's own instance storage directly
(`getContractInstance(...).storage`) and decode both fields, confirmed
correct against real data. Both columns are populated in practice now, not
left for a future step.

## Migration strategy

No new tooling: `schema.sql` stays a single idempotent file, matching this
project's existing convention (`migrate.ts` just re-runs it). Verified
safe on:

- **A fresh database** (`agrifeed_migration_check`, created empty): `migrate()` succeeds, `pricefloor_instances` exists afterward.
- **An already-migrated database**: running `migrate()` twice in a row on the same database succeeds both times (also covered by an automated test, `db/schema.test.ts`).
- **A real, long-running, already-populated database**: applied directly to this project's own `agrifeed` Postgres database (real historical `commodities`/`price_history`/`nodes`/`node_submissions`/`price_finalizations`/`pricefloor_events` rows from earlier phases), live, while its indexer process kept running. No data loss, no downtime beyond the process's own routine restarts.

**A genuine bug was found this way, not hypothesized**: that real database's
`pricefloor_events` table had been created *before* an earlier session's
F-07 fix corrected `event_type`'s allowed values from the contract's
function names (`initialize`/`fund`/`settle`/`cancel`) to the real event
names (`initialized`/`funded`/`settled`/`cancelled`). `CREATE TABLE IF NOT
EXISTS` never touches an already-existing table's constraints, so that
database had silently kept the *old, wrong* CHECK constraint ever since:
every real PriceFloor event insert on it had been failing and getting
swallowed by `pollEvents`' per-event `try/catch` the whole time, with no
symptom beyond an empty table. Confirmed with a full stack trace
reproducing the exact failure against the real database, then fixed:
`schema.sql` now runs an unconditional `ALTER TABLE ... DROP CONSTRAINT IF
EXISTS ... ADD CONSTRAINT ...` for this constraint on every `migrate()`
call, so it always converges to whatever the file currently says regardless
of when the table was first created. Regression-tested in
`db/schema.test.ts` by recreating the stale constraint and proving
`migrate()` self-heals it. This bug predates Phase 4 and is unrelated to
multi-instance discovery specifically, but blocked verifying this step
honestly, so it was fixed rather than routed around.

## Compatibility behavior

The fixed legacy instance (`PRICEFLOOR_CONTRACT_ID`) is still recognized
purely by `env.pricefloorContractId` equality, exactly as before Phase 4:
it is never required to go through `registerInstance`. `isKnownPriceFloorInstance`
checks the legacy id first, then falls back to a `pricefloor_instances`
lookup.

## RPC assumptions

Two assumptions, both isolated behind small functions in `instances.ts`
rather than inlined, per the task's own instruction:

1. **`getEvents` contract-id limits**: cited from developers.stellar.org's
   getEvents API reference (fetched during this step): "Maximum 5 contract
   IDs are allowed per request" and "Maximum 5 filters are allowed per
   request." `buildEventFilters` spreads known contract ids across up to 5
   filter objects of up to 5 ids each (25 total per `getEvents` call),
   warns and truncates rather than silently dropping ids beyond that.
   `MAX_CONTRACT_IDS_PER_FILTER`/`MAX_FILTERS_PER_REQUEST`/`MAX_CONTRACT_IDS_PER_REQUEST`
   are exported constants, one place to revisit if this ever needs to
   scale past 25 watched PriceFloor instances (not attempted in this
   step).
2. **`DataKey` XDR encoding for reading instance storage directly**:
   confirmed live (not assumed from soroban-sdk convention alone) against
   a real deployed instance that a fieldless enum variant like
   `DataKey::Oracle` encodes as `ScVal::Vec([ScVal::Symbol("Oracle")])`.
   `readInstanceStorageFields` is pure and unit-tested against that exact
   real-confirmed shape.

**A third, previously-undocumented gap was discovered live and fixed**:
the shared events cursor (`indexer_cursor`) only ever moves forward, so a
newly registered instance whose real `Initialized` event already happened
*before* registration (the common real case: deploy, initialize, then
register) would never be seen by the main cursor-based poll, since that
past ledger range is already behind the cursor by the time the instance
becomes known. Confirmed live: two real instances, deployed/initialized
~20 minutes before being registered, were invisible to several ticks of
the main poll for exactly this reason. Fixed with
`backfillRegisteredInstance`: a separate, one-off `getEvents` call scoped
to a single still-`registered` contract id, using the same
`FRESH_CURSOR_LOOKBACK_LEDGERS` (9000 ledgers, ~12.5 hours) window
`loadStartLedger` already relies on for a brand-new cursor, run every tick
for any instance still stuck at `registered` (and, separately, for the
legacy instance if it has no `pricefloor_instances` row yet). This never
touches the shared cursor, so it cannot disturb the main poll's own
continuity.

## Test evidence

**81 tests pass across the workspace** (`pnpm test`): 27 SDK, 19 web, 35
indexer (up from 10 before this step). New indexer coverage:

- `instances.test.ts` (17 tests): pure `chunkContractIds`/`buildEventFilters`
  tests including the documented 25-id ceiling and truncation-with-warning
  behavior; pure `readInstanceStorageFields` tests using the real,
  empirically-confirmed storage shape; DB-only `loadKnownInstanceIds`/
  `isKnownPriceFloorInstance` tests; and five **live-RPC integration
  tests** against real Testnet contracts (this project's established
  no-mocks convention extended to registration itself, since verifying a
  real contract *is* the whole point of `registerInstance`): a real,
  correctly-deployed instance registers successfully; registering it twice
  is idempotent; a syntactically invalid id is refused without any RPC
  call; an unconfigured `PRICEFLOOR_WASM_HASH` refuses; and the real Oracle
  contract (exists, but wrong wasm) is correctly refused.
- `poll.test.ts` additions (6 new tests, using two genuinely, independently
  deployed and initialized real Testnet fixtures, see below): two
  instances indexed without state bleeding between them; events isolated
  by `contract_id`; status advances (`funded`/`settled`/`cancelled`)
  independently per instance; re-processing the same event twice is
  idempotent (exactly one row each); an `Initialized` event from a real
  but never-registered contract is rejected; the legacy fixed instance
  still indexes correctly without ever appearing in `pricefloor_instances`
  first.
- `db/schema.test.ts` (3 tests): `migrate()` twice in a row is safe; the
  stale-constraint self-heal regression test described above.

## Real Testnet acceptance evidence

**No mocked or fabricated chain state.** Two genuinely, independently
deployed and initialized AgriPriceFloor instances, created via the
`stellar` CLI against real Testnet (matching `agrifeed-contract/docs/testnet-deployment.md`'s
own documented two-party-with-local-keys flow, CLI/SDK signing, distinct
from and not a substitute for the still-unresolved browser/Freighter
ADDRESS_V2 limitation tracked separately):

| | Instance 1 | Instance 2 |
|---|---|---|
| Contract id | `CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN` | `CC4YDCQJL4PYXJGC3QSPW3WXNQMEVL6QDJEHH3E556EOEEPUN4RVC6P7` |
| Farmer | `GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62` | `GDWU5YGNHNL3ZW35732OU5C2ORTNYFM32YVL2LMTC4UAWHXFS3MNTW7T` |
| Buyer | `GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3` | `GABZIONIHNKUA2YLWDWESPJC7R23UQJ2GPM6CM4RSZJQ7VZ73WQ25AES` |
| Commodity | COCOA | COFFEE |
| Floor price | 61880000000 | 48950000000 |
| Notional | 10000000 | 5000000 |
| Maturity | 1791626527 | 1792922556 |
| Initialize tx | `87e9b50c0150122c187d263b45d9cae4001f21dcd7482588328e311a48986283` | `5cb837d1300bd962fbf3b617cb9e213a4af97adfd7e16b3b2ff46022997ba6c5` |
| Funded | yes, tx `03a0bb979878f4a8d2819b4432bcacde37cedb365c1dc1f3100929b308158b5d`, amount 100000000 | no |

Both registered against a live-running local indexer instance
(`POST /pricefloor-instances`, real wasm-hash verification against real
RPC data, both accepted). After the next poll cycle (including the new
backfill path), `GET /pricefloor-instances` returned **exactly** the terms
above for both instances, with no cross-contamination:

- Instance 1: `status: "funded"`, correct farmer/buyer/commodity/floorPrice/notional/maturityTs, `settlementToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"` (real native-XLM SAC, matching what was actually passed to `initialize`), `oracleContractId: "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T"` (the real deployed Oracle, also matching what was passed).
- Instance 2: `status: "initialized"`, same correctness, `fundedAt: null` (correctly never funded).
- `GET /pricefloor-instances?farmer=<instance 1's farmer>` returned exactly instance 1, nothing else.
- `GET /pricefloor-instances?buyer=<instance 2's buyer>` returned exactly instance 2, nothing else.
- `GET /pricefloor-instances/:contractId` and a 404 for an unregistered real contract id both verified directly.

Every value above was cross-checked against a direct, independent RPC read
(`getContractInstance`, inspected separately from the indexer entirely)
before trusting the indexed result, not merely "the endpoint returned
200."

**Legacy instance**: also covered by the new backfill path (it has no
`pricefloor_instances` row via registration, so it now gets the same
one-off catch-up query). Live result: 0 events found within the 9000-ledger
lookback window, its original `Initialized` event predates this
window (it was deployed in an earlier phase of this project, days before
this step). This is a real, honestly-observed limitation of Soroban RPC's
rolling event retention, not a bug: there is no way to retroactively index
an event older than the RPC's retention window without a full-archive
node, which this project does not run and this step does not add. Any
future event on the legacy instance (a real `fund`/`settle`/`cancel` call
from here on) will be caught normally, by either the main poll or this
same backfill path.

## Remaining limitations

- The legacy instance's historical `Initialized` terms (farmer/buyer/commodity/etc.) cannot be recovered, per the retention-window limitation above. Its bare existence and any future event on it are still handled correctly.
- The 25-contract-id-per-`getEvents`-call ceiling (5 filters × 5 ids) is not solved, only documented and defended against with a warning; scaling past it needs either batched sequential `getEvents` calls with per-batch cursor tracking, or accepting a lower polling frequency for the overflow, neither attempted here.
- `settlement_token`/`oracle_contract_id` enrichment depends on a second RPC round-trip (`getContractInstance`) per instance per tick until both are filled in; for a large number of simultaneously-registering instances this adds real RPC load, not load-tested at scale here.
- No "My Deals" UI, no settlement/cancel UI, no new on-chain contract: all correctly out of scope for this step, per the task's own constraints.
- The browser/Freighter ADDRESS_V2 signing limitation (Phase 3 Step 7) is unrelated to and unaffected by this step; this step's real E2E evidence used CLI/SDK signing with locally-held keys, not the browser path, and this report does not claim otherwise.

## Files changed

```
 .env.example                             |   6 +
 services/indexer/src/api/server.ts       | 106 +++++++++++
 services/indexer/src/db/schema.sql       |  85 ++++++++-
 services/indexer/src/env.ts              |  27 ++-
 services/indexer/src/poll.test.ts        | 362 ++++++++++++++++++++++++++++
 services/indexer/src/poll.ts             | 190 ++++++++++++++++---
 services/indexer/src/db/schema.test.ts   |  75 (new)
 services/indexer/src/instances.test.ts   | 239 (new)
 services/indexer/src/instances.ts        | 233 (new)
 services/indexer/vitest.config.ts        |  16 (new)
```

No changes to `apps/web`, `packages/sdk`, `services/node-relayer`, or
`agrifeed-contract`. No dependency changes.
