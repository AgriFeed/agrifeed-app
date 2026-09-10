# Phase 4 Step 1: PriceFloor Deal Registry Architecture

Status: architecture audit only. No code changes to the indexer, SDK,
frontend, or contracts were made alongside this document. Everything below
was verified against the actual current source, not assumed.

Sources inspected: `contracts/agripricefloor/src/lib.rs`, `types.rs`,
`errors.rs` (agrifeed-contract); `packages/sdk/src/{deploy,pricefloor,
multiparty,wallet}.ts`; `apps/web/components/NewDealFlow.tsx`;
`apps/web/lib/dealState.ts`; `services/indexer/src/{poll,env}.ts`,
`src/db/schema.sql`, `src/api/server.ts`; `packages/sdk/src/*.test.ts`,
`services/indexer/src/poll.test.ts`; `DESIGN.md`, `PRODUCT.md`,
`apps/web/app/docs/page.tsx`, `agrifeed-contract/docs/testnet-deployment.md`.

## Executive summary

A deployed AgriPriceFloor instance is identified today only by its contract
ID, known only to the browser tab that deployed it, for the lifetime of that
tab. Nothing persists it. This document defines the smallest architecture
that makes a deal durable and discoverable without weakening authorization,
without fabricating data, and **without a new on-chain contract**: the
practical blocker to network-wide discovery (no domain event marks "a new
PriceFloor instance was deployed," see Q4/Q5 below) is solved by
client-initiated, indexer-verified registration, not by adding on-chain
infrastructure. Two real contract-level gaps are identified that limit how
much of a deal can ever be reconstructed from-chain alone (Q13): no getter
for `settlement_token`/`oracle` after `initialize`, and no storage flag that
distinguishes "cancelled" from "never funded." Both are documented as
follow-up candidates, not addressed here.

## 1. How is a newly deployed PriceFloor instance currently identified?

By its contract ID alone, returned synchronously from
`deploy.deployInstance()` (`packages/sdk/src/deploy.ts`) as the
`createCustomContract` operation's return value, decoded with
`scValToNative`. Nothing else names a deal: no salt, no registry entry, no
deterministic derivation the caller doesn't already have from the call's own
return value. `NewDealFlow.tsx` stores it in `DealState.contractId`
(`apps/web/lib/dealState.ts`), which lives only in that component's React
state for that tab (`DealPersistenceNotice` exists specifically to warn
about this). Once the tab closes, the ID is gone unless a human copied it
via `IdentifierDisplay`'s copy affordance.

## 2. On-chain evidence per field

Confirmed directly against `contracts/agripricefloor/src/lib.rs` and
`types.rs`. "Event" means a `#[contractevent]` a caller (or an indexer
watching the contract) can subscribe to; "storage only" means it exists in
instance storage (`DataKey`) but the contract exposes no getter function to
read it back, so it is reachable only via a raw ledger-entry read.

| Field | Evidence | Notes |
|---|---|---|
| Deployment | The `createCustomContract` operation, in the transaction that submitted it | No dedicated event. Discoverable only if you already know the transaction, or simply by successfully simulating a call against the resulting contract ID |
| Initialization | `Initialized` event (topics: `farmer`, `buyer`; data: `commodity`, `floor_price`, `notional`, `maturity_ts`) | Confirmed field-for-field against the actual `#[contractevent] pub struct Initialized` |
| Farmer | `Initialized` event topic, and `DataKey::Farmer` (storage only, no getter) | |
| Buyer | `Initialized` event topic, and `DataKey::Buyer` (storage only, no getter) | |
| Commodity | `Initialized` event data, and `DataKey::Commodity` (storage only) | |
| Floor price | `Initialized` event data, and `DataKey::FloorPrice` (storage only) | |
| Notional | `Initialized` event data, and `DataKey::Notional` (storage only) | |
| Settlement token | **Storage only** (`DataKey::SettlementToken`), no getter, **not present in any event** | Real gap, see Q13 |
| Maturity | `Initialized` event data (`maturity_ts`), and `DataKey::Maturity` (storage only) | |
| Oracle | **Storage only** (`DataKey::Oracle`), no getter, **not present in any event** | Real gap, see Q13 |
| Funding | `Funded` event (topic: `buyer`; data: `amount`), and `DataKey::Funded` (storage only, bool) | |
| Settlement | `Settled` event (topic: `farmer`; data: `payout`, `market_price`), and `DataKey::Settled` (storage only, bool, set `true` only in `settle()`'s success path, line 377) | |
| Cancellation | **`Cancelled` event only** (topic: `caller`; no other data) | `cancel()` never sets any storage flag distinguishing "cancelled" from "never funded" (confirmed: `cancel()` only ever writes `DataKey::Funded = false` in the funded-refund branch, line 488; it touches nothing in the unfunded branch). This is a real reliability gap, see Q13/Q14 |

## 3. Authoritative state vs. derived/indexed state

- **Authoritative**: the contract's own instance storage at query time, for
  every field that has storage backing (everything above except the bare
  fact of deployment). This is always correct for `farmer`, `buyer`,
  `commodity`, `floor_price`, `notional`, `settlement_token`, `maturity`,
  `oracle`, and `funded`/`settled` *as booleans*, but not for
  "cancelled," which storage cannot express (see above).
- **Derived/indexed**: everything the REST API and any future registry
  serve is a copy, reconstructed by watching events over time (see
  `services/indexer/src/poll.ts`'s existing doc comments on why
  `contributing_nodes` is reconstructed rather than read from a single
  event). A "cancelled" status is necessarily **event-derived only**: it
  cannot be re-verified from a storage snapshot after the fact, since
  storage carries no "cancelled" bit. This means the indexer's cursor
  continuity is load-bearing for that one specific status in a way it isn't
  for the others (see Q14).
- The client's own `DealState`/`DealStatus` (`apps/web/lib/dealState.ts`)
  is neither: it is pure, ephemeral, single-tab UI-flow state for the
  *pre-confirmation* signing sequence (`draft` → … → `confirmed`/`failed`)
  and has no representation for `funded`/`settled`/`cancelled` at all (those
  are tracked separately, as a local boolean, in `DemoFlow.tsx`). It must
  never be treated as a source of truth for a persisted Deal entity; see Q7.

## 4. How can the indexer discover arbitrary PriceFloor instances?

Two paths exist; only one is practical.

**Network-wide scanning (rejected).** There is no operation- or
protocol-level event that marks "a contract was deployed from wasm hash X."
`getEvents` filters by `contractIds` or `topics`, not by wasm hash, and
scanning every contract creation on the network to find the ones that
happen to match AgriPriceFloor's wasm hash is not something a lightweight
polling indexer against a public RPC endpoint can do reliably: public RPC
event retention is a rolling window (not full history), and there is no
cheap, targeted filter for "show me every `createCustomContract` for this
wasm hash" in the current API surface. This path is rejected as
impractical, not merely inconvenient.

**Client-initiated, indexer-verified registration (recommended).** The
deploying frontend is the one party that always, deterministically, knows a
new instance's contract ID the moment `deploy.deployInstance()` returns.
The indexer already proves the pattern needed here: `poll.ts` already
accepts an array of `contractIds` in its `getEvents` filter
(`env.pricefloorContractId` today is a single configured ID, but the
underlying call already takes `string[]`), and `pricefloor_events` already
stores a `contract_id` column per row rather than assuming one global
instance. The only real gap is that the set of contract IDs poll.ts watches
is currently fixed at process start from one env var, not grown at runtime
from a table of known instances.

The proposed flow: the frontend calls a new indexer endpoint immediately
after a successful deploy with the claimed contract ID. The indexer never
trusts this claim blindly (that would be exactly the "fabricated contract
state" this task rules out): it verifies the claim independently over RPC
(the contract exists, and was created from `PRICEFLOOR_WASM_HASH`) before
persisting a row, then adds the ID to the working set `pollEvents` includes
in its next `getEvents` call. This is "deterministic discovery" in the
sense the task asks about: discovery is deterministic from the deploying
session's own knowledge, not probabilistic chain-scanning, and every
registered ID is independently confirmed before being trusted.

**Honest limitation this leaves**: a PriceFloor instance deployed entirely
outside this app (e.g. directly via `stellar contract deploy` from the
testnet-deployment.md guide) will never be registered or indexed unless
someone separately submits it through the same endpoint. This is
acceptable for this product's actual usage pattern (deals are created
through the app) and is documented here rather than silently assumed away.

## 5–6. Is a new on-chain DealRegistry contract required?

**No**, and one should not be added. The blocker identified in Q4 is a
*discovery* problem (how does the indexer learn a contract ID exists),
not a *trust* problem (once the indexer has a contract ID, reading and
verifying its real state over RPC is already fully reliable, no different
from how the indexer already trusts `ORACLE_CONTRACT_ID`/
`PRICEFLOOR_CONTRACT_ID` today). A registry contract would solve discovery
too, at the cost of: a new contract to design, audit, deploy, and maintain
across `agrifeed-contract`; a new required transaction on every deploy
(register-with-contract, rather than register-with-indexer); and a new
single point of failure (if the registry contract has a bug or its own
storage limits, every deal indirectly depends on it). Client-initiated,
indexer-verified registration achieves the same durable multi-instance
discovery with none of that new surface area, using infrastructure
(`pricefloor_events`'s per-row `contract_id`, `getEvents`'s array filter)
that already exists. This satisfies "prefer the smallest architecture that
provides durable multi-instance discovery" directly.

## 7. Canonical Deal entity and lifecycle states

A **Deal** is the durable, server-side record of one AgriPriceFloor
instance, keyed by contract ID, distinct from and a superset of
`dealState.ts`'s `DealStatus` (which only covers the pre-confirmation
signing UX in one browser tab and has no representation past
`confirmed`). Proposed states, each with its real on-chain evidence:

| Deal status | On-chain evidence | Notes |
|---|---|---|
| `registered` | Client-submitted, indexer-verified deploy (contract exists, correct wasm hash) | Pre-initialize; contract has no `Initialized` event yet |
| `initialized` | `Initialized` event observed for this contract ID | Farmer/buyer/commodity/floor_price/notional/maturity now known from the event; `settlement_token`/`oracle` require a supplementary storage read (Q13) |
| `funded` | `Funded` event observed | |
| `settled` | `Settled` event observed, and `DataKey::Settled` storage confirms `true` | Both signals agree; either alone would be acceptable, but requiring the event (which the indexer already needs for `payout`/`market_price`) is sufficient |
| `cancelled` | `Cancelled` event observed | **Event is the only signal that exists** (Q2); must never be inferred from storage |
| `unresponsive` (diagnostic, not a real contract state) | No `Funded`/`Settled`/`Cancelled` event well past `maturity_ts` | Surfacing tool for the eventual "My Deals" UI, not a state the contract itself has; explicitly out of scope to build now |

`registered` and `initialized` are the two states this step's registry work
must get right first; `funded`/`settled`/`cancelled` reuse the exact
ingestion pattern `pricefloor_events` already has for the legacy fixed
instance, extended to arbitrary `contract_id` values.

## 8. Database schema

`services/indexer` has no versioned-migration framework: `schema.sql` is a
single idempotent file re-applied by `migrate.ts` on every run. The
proposed addition follows that same convention, no new tooling introduced.

```sql
-- Registered PriceFloor instances (Phase 4). A row here means the indexer
-- has independently verified, over RPC, that this contract ID exists and
-- was deployed from PRICEFLOOR_WASM_HASH -- it is never inserted from a
-- client's claim alone. Farmer/buyer/commodity/floor_price/notional/
-- maturity are filled in once the Initialized event is observed; they are
-- nullable until then, since a registered-but-not-yet-initialized instance
-- is a real, valid state (Q7). settlement_token and oracle require a
-- supplementary ledger-entry read at initialization time, see Q13; both
-- are nullable for the same reason and because that read can fail
-- independently of event ingestion succeeding.
CREATE TABLE IF NOT EXISTS pricefloor_instances (
  contract_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('registered', 'initialized', 'funded', 'settled', 'cancelled')),
  farmer TEXT,
  buyer TEXT,
  commodity JSONB,
  floor_price TEXT,
  notional TEXT,
  settlement_token TEXT,
  maturity_ts TIMESTAMPTZ,
  oracle_contract_id TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at_ledger BIGINT NOT NULL,
  initialized_at TIMESTAMPTZ,
  funded_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pricefloor_instances_farmer_idx ON pricefloor_instances (farmer);
CREATE INDEX IF NOT EXISTS pricefloor_instances_buyer_idx ON pricefloor_instances (buyer);
CREATE INDEX IF NOT EXISTS pricefloor_instances_status_idx ON pricefloor_instances (status);
```

`pricefloor_events` needs **no schema change**: it already carries
`contract_id` per row (see the existing doc comment explaining why: to
disambiguate a genuine PriceFloor `Initialized` from the Oracle's own
identically-named event). `pollEvents`'s handlers for `funded`/`settled`/
`cancelled` already insert whatever `contract_id` the event actually came
from; extending the watched set is a `poll.ts` change (read the working set
from `pricefloor_instances` instead of one env var), not a schema change.

## 9. Avoiding event/topic collisions across multiple instances

Not actually a risk, by construction: every Soroban event carries the
emitting contract's own address (`event.contractId`), independent of how
many other contracts emit an identically-named event. `poll.ts` already
relies on exactly this to keep the Oracle's `Initialized` out of
`pricefloor_events` (comment at `poll.ts` line ~360). The same mechanism
trivially extends to N PriceFloor instances: two different instances each
emitting `Initialized` are never ambiguous, since each row's `contract_id`
column records which one it actually was, and `pricefloor_events`'s
existing `UNIQUE (tx_hash, event_type)` constraint is safe across instances
too (`tx_hash` is unique network-wide regardless of how many contracts a
transaction touches). The only real requirement is that `pollEvents`'s
`getEvents` `contractIds` filter actually includes every known instance,
purely a discovery problem (Q4), not a collision problem.

**Open question to verify before implementation**: Soroban RPC has
historically capped the number of `contractIds` accepted in one `getEvents`
filter (commonly cited as 5 in older RPC versions). This must be confirmed
against the actual configured RPC endpoint before Phase 4 Step 2, and if a
cap exists, `pollEvents` will need to batch across multiple `getEvents`
calls per tick once the registered-instance count exceeds it. Documented
here as unverified rather than guessed.

## 10. REST/API surface

Extends `services/indexer/src/api/server.ts`, matching its existing
plain-Express, no-auth, no-pagination-framework style:

| Endpoint | Purpose |
|---|---|
| `POST /pricefloor-instances` | Client-initiated registration. Body: `{ contractId }`. The indexer independently verifies the contract over RPC before inserting; never trusts the body as fact. Returns the verified row or a 4xx if verification fails. |
| `GET /pricefloor-instances/:contractId` | One deal's full indexed state (the "get a deal" case) |
| `GET /pricefloor-instances?farmer=<address>` | Deals where this address is the farmer |
| `GET /pricefloor-instances?buyer=<address>` | Deals where this address is the buyer |
| `GET /pricefloor-instances` | All registered deals (paginated the same simple way `/commodities/:symbol/history` caps rather than paginates, unless volume proves that insufficient) |

`farmer=`/`buyer=` are two query parameters on one collection endpoint,
not two separate routes, matching the REST API's existing minimal-surface
style rather than introducing a new pattern.

## 11. Frontend recovery after a browser/session restart

Once `GET /pricefloor-instances?farmer=` / `?buyer=` exist and are
populated, a "My Deals" view (explicitly **not** built in this step) could,
after Freighter reconnects, query both parameters for the connected
address and render each match's indexed `status` through the same
`DealStateBadge`/`FundedBadge` vocabulary already established, replacing
reliance on `DealState` React state entirely. Recovery is only possible
from the `registered` status onward, since anything earlier (a draft never
deployed, or a deploy that failed) has no on-chain footprint at all. This
is why Q7 recommends registering **at deploy time**, immediately after
`deployInstance()` returns and before `initialize` is ever attempted, not
only after `initialize` succeeds: an instance deployed but abandoned before
initialization is still real, still costs the deployer's account
reserve, and should still be recoverable/inspectable rather than silently
lost the way it is today.

## 12. What must never be reconstructed from client-local state

Once a contract ID is registered, every field describing the deal's real
terms and status (`farmer`, `buyer`, `commodity`, `floor_price`,
`notional`, `settlement_token`, `maturity_ts`, `oracle`, and every status
transition) must come from independently verified on-chain data (an
observed event, or a direct ledger-entry/simulated read), never from the
client's submitted draft or its local `DealState`. The client's POST body
is a **pointer** ("go look at this contract ID"), never itself a claim of
fact, exactly the same discipline this codebase already applies
everywhere else (no fabricated prices, no placeholder data, "source
unavailable" shown honestly rather than guessed).

## 13. Missing contract events or state getters

Two concrete, real gaps, both contract-level, neither addressed here:

1. **No getter for `settlement_token` or `oracle`** after `initialize`.
   Neither appears in the `Initialized` event. The only way to read them is
   a raw instance-storage ledger-entry read (technically possible without a
   contract change, since Soroban instance storage is publicly readable
   given the right `LedgerKey`, but meaningfully more fragile than a
   dedicated getter or a complete event). **Recommended follow-up** (not
   this step): either add both fields to the `Initialized` event, or add a
   `get_state()`-style read function, in a future `agrifeed-contract`
   change.
2. **No storage flag distinguishing "cancelled" from "never funded."**
   `cancel()` emits a `Cancelled` event but writes no corresponding
   storage bit (confirmed by reading its full body). This makes
   "cancelled" the one Deal status this architecture cannot re-derive from
   a state snapshot, only from event history (Q14). **Recommended
   follow-up**: add a `DataKey::Cancelled` bool, set `true` in `cancel()`,
   the same way `settle()` already sets `DataKey::Settled`.

## 14. Can settlement/cancel be indexed reliably?

**Settlement: yes**, from either signal alone, and both exist and agree
(`Settled` event and `DataKey::Settled` storage). **Cancellation: reliable
only as long as the indexer's event coverage is unbroken**, since there is
no storage fallback (Q13 #2). A gap in polling (an outage that outlasts the
RPC's event-retention window before the cursor catches back up) could in
principle cause a cancelled deal to be permanently misreported as merely
"funded, awaiting settlement," with nothing to reconcile against later.
This is a real, documented limitation of the current contract, not
something this indexing architecture can fully close on its own; it is the
direct motivation for the storage-flag follow-up in Q13.

## 15. Minimum real Testnet E2E evidence before calling the registry complete

No mocked data, no simulated chain state. Concretely, before Phase 4's
registry work is called done:

1. A real `deployInstance()` call on Testnet, registered via
   `POST /pricefloor-instances` **before** `initialize` is called, and
   confirmed present with `status = 'registered'`.
2. A real two-party `initialize` (same-session, matching the already
   live-verified F-04 farmer/deploy path), confirmed to transition that
   same row to `status = 'initialized'` with the correct farmer/buyer/
   commodity/floor_price/notional/maturity, cross-checked by hand against
   the real transaction on a Testnet explorer.
3. A real `fund()` call, confirmed to transition the row to `funded`.
4. At least one of `settle()` or `cancel()` exercised live end to end
   (Step 7 already found neither has been live-tested for this project at
   all; this step does not require solving that gap, only that whichever
   one is exercised first is confirmed correctly ingested before either
   is described as "supported by the registry").
5. `GET /pricefloor-instances/:contractId`, `?farmer=`, and `?buyer=` each
   called for real and manually cross-checked against the real on-chain
   state, not just checked for a 200 response.
6. A real reload/new-tab test: after step 2 or later, open a fresh
   browser session, reconnect the same Testnet account, and confirm the
   deal is discoverable via the API by address alone, with no dependency
   on `localStorage`, `sessionStorage`, or any other client-local state
   (none of which this codebase uses for deal state today, and none of
   which this architecture introduces).

## Implementation sequence (Phase 4 Steps 2-7)

This document is Step 1. Proposed sequence for the rest of Phase 4, each
step small enough to validate independently before the next begins:

- **Step 2**: `pricefloor_instances` table (Q8), added to `schema.sql`,
  migrated against a clean database exactly as `CONTRIBUTING.md` already
  requires before any PR.
- **Step 3**: `POST /pricefloor-instances` with real RPC-based verification
  (contract exists, wasm hash matches) before insert; no other endpoints
  yet. Prove step 15 item 1 end to end here.
- **Step 4**: extend `pollEvents` to read its working `contractIds` set
  from `pricefloor_instances` (plus the legacy fixed instance, preserved
  unchanged) instead of one env var; confirm the `getEvents` contract-ID
  cap question (Q9) against the real RPC first. Prove step 15 items 2-3.
- **Step 5**: `GET /pricefloor-instances/:contractId`, `?farmer=`,
  `?buyer=`, and the unfiltered list. Prove step 15 item 5.
- **Step 6**: wire `NewDealFlow.tsx`'s deploy success handler to call the
  new registration endpoint, and prove step 15 item 6 (real reload
  recovery test), still with no "My Deals" UI.
- **Step 7**: settlement/cancellation live-test and ingestion validation
  (step 15 item 4), and a written decision on the two contract-level
  follow-ups in Q13 (whether and when to pursue them), before any "My
  Deals" or settle/cancel UI work begins in a later phase.

Building "My Deals" UI and settle/cancel UI are explicitly out of scope
for all of the above, per this step's constraints, and should not begin
until Step 7 concludes.
