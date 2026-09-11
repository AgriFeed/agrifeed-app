# Phase 6, Step 4 — Live PriceFloor `cancel()` Verification

**Verdict: UNVERIFIED / WAITING FOR ELIGIBILITY.** A real, unfunded,
Cancelled-flag-bearing PriceFloor instance was deployed and initialized
specifically for this test and is now genuinely progressing toward real
`cancel()` eligibility, but the contract's real 48-hour grace period has
not yet elapsed. No cancel() call was attempted, no timestamp was
manipulated, and no bypass was used.

## Baseline

| Repository | Commit |
| --- | --- |
| `agrifeed-app` | `51036ca` |
| `agrifeed-contract` | `9347841` (current HEAD `190f009` is two CI/doc-only commits past this; zero contract source difference, re-confirmed via `git diff 9347841 190f009 --stat`) |

## `cancel()` contract rules (read from current source, `contracts/
agripricefloor/src/lib.rs`)

1. **Unfunded grace period**: `UNFUNDED_CANCEL_GRACE = 48 * 60 * 60` (48h,
   `lib.rs:34`). Eligible once `now >= maturity_ts + 48h`.
2. **Funded grace period**: `SETTLE_FAILURE_GRACE = 48 * 60 * 60` (also
   48h, `lib.rs:39`) — **not 96h as a single constant**; the "48–96h"
   figure used in earlier project docs describes the *total wall-clock
   range* depending on how `maturity_ts` was chosen relative to
   initialization, not a distinct 96h grace constant. The funded path
   additionally requires the oracle to still have no price for the
   commodity (`oracle_client.lastprice(...).is_none()`) — if the oracle
   has a price, `cancel()` is refused and `settle()` should be used
   instead.
3. **Authorization**: `caller.require_auth()`, then `caller` must equal
   either the stored `Farmer` or `Buyer` address, else
   `Error::Unauthorized`.
4. **Storage fields changed**: `DataKey::Cancelled` set to `true`
   unconditionally, in both branches. If funded, `DataKey::Funded` is also
   reset to `false` and the full collateral balance is transferred back to
   the buyer. If unfunded, no other field changes (nothing was deposited).
5. **Event emitted**: `Cancelled { caller }`.
6. **What `DataKey::Cancelled` does**: write-only diagnostic flag, never
   read anywhere else in the contract — confirmed unchanged from Phase 5
   Step 6 and Phase 6's own prior audits.
7. **`Funded`/`Settled` after cancel**: `Settled` is never touched by
   `cancel()` (an already-`Settled` agreement is refused earlier with
   `Error::AlreadySettled`, before either branch runs). `Funded` is reset
   to `false` only on the funded branch; an unfunded cancel leaves it
   `false` (it already was).
8. **Repeated `cancel()`**: remains possible after a successful cancel —
   no "already cancelled" guard exists; a second call from the other party
   would re-enter the unfunded (now permanently `Funded: false`) branch
   and succeed again, re-setting `Cancelled` to `true` (already `true`)
   and re-publishing the event. Confirmed by the still-passing
   `test_cancel_repeated_after_success_still_succeeds_unchanged` unit
   test (re-run this step, see "Validation" below).
9. **SDK invocation arguments**: `pricefloor.cancel(config, callerPublicKey,
   signAndSend)` → `cancelArgs(callerPublicKey)` → single argument,
   `nativeToScVal(callerPublicKey, { type: "address" })` — unchanged from
   Phase 5 Step 6, re-confirmed by reading `packages/sdk/src/
   pricefloor.ts` this step.

## Smallest safe live-test plan chosen

`initialize()` has **no minimum-maturity validation** (confirmed by
reading the full function body) — `maturity_ts` can legally be set to the
current chain time at initialization, starting the 48h unfunded-grace
clock immediately rather than waiting for some later maturity first. This
is not timestamp manipulation: it uses the real, current ledger time as
the contract's own real notion of "now," and the full 48h grace period
still applies in full afterward, unshortened.

Two already-existing instances from prior phases were considered first
(per this task's explicit preference to reuse an eligible instance rather
than deploy a new one):

| Instance | Source | Unfunded | Maturity | Grace elapsed at? | Usable? |
| --- | --- | --- | --- | --- | --- |
| `CBNCQWUFRDNH75SFPSWJCXY3NHA7RUM3G6U4N2ITOPXDMHBFMHV63PAF` | Phase 5 Step 6 | yes | `1789055598` | `2026-09-13T13:53:18Z` (~25.4h remaining at audit time) | **No** — not yet eligible, and its farmer/buyer signing keypair's secret was never persisted anywhere (an ephemeral throwaway generated during that step and never logged to a retained file) |
| `CDAO5WFFNI4KTRA43BBEIHUE4SKVRPL45DJQ2P7TE7R4NELCLFS7WC7S` | Phase 6 Step 1 | yes | `1789119883` | `2026-09-13T18:24:43Z` (~28.2h remaining) | **No** — same reason, signing secret not persisted |

Neither was eligible, and neither has a recoverable signer, so a new
instance was deployed with `maturity_ts` set to the current chain time at
initialization — minimizing the total future wait to exactly 48h from
this step's own initialize call, the earliest the contract's real rules
allow, and (unlike the two candidates above) with its signing secret
deliberately retained (in the gitignored `.env.local` only — see
"Safety," below) so a future session can actually complete the call once
eligible.

## Test-instance details

Deployed and initialized for real, on Testnet, this step, via the SDK's
own `deploy.deployInstance`/`pricefloor.initialize` (the same functions
the application uses), signed by a freshly generated, friendbot-funded,
throwaway `Keypair` (farmer == buyer, single-signer demo case, matching
this project's established convention for this kind of setup call):

| | Value |
| --- | --- |
| Contract id | `CDXM4NOHCSGQ2UNQC34LE6JEG3OUUZ67PMXA4VUOSMX3BRPRRBW4LE7D` |
| Deployed from wasm | `5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b` (the current, Phase 6 Step 1 cutover wasm) |
| Farmer / Buyer | `GDD6OJCIOJ2N3VVNKDCMOJ7B7HVNNOQH4RS7PGNT2EVI76MVGKHMROHS` (same address, both roles) |
| Commodity / floor price / notional | COCOA / 40000000000 / 100 |
| Settlement token | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Oracle | `CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T` |
| `maturity_ts` | `1789136649` (`2026-09-11T14:24:09Z`, the real chain time at initialize) |
| Funded | **false, deliberately never funded** — testing the unfunded path |

## Grace-period eligibility evidence

- Eligibility timestamp: `maturity_ts + UNFUNDED_CANCEL_GRACE = 1789136649
  + 172800 = 1789309449` → **`2026-09-13T14:24:09Z`**.
- Real current time at the point this report was written:
  `2026-09-11T14:2x:xxZ` (re-confirmed via `date -u` and a fresh
  `getLatestLedger()` RPC call at the time of writing).
- **Remaining wait: ~48 hours from this step's execution.** Not yet
  eligible. No `cancel()` call was attempted — per this task's own
  instruction not to create Testnet noise with a call whose rejection is
  already certain from timestamp arithmetic and already covered by the
  contract's own passing unit tests (`test_cancel_unfunded_before_grace_fails`,
  re-run this step, see "Validation").

## Direct RPC evidence (independent verification, pre-cancel baseline)

A fresh `getContractInstance` RPC read (not reused from the deploy/
initialize calls' own responses) confirms the instance's real, current
on-chain state:

```
wasm hash: 5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b
Buyer:            GDD6OJCIOJ2N3VVNKDCMOJ7B7HVNNOQH4RS7PGNT2EVI76MVGKHMROHS
Commodity:        [ 'Other', 'COCOA' ]
Farmer:           GDD6OJCIOJ2N3VVNKDCMOJ7B7HVNNOQH4RS7PGNT2EVI76MVGKHMROHS
FloorPrice:       40000000000
Funded:           false
Maturity:         1789136649
Notional:         100
Oracle:           CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T
Settled:          false
SettlementToken:  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

No `Cancelled` key is present — genuinely absent, matching documented
pre-cancel semantics exactly (absence, not `false`).

## Indexer evidence

Registered via the real, live indexer's actual `POST /pricefloor-instances`
endpoint (the same process re-verified in the Phase 6 readiness
checkpoint, already configured with the current wasm hash):

```json
{"instance":{"contractId":"CDXM4NOHCSGQ2UNQC34LE6JEG3OUUZ67PMXA4VUOSMX3BRPRRBW4LE7D","status":"registered", ...}}
```

After one real poll cycle (60s), the indexer's own event-derived lifecycle
advanced it correctly:

```json
{
  "contractId": "CDXM4NOHCSGQ2UNQC34LE6JEG3OUUZ67PMXA4VUOSMX3BRPRRBW4LE7D",
  "status": "initialized",
  "farmer": "GDD6OJCIOJ2N3VVNKDCMOJ7B7HVNNOQH4RS7PGNT2EVI76MVGKHMROHS",
  "buyer": "GDD6OJCIOJ2N3VVNKDCMOJ7B7HVNNOQH4RS7PGNT2EVI76MVGKHMROHS",
  "commodity": ["Other", "COCOA"],
  "floorPrice": "40000000000",
  "notional": "100",
  "settlementToken": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "maturityTs": "2026-09-11T14:24:09.000Z",
  "oracleContractId": "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T",
  "fundedAt": null, "settledAt": null, "cancelledAt": null
}
```

All fields match the direct RPC read exactly. `cancelledAt` is correctly
`null` — no cancellation has occurred yet.

## `/api/deals` evidence

The same record above is served through `/api/deals` (the same endpoint
`deals.ts` exposes) with the same `contractId`, correctly isolated from
every other deal in the registry — confirmed by the fact that only this
one record matched the query for this `contractId` among the full deal
list. Once real `cancel()` succeeds (in a future session, once eligible),
the same endpoint is expected to report `status: "cancelled"` and a
populated `cancelledAt`, per the indexer's existing, unchanged,
event-driven lifecycle logic (`poll.ts`'s `handleEvent`) — not modified or
re-verified further this step, since no cancellation has happened yet to
observe.

## Failed/premature attempts

**None.** No `cancel()` call of any kind was made against any instance
this step. The eligibility timestamp was computed directly from real,
independently-read on-chain state (`Maturity` field) and the contract's
own published constant (`UNFUNDED_CANCEL_GRACE`), making the outcome of a
premature call already certain (`Error::GracePeriodNotElapsed`) and
already covered by the contract's own passing unit test
(`test_cancel_unfunded_before_grace_fails`) — attempting one live would
have added Testnet noise without producing new evidence, which this
task's own instructions explicitly discourage.

## Funded-cancel (96h-class) path — not performed

Per this task's own instruction ("do not make this mandatory if the time
window is impractical for the current session"), the funded path was not
attempted this step. It requires funding the instance (a separate real
token transfer), then waiting the same 48h `SETTLE_FAILURE_GRACE` past
maturity *while also confirming the oracle continues to have no price for
the commodity* — a materially longer and more failure-prone setup than the
unfunded path chosen here for the smallest safe first test. Recommended as
a follow-up once the unfunded path's live result is in hand.

## Safety

- The deploying/signing keypair is a freshly generated, single-purpose
  Testnet throwaway (`Keypair.random()`, funded only via friendbot) — not
  a real user's identity, not reused from any other phase.
- Its secret was **never logged to any tracked or committed file, and
  never printed into this report**. It was written once to the gitignored
  `.env.local` (confirmed via `git check-ignore -v .env.local`) under
  clearly labeled `PHASE6_STEP4_CANCEL_TEST_*` variables, specifically so
  a future session can retrieve it to perform the actual `cancel()` call
  once the 48h window elapses, without needing to deploy yet another
  instance and restart the wait from zero.
- `git status` confirms no secret-bearing file was staged or committed at
  any point this step.

## Validation (verification-only step; no code changed)

Since this step made no production code, configuration, or contract
changes, the full CI-grade validation suite was not re-run wholesale;
instead, the tests directly relevant to the behavior exercised were run
and their real results recorded:

- `cargo test --package agripricefloor cancel` (agrifeed-contract): **10
  passed, 0 failed** — every existing `cancel()`-related unit test,
  including the exact grace-period-not-elapsed and repeated-cancel cases
  this step's own analysis relies on.
- `services/indexer/src/instances.test.ts` (real Testnet RPC, no mocks):
  first run hit a **transient** `AxiosError: fetch failed` against the
  live Testnet RPC endpoint (6 of 24 tests failed, all with the identical
  network-level error, not an assertion failure) — an immediate retry
  passed **24/24**. This is not a repository defect: it is the same
  disclosed risk this project's own Phase 5 readiness audit already
  identified ("indexer tests hit real Testnet RPC in CI, flakiness risk,
  P2") — recorded honestly here rather than silently re-run and omitted.
- `pnpm --filter @agrifeed/indexer test` (full suite): **60/60 passed**.

No code was changed to produce these results; both runs exercised the
exact same, unmodified source as Phase 6 Step 3's baseline.

## Overall verdict

# UNVERIFIED / WAITING FOR ELIGIBILITY

A real, live, unfunded, Cancelled-flag-bearing PriceFloor instance now
exists on Testnet and is genuinely progressing toward legitimate
`cancel()` eligibility at **`2026-09-13T14:24:09Z`** (48h from this step's
real initialize call). No shortcut, bypass, timestamp manipulation, or
fabricated evidence was used to reach this state — the full 48-hour grace
period the contract actually enforces still applies in full. This does
not meet the acceptance criteria for PASS (no `cancel()` transaction has
been submitted, so `Cancelled=true` has not been observed on-chain), and
per this task's own explicit instruction, this is not reported as PASS.

**To complete this verification once eligible** (`2026-09-13T14:24:09Z`
or later): load `PHASE6_STEP4_CANCEL_TEST_SECRET`/`_PUBLIC`/
`_CONTRACT_ID` from `.env.local`, call `pricefloor.cancel()` with that
keypair as the caller, then independently re-verify via a fresh RPC read
(`Cancelled: true`, `Funded` unchanged at `false`), the real `Cancelled`
event, the indexer's `status: "cancelled"` and populated `cancelledAt`,
and `/api/deals` reflecting the same — exactly the evidence chain this
report's "Indexer evidence"/"/api/deals evidence" sections already
established the pre-cancel baseline for.
