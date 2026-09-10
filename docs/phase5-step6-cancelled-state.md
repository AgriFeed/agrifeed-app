# Phase 5 Step 6: PriceFloor Cancelled Storage-State Audit

**Baseline**: `agrifeed-app` `origin/main` at `df83057`;
`agrifeed-contract` `origin/main` at `28a289e`. This step touches both
repositories: the contract fix lives in `agrifeed-contract`, the
indexer-side reconciliation lives in `agrifeed-app`.

## Verdict: **PASS** (contract fix + indexer diagnostic), with an
**explicit, unchanged limitation**: live `cancel()` remains unverified

The storage-field implementation itself is real, tested, and verified
live on Testnet through initialize. Live `cancel()` — the 48-96 hour
grace-period wait — was correctly **not** attempted, per this step's own
instruction not to claim that evidence without actually satisfying those
conditions. That limitation is unchanged from Phase 4 Step 4 and Phase 5
Step 1; nothing in this step resolves it, and nothing here claims
otherwise.

## Audit findings (established before any code was written)

### 1. Exact current `cancel()` authorization rules

Read directly from `contracts/agripricefloor/src/lib.rs` before changing
anything: `caller.require_auth()`, then `caller` must equal the stored
`Farmer` or `Buyer` (else `Error::Unauthorized`), then `Settled` must be
`false` (else `Error::AlreadySettled`), then a grace-period check that
branches on `Funded`:
- **Unfunded**: `now >= maturity + UNFUNDED_CANCEL_GRACE` (48h), else
  `Error::GracePeriodNotElapsed`.
- **Funded**: `now >= maturity + SETTLE_FAILURE_GRACE` (96h total past
  maturity) **and** the oracle still has no price for the commodity, else
  `Error::GracePeriodNotElapsed`.

### 2. Exact current storage mutations performed by `cancel()`

Funded branch: transfers the full token balance to the buyer, then
`DataKey::Funded → false`. Unfunded branch: no storage mutation at all
("nothing was deposited, so there is nothing to refund," per the
contract's own comment). Both branches then call `extend_instance` and
publish `Cancelled`. **No flag was set anywhere recording that a
cancellation happened** — this is the exact gap Phase 4 Step 4 already
identified and this step closes.

### 3. Exact `Cancelled` event payload

```rust
#[contractevent]
pub struct Cancelled {
    #[topic]
    pub caller: Address,
}
```

One field, the caller — confirmed unchanged by this step (see
"Compatibility analysis" below).

### 4. How `Funded` and `Settled` are represented in storage

Both are plain `DataKey` variants (`DataKey::Funded`, `DataKey::Settled`)
holding a `bool`, read with `.unwrap_or(false)` everywhere they're
checked — so their *absence* (never yet written) and an explicit `false`
are indistinguishable from each other, and both mean "not yet." This is
the same pattern `DataKey::Cancelled` now follows, and exactly why a
funded-then-cancelled instance's `Funded` flipping back to `false`
collapses into "looks like it was never funded" — confirmed by reading
`cancel()`'s own funded branch, which does exactly that.

### 5. Whether adding `DataKey::Cancelled` can be backward-compatible

Yes, confirmed two ways, not assumed:

- **At the type level**: `#[contracttype] pub enum DataKey` is a
  fieldless-variant enum; each variant is XDR-encoded independently by
  its own name (`ScVal::Vec([ScVal::Symbol(variant_name)])`, the same
  encoding empirically confirmed for `Oracle`/`SettlementToken` during
  Phase 4 Step 2). Adding a new variant does not change the encoding of
  any existing variant, so it cannot corrupt or reinterpret any storage
  an already-deployed instance has already written.
- **At the deployment level**: confirmed live this step (see "Testnet
  evidence") — a real instance deployed from the *updated* wasm and
  initialized with real terms shows every pre-existing field
  (`Farmer`/`Buyer`/`Commodity`/`FloorPrice`/`Notional`/`Maturity`/
  `Oracle`/`Funded`/`Settled`/`SettlementToken`) reading exactly as
  before, with `Cancelled` simply absent until actually cancelled.

### 6. Whether existing instances need migration, or can safely rely on the event

**Cannot be migrated, and do not need to be**: Soroban contracts have no
in-place upgrade mechanism (confirmed by `agrifeed-contract`'s own
source, `grep -rn "upgrade"` across both contracts returns nothing —
the same finding [Phase 5 Step 1](./phase5-readiness-and-scope.md)'s
audit already made, C4). Every one of the 4 real instances currently
registered with this project's indexer is running the *old* wasm forever
and will never have this flag, regardless of what this step ships. They
continue to rely purely on the `Cancelled` event, exactly as before —
this step changes nothing about their behavior, for better or worse.

### 7. How the indexer should reconcile old and new instances

Decided, implemented conservatively (see "Implementation decision"):
read the flag where the indexer already reads instance storage for
another reason (the existing settlement-token/oracle enrichment pass),
and treat its presence as a **diagnostic cross-check only** — logged if
it ever disagrees with the indexed `status`, never used to set `status`
itself. An old instance never has the key at all, which reads
identically to "not observed," so no special-casing by wasm version or
instance age was needed: the same code path is correct for both.

### 8. Whether generated bindings change

**They would, but were not regenerated** — see "Generated bindings"
below for the reasoning.

### 9. Required contract tests

Identified before writing any implementation: unauthorized cancel must
still fail and must not set the flag; a valid unfunded cancel and a valid
funded cancel must each set it; other fields (`Funded`, `Settled`,
collateral balances) must remain exactly as they were before this change;
calling `cancel` again after a successful cancel must behave exactly as
it did before (no new guard added). All four are now real tests, listed
below.

### 10. Required real Testnet verification

Identified before implementing: deploy the updated wasm for real,
initialize a real instance, confirm the flag reads correctly (absent)
via a real RPC storage read, and confirm the indexer's own decoding
function handles that real data correctly — all achievable without
waiting on the grace period. Actually calling `cancel()` live was
identified up front as **out of scope for this step's Testnet evidence**,
per the explicit 48-96 hour constraint.

## Compatibility analysis

| Aspect | Before | After | Compatible? |
|---|---|---|---|
| `cancel(caller: Address)` signature | 1 argument | unchanged | Yes — confirmed live via `stellar contract invoke ... cancel --help` against the new instance, identical output. |
| `Cancelled` event shape | `{ caller: Address }` | unchanged | Yes. |
| `Funded`/`Settled`/all other `DataKey` variants' encoding | fieldless-variant XDR | unchanged | Yes — a new enum variant does not alter existing variants' encoding. |
| Existing deployed instances | rely on events only | unchanged, forever (no upgrade path) | Yes, by construction — nothing about them changes. |
| Contract's exported functions | `cancel`, `fund`, `initialize`, `settle` | same 4, confirmed via `stellar contract build`'s own "Exported Functions" report | Yes. |
| Contract's on-chain spec | — | `DataKey` (including the new `Cancelled` variant) is present in the spec, confirmed via `stellar contract info interface` | Expected: `#[contracttype]`-declared types are always written into a contract's own spec, whether or not a public function actually takes them as an argument (unlike an *imported* type, which is not — see `agrifeed-contract`'s own testnet-deployment.md note on `Asset`). This does not affect any caller: no public function takes or returns `DataKey`. |

## Proposed storage model

Exactly the smallest possible addition: one new fieldless `DataKey`
variant, set once, unconditionally, in both branches of `cancel()`,
alongside (not instead of) the existing event:

```rust
// types.rs
pub enum DataKey {
    // ... existing variants, unchanged ...
    Settled,
    Cancelled,
}
```

```rust
// lib.rs, cancel(), immediately before extend_instance/Cancelled.publish
env.storage().instance().set(&DataKey::Cancelled, &true);
```

No new error variant, no new guard, no change to any existing
authorization or grace-period check.

## Implementation decision: justified, implemented

### Contract (`agrifeed-contract`)

- `contracts/agripricefloor/src/types.rs`: added the `Cancelled` variant,
  documented.
- `contracts/agripricefloor/src/lib.rs`: `cancel()` now sets it
  unconditionally in both branches; the `Cancelled` event's own doc
  comment updated to explain what the new flag closes and what it cannot
  help (an already-deployed instance).
- `contracts/agripricefloor/src/test.rs`: 4 new tests (see below).

### Tests added (contract), proving exactly what was required

- `test_cancel_unauthorized_still_fails_and_never_sets_cancelled` —
  unauthorized cancel still returns `Error::Unauthorized`, and the flag
  (read directly from instance storage via `env.as_contract`, since
  AgriPriceFloor exposes no public getter) is confirmed never set.
- `test_cancel_unfunded_sets_cancelled` — a valid unfunded cancel sets
  the flag, and leaves `Funded`/`Settled` exactly as they were (`false`).
- `test_cancel_funded_sets_cancelled_and_preserves_other_fields` — a
  valid funded cancel sets the flag, and the pre-existing behavior
  (`Funded → false`, full collateral refunded, `Settled` left `false`) is
  confirmed unchanged — the same lines this step's own audit (§4 above)
  identified as the reason the flag is needed in the first place.
- `test_cancel_repeated_after_success_still_succeeds_unchanged` —
  calling `cancel` a second time, from the other party, still succeeds
  exactly as before (no new "already cancelled" guard was added,
  matching the instruction to leave established lifecycle semantics
  alone); the flag remains `true` after both calls.

All 22 `agripricefloor` tests pass (18 pre-existing, unchanged, + 4
new); all 28 `agrifeed-oracle` tests pass, unaffected; `cargo fmt --all
-- --check` and `cargo clippy --workspace --all-targets -- -D warnings`
both pass clean.

### Indexer (`agrifeed-app`, `services/indexer`)

`readInstanceStorageFields` (`instances.ts`) now also decodes
`DataKey::Cancelled` into a new `cancelledFlagObserved: boolean` field —
confirmed against real on-chain data this step (see "Testnet evidence"),
decoding the same way every other fieldless `DataKey` variant already
does. `enrichInstanceStorage` uses this, at the same point it already
makes one RPC round trip per instance for the pre-existing
settlement-token/oracle enrichment, to log a warning (`logger.warn`,
never a silent no-op and never a write to `status`) if the flag is ever
observed `true` while the indexed `status` is not already `'cancelled'`
— a real, actionable signal that a `Cancelled` event may have been
missed, exactly the gap [Phase 4 Step 4](./phase4-step4-lifecycle-and-decision.md)'s
Q14 described. **`status` itself is never set from this check**:
cancellation remains exclusively event-derived, unchanged, per this
step's own explicit instruction not to remove event-based cancellation
or infer it solely from the flag.

**Deliberately not built**: a comprehensive, ongoing reconciliation loop
that re-checks every non-terminal instance's storage on every poll tick
forever. The enrichment pass this step hooks into only ever runs once per
instance (until `settlement_token`/`oracle` are both known — see
`loadInstancesNeedingEnrichment`), so this is a real but incomplete
safety net: an early, low-cost, no-new-RPC-load cross-check, not full
coverage of the gap for the rest of an instance's life. Building the
fuller version would mean a new poll pass making a fresh RPC call per
non-terminal instance on every tick, forever, for a scenario with zero
observed occurrences to date (no polling outage has ever actually
happened in this project's history) — exactly the "speculative
engineering over real evidence" this project's own Phase 5 principles
argue against. **Deferred, not implemented**, documented here rather
than silently skipped.

### Tests added (indexer)

- `readInstanceStorageFields` gained 2 new tests: decodes
  `Cancelled: true` correctly; correctly reports `cancelledFlagObserved:
  false` (not an error, not a guess) when the key is simply absent, the
  exact shape every legacy instance's storage has and always will have.
- The 2 pre-existing tests asserting this function's return shape were
  updated (not weakened) to include the new field — this is the only
  change to any pre-existing test, and it is purely additive (the
  existing assertions about `settlementToken`/`oracleContractId` are
  unchanged).
- `enrichInstanceStorage`'s new warning-log branch was **not** given its
  own automated test: producing the real precondition (a genuinely
  cancelled instance whose indexed status has fallen behind) requires
  either the actual 48-96 hour live wait this step explicitly does not
  attempt, or fabricating a "cancelled" storage state the contract itself
  would never actually produce outside a real cancellation — either
  would violate this project's own no-mocked-chain-state convention more
  than it would prove anything. The branch's correctness follows directly
  from the already-tested `readInstanceStorageFields` (which it calls
  unchanged) plus a trivial, visually-inspectable `if` — disclosed here
  rather than padded with a low-value test.

Full suite: **139 tests** (41 SDK + 43 web + 55 indexer, up from 137 —
+2 indexer, both new, none removed or weakened). `pnpm typecheck`,
`pnpm lint`, and `pnpm build` all pass across the whole `agrifeed-app`
workspace.

## Generated bindings

`agrifeed-contract/packages/sdk/generated/pricefloor/src/index.ts` (a
committed, example TypeScript client generated once, in an earlier
phase, against the *legacy* fixed instance
`CDHPDF4TZDJVBFGSOGVTNEKQNNJQR326JSATYXY7ZWD63L6PS2NTJB47`) already
exports a `DataKey` type and is now, strictly, one variant behind the
updated wasm. **Not regenerated this step**, for two concrete reasons:

1. Regenerating bindings targets one specific *deployed instance's* own
   on-chain spec (`stellar contract bindings typescript --contract-id
   <instance>`) — regenerating against the same legacy instance id would
   reproduce byte-identical output, since that instance still runs the
   unchanged old wasm and always will. A regeneration that actually shows
   `Cancelled` would need to target a *new* instance built from the
   updated wasm (such as the one this step deployed for verification) —
   but nothing in `agrifeed-app`'s real, hand-written SDK
   (`packages/sdk/src/pricefloor.ts`, etc.) consumes these generated
   bindings at all; they exist in `agrifeed-contract` purely as the proof
   testnet-deployment.md's own step 12 describes ("a clean generation
   with no `Missing Entry` error... is the real proof that an external
   caller can build valid calls"), not as a real dependency of this
   product.
2. `DataKey` is not, and was never, part of any public function's
   argument or return type — its presence in the generated file is
   incidental completeness (the bindgen tool exports every
   `#[contracttype]` the spec declares), not something any real caller
   reads or writes through these bindings.

Regenerating remains a cheap, safe thing to do whenever this project
next deploys a *real* new demo/legacy instance from the updated wasm;
doing it now, against nothing that would actually use it, would be
exactly the "regenerate bindings only if actually required" this step's
own instructions warned against.

## Testnet evidence

A real, fresh instance was deployed from the *updated* wasm and put
through its normal (non-cancel) lifecycle for real, on Testnet, this
step:

| | Value |
|---|---|
| Updated wasm hash | `5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b` (was `05faa5704ac6f8fe0d21268b16782315a6573946bc6ab40b8277faf70eb43d53`) |
| New instance | `CBNCQWUFRDNH75SFPSWJCXY3NHA7RUM3G6U4N2ITOPXDMHBFMHV63PAF` |
| Deploy tx | `56b40be21510c71d4211dd0cd9b380fbe5c89f76ba6c4f1e57587911cc1313d0` |
| Initialize tx | `313fbb938248c7aac28a051baf0377ff1bde932028e6f37132181533c4caa2d2` |

Real farmer/buyer/commodity/floor price/notional/maturity/settlement
token/oracle passed, and independently re-confirmed by a fresh, direct
RPC read of the instance's own storage after initialize:

```json
{
  "Buyer": "GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3",
  "Commodity": ["Other", "COCOA"],
  "Farmer": "GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62",
  "FloorPrice": "40000000000",
  "Funded": false,
  "Maturity": "1789055598",
  "Notional": "100",
  "Oracle": "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T",
  "Settled": false,
  "SettlementToken": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

`has Cancelled key: false` — confirmed live, matching the documented
semantics exactly: the flag is genuinely *absent* (not `false`) until a
real cancellation happens.

The indexer's own real `readInstanceStorageFields` function was run
against this same live data (not a constructed test fixture) and
correctly reported `{"settlementToken": "...", "oracleContractId":
"...", "cancelledFlagObserved": false}`.

Also confirmed live: this new-wasm instance is correctly **refused** by
the currently-running indexer's real registration endpoint, since its
configured `PRICEFLOOR_WASM_HASH` still points at the old hash —

```
$ curl -s -X POST http://localhost:4000/pricefloor-instances -d '{"contractId":"CBNCQWUFRDNH75SFPSWJCXY3NHA7RUM3G6U4N2ITOPXDMHBFMHV63PAF"}'
{"error":"contract was not deployed from the configured PriceFloor WASM hash"}
```

This is the correct, unchanged behavior of the existing wasm-hash
verification (Phase 4 Step 2), not a defect: it demonstrates concretely
that adopting the new wasm as this product's actual deploy source is a
separate, deliberate configuration change (`PRICEFLOOR_WASM_HASH` in
`.env.local`/`.env.example`), not something this step does silently.
**That cutover was not performed this step** — the live product
continues deploying new deals from the old wasm hash until a future,
explicit decision to switch.

## Remaining limitation: live `cancel()`

Unchanged from Phase 4 Step 4 and Phase 5 Step 1/3: `cancel()`'s grace
periods (`UNFUNDED_CANCEL_GRACE` = 48h, `SETTLE_FAILURE_GRACE` = 96h
total past maturity) are real, fixed, wall-clock durations with no
fast-forward possible on Testnet. This step did not attempt to wait them
out, and does not claim to have observed a real on-chain `cancel()` call
setting the flag — only the contract's own unit tests (a real Soroban
test environment, not Testnet, with a controllable ledger clock) prove
that. The flag's *presence and correct absence* were verified live; its
*being set by a real on-chain cancel() call* remains exactly as
unverified as `cancel()` itself always has been.

## Files changed

`agrifeed-contract`:
```
contracts/agripricefloor/src/lib.rs    | +19 -1
contracts/agripricefloor/src/test.rs   | +110 -2
contracts/agripricefloor/src/types.rs  | +9
```

`agrifeed-app`:
```
services/indexer/src/instances.ts       | +74 -15
services/indexer/src/instances.test.ts  | +38 -4
docs/phase5-step6-cancelled-state.md    | new (this file)
```

No indexer schema change, no API response shape change, no CI change, no
frontend change. `pricefloor_instances.status` derivation is completely
unchanged: still exclusively event-derived.
