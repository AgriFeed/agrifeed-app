# Phase 4 Step 4: Lifecycle Live-Test and Contract-Gap Decision

Closes out the doc §15 acceptance checklist from
[phase4-pricefloor-deal-registry.md](./phase4-pricefloor-deal-registry.md)
(Step 1) and the doc's own Step 7 scope: exercise `settle()`/`cancel()`
live against the registry, and decide what to do about the two
contract-level gaps that document's §13 identified.

## What this step covers, and what it doesn't

**`settle()`: fully live-tested this step**, real Testnet transactions
end to end, registry ingestion confirmed. **`cancel()`: not live-tested**,
and could not be within this session — see "Why cancel() couldn't be
live-tested" below. This is a deliberate, disclosed scope reduction, not
an oversight: the user was asked and chose "settle only, document cancel
as unverified" over kicking off a real instance that would only become
cancel-eligible in 48-96 hours.

## Real Testnet lifecycle evidence (settle)

A new instance, deployed, registered, initialized, funded, and settled,
all via real Testnet transactions with no mocked or simulated chain
state:

| Field | Value |
|---|---|
| Contract id | `CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272` |
| Farmer | `GCPM65RUTWWMHM2VBCJDLI2CBA3JDPPMG7QGABAW7DYJLLC6NAIIFR62` |
| Buyer | `GC2ZGBULIFV5K5JBNT7DFDBVYFRASYEHX4RHS46LDPFHI2W46CMACTO3` |
| Commodity | COCOA |
| Floor price | 40820949368 (deliberately just above the oracle's live market price, to exercise both the payout and refund branches of `settle()` in one call) |
| Notional | 100 |
| Settlement token | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (native XLM SAC) |
| Maturity | 2026-09-10T12:23:24Z (set ~5 minutes out at initialize time, then genuinely waited for) |
| Deploy tx | `418c28c0107babfcb29cd1392bf7dfc670c2aba01048a1e0414d3b20f208c14a` |
| Register (before initialize) | `POST /pricefloor-instances`, confirmed `status: "registered"` before any terms existed |
| Initialize tx | `0fdf464c752fec2e6fc5c8c95633083949d22c40acc885bac89ca514c9afc1d9` |
| Fund tx | `63e045bb47666b282df362b1b3271f7e1c95a1ede0afbac398ef3f60e3898a71`, amount 200000000 |
| Settle tx | `925c3dfa2ebc4a43f08aeac8f5aa53ac145596d2af45893c63980d88b4890c59`, payout 100000000, market_price 40819949368 |

The payout math matches `settle()`'s own logic exactly: `diff =
40820949368 - 40819949368 = 1000000`, `gross = 1000000 * notional(100) =
100000000`, `funded_amount = 200000000`, so `payout = min(gross,
funded_amount) = 100000000` and `refund = 100000000` — both transfers
(farmer and buyer) actually fired on-chain, confirmed by the CLI's own
event output and independently cross-checked against Horizon
(`transactions/925c3dfa...` returns `successful: true`, and the farmer's
live account balance reflects the payout).

Registry ingestion, confirmed against `GET
/pricefloor-instances/:contractId` at each stage (no polling restart
needed, matching Step 2's design):

1. Immediately after registration, before `initialize`: `status:
   "registered"`, every term field `null`. (§15 item 1)
2. After `initialize` + `fund` (indexer caught up to both in one poll
   cycle): `status: "funded"`, farmer/buyer/commodity/floorPrice/notional/
   settlementToken/oracleContractId all correct, `fundedAt` populated,
   `settledAt: null`. (§15 items 2-3)
3. After `settle()`: `status: "settled"`, `settledAt:
   "2026-09-10T12:23:42.000Z"`, everything else unchanged. (§15 item 4,
   the settle half)
4. `GET /pricefloor-instances?farmer=<real address>` and `?buyer=<real
   address>` both returned exactly this instance (plus the still-open
   Step 2 fixture sharing the same test keys), never conflating farmer
   and buyer or returning unrelated instances. (§15 item 5)

§15 item 6 (reload/recovery via the API alone) was already proven live in
Step 3 and is not repeated here.

## Why `cancel()` couldn't be live-tested this step

Read directly from `agripricefloor`'s `cancel()` (`contracts/agripricefloor/src/lib.rs`
in the `agrifeed-contract` repo), not assumed:

- **Unfunded cancel**: requires `now >= maturity_ts + UNFUNDED_CANCEL_GRACE`,
  where `UNFUNDED_CANCEL_GRACE = 48 * 60 * 60` (48 hours). Fixed, not
  shortenable by picking an earlier `maturity_ts` — the wait is always at
  least 48 hours from whatever maturity is chosen.
- **Funded cancel**: requires `now >= maturity_ts + SETTLE_FAILURE_GRACE`
  (96 hours total past maturity, `SETTLE_FAILURE_GRACE = 48 * 60 * 60`
  stacked on top of maturity itself already having passed) **and** the
  oracle still has no price for the commodity at call time.

Both are real, multi-day waits on a live network with no way to fast-forward
the ledger clock (unlike a local sandbox). Neither fits inside a single
session. The existing indexer test coverage for `cancelled` events
(`poll.test.ts`, "advances funded -> settled -> cancelled..." and "still
indexes funded, settled, and cancelled correctly") is real code exercising
a real code path, but against a **synthetically constructed** `Cancelled`
event, not a transaction the chain actually produced. That gap is
disclosed here explicitly rather than presented as live-verified.

## Contract-gap decision (doc §13)

### Gap 1: no getter for `settlement_token`/`oracle`

**Status: closed, no contract change needed.** Step 2 implemented and
live-verified direct instance-storage reads (`readInstanceStorageFields`
in `services/indexer/src/instances.ts`) as a working substitute, confirmed
again this step (`settlementToken`/`oracleContractId` both populated
correctly on the new instance, matching what was actually passed to
`initialize`). Recommend no follow-up unless a **different**, non-indexer
caller (a block explorer, a third-party integration) needs these fields
without replicating this project's storage-decoding logic — in which case
a dedicated getter is still a better citizen-facing API, but it is not
blocking anything in this codebase.

### Gap 2: no storage flag distinguishing cancelled from never-funded

**Status: open, real severity confirmed and slightly worse than Step 1's
original framing.** Reading `cancel()`'s body (not just its doc comment)
this step turned up a sharper version of the gap than Step 1 could state
without the source in front of it: a **funded** agreement that gets
cancelled has its `DataKey::Funded` flag explicitly reset to `false` (see
`env.storage().instance().set(&DataKey::Funded, &false)` in the funded
branch of `cancel()`). So a cancelled-after-funded instance's storage
snapshot reads as `funded: false, settled: false` — **identical** to an
instance that was registered and initialized but never funded at all.
The ambiguity isn't only "cancelled vs. settled" as Step 1's Q14 framed
it; it also collapses "cancelled after being funded" into "never funded,"
which is a materially different, worse state for anyone trying to
reconcile a deal's history from a point-in-time read rather than full
event history.

This registry already sidesteps the practical impact today: it derives
`status` from `pricefloor_events` (event history), not from a point-in-time
storage snapshot, so an observed `Cancelled` event still updates the row
correctly regardless of this storage ambiguity — **as long as the
indexer's event coverage stays unbroken**, exactly the caveat Step 1's
Q14 already flagged. This step's closer reading doesn't change that
mitigation, only firms up how bad the underlying contract gap is if that
assumption is ever violated (a polling outage that outlasts the RPC's
event-retention window before catching up).

**Recommendation: fix in a future `agrifeed-contract` change**, not this
step (out of scope: no contract changes here, per this step's own
constraints, and a fix cannot retroactively help already-deployed
instances anyway). Add a `DataKey::Cancelled` bool, set `true` in
`cancel()`'s both branches, exactly as `settle()` already does for
`DataKey::Settled` — then a storage snapshot alone becomes sufficient to
tell `cancelled` apart from every other state, closing the reconciliation
gap Q14 described. Priority: moderate, not urgent — the indexer's actual
event-driven design already covers the common case; this only matters
if event coverage is ever broken by an outage.

## Files changed

None. This step is real Testnet acceptance evidence plus a decision
write-up; no application code was touched.
