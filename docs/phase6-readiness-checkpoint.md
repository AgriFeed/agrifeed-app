# Phase 6 — Readiness Checkpoint

**Audit type**: read-only checkpoint. No implementation changes were made
to reach the verdict below; only this report was written.

## Current commit baselines

| Repository | Baseline commit | Confirmed |
| --- | --- | --- |
| `AgriFeed/agrifeed-app` | `4475e4d` — "docs(phase6): record submit lifecycle ci verification" | `git log -1` re-run at audit time, matches |
| `AgriFeed/agrifeed-contract` | `190f009` — two commits past the task's stated `9347841` | `git diff 9347841 190f009 --stat` shows only `.github/workflows/ci.yml` and one new doc file changed; **zero contract source changed**. Treated as equivalent to `9347841` for every purpose this checkpoint cares about. |

## Completed Phase 6 work (recap, not re-litigated)

| Step | Outcome |
| --- | --- |
| Step 1 — PriceFloor Cancelled-aware WASM cutover | Runtime configuration (`PRICEFLOOR_WASM_HASH`/`NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`) cut over to `5d99a31e...`; live-verified deploy/initialize/register/decode against real Testnet; live indexer process staleness caught and fixed; CI green. |
| Step 2 — node-relayer lifecycle audit | Decision: CONSOLIDATE. No code changed; full compatibility matrix, tx_too_late/auth/error-semantics analysis. |
| Step 3 — node-relayer lifecycle consolidation | `submit.ts` refactored onto the shared SDK primitives (`refreshTimeBounds`/`submitAndConfirm`); server-appropriate `TxTooLateError` handling added; real Testnet submission independently re-verified via a fresh RPC read of the on-chain event; CI green. |

## 1. PriceFloor WASM state

- **Cutover is the configured runtime baseline**: re-confirmed this
  checkpoint — `.env.local` (root) and `apps/web/.env.local` both currently
  set `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`/`PRICEFLOOR_WASM_HASH` to
  `5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b`, not
  the old `05faa570...` hash. No drift since Step 1.
- **New hash is the intended deployed WASM**: unchanged fact from Step 1 —
  this is `agrifeed-contract` commit `9347841`'s build
  (`DataKey::Cancelled` introduced), independently rebuilt and
  sha256-verified in that step.
- **The running indexer process itself still reflects this config**:
  re-checked this checkpoint — `GET /health` on the live process (same PID,
  `163769`, restarted in Step 1) returns `{"ok":true,"oracleConfigured":
  true,"pricefloorConfigured":true}`, and no config or process change has
  occurred since Step 1's live re-verification (which proved, via a fresh
  old-wasm deploy, that this exact process now refuses old-wasm
  registrations and accepts new-wasm ones).
- **Legacy registered instances remain supported**: unchanged architecture
  — `registerInstance`'s wasm-hash check only ever runs once, at first
  registration; `isKnownPriceFloorInstance` and the fixed legacy instance
  (`PRICEFLOOR_CONTRACT_ID`, old wasm) are matched by contract id, never
  re-validated against the currently configured hash. No code in
  `services/indexer/src/instances.ts` has changed since Step 1's audit of
  this exact property.

**Verdict: confirmed, unchanged since Step 1, no drift.**

## 2. Transaction lifecycle

- **node-relayer uses the shared SDK lifecycle**: confirmed by re-reading
  `services/node-relayer/src/submit/submit.ts` at current HEAD —
  `refreshTimeBounds`/`submitAndConfirm` imported from `@agrifeed/sdk`
  (its public surface, added in Step 3), no manual poll loop present.
- **`tx_too_late` refresh behavior is inherited**: `refreshTimeBounds` is
  called on the prepared transaction immediately before signing, and
  `submitAndConfirm` classifies a genuine `tx_too_late` rejection as
  `TxTooLateError`, not generic `OracleError` — both are the same shared
  functions every other write path in this project uses, not a
  reimplementation.
- **node-relayer-specific error handling remains correct**:
  `services/node-relayer/src/submitFailureLog.ts`'s `logSubmitFailure`
  still special-cases `TxTooLateError` with a server-appropriate message
  (no "wallet"/"browser"/"prompt" language, correctly describes the actual
  retry behavior — next scheduled cycle, not immediate) and falls through
  to the original generic error log for everything else. `index.ts`'s
  `tick()` calls this unchanged since Step 3.

**Verdict: confirmed, unchanged since Step 3, no drift.**

## 3. CI / verification

- **`agrifeed-app` CI**: re-verified this checkpoint at current HEAD
  `4475e4d` — run `34586918147`, `node`/`research`/`indexer-migration` all
  green.
- **Current test count**: **206 tests** (SDK 41 + apps/web 43 + indexer 60
  + node-relayer 62), unchanged from Step 3's final count — confirmed via
  the same CI run's log.
- **Typecheck/lint/build**: all green in the same CI run (the `node` job
  runs `pnpm typecheck`, `pnpm lint`, and `pnpm build` in sequence,
  confirmed from the job's step list).
- **`agrifeed-contract` CI**: re-checked this checkpoint — latest run
  (`34578645215`, for commit `190f009`, the actual current HEAD) is
  `success`, all three jobs (Format/Clippy/Build-and-test) green. This is
  the same run already verified in the CI-clippy-fix step; nothing has
  been pushed to this repository since, so there is nothing new to
  re-verify beyond confirming the run is still the current HEAD's run
  (it is).

**Verdict: both repositories' CI green and current, no staleness.**

## 4. Contract cancellation

**Live `cancel()` remains unverified.** Nothing in Phase 6 attempted or
claimed otherwise. Distinguishing explicitly, as required:

- **Contract fix implemented**: yes — `DataKey::Cancelled` (commit
  `9347841`), unit-tested in the Soroban test environment (4 tests, Phase
  5 Step 6), and now the actual configured runtime WASM (Phase 6 Step 1).
- **Live `cancel()` behavior verified**: no. No tx hash, log, or doc in
  either repository records an actual on-chain `cancel()` invocation
  against any instance, before or after Phase 6. The 48–96 hour grace
  period was not attempted, accelerated, or faked at any point in Phase 6
  — confirmed by re-reading Steps 1 and 3's own "no fake accelerated
  cancel()" disclosures, and by finding no new evidence of one anywhere in
  the current repository state.

**Classification: UNVERIFIED, unchanged.**

## 5. Freighter/browser wallet

No new browser evidence was sought or produced in Phase 6 — none of
Steps 1–3 touched the frontend wallet-connection path. Re-checked the
current public docs page
(`apps/web/app/docs/page.tsx:594`) for drift: it still reads "not
confirmed broken, pending a real re-test against a currently-installed
Freighter [extension]" — the same honest, non-overclaiming framing as
Phase 5. **No extension was available in this checkpoint's environment
either** (not re-tested, since nothing in Phase 6 changed the SDK/wallet
integration code that would warrant a new attempt).

**Classification: UNVERIFIED, unchanged. Not described as broken or
working.**

## 6. Multi-session signing

Re-checked `apps/web/app/docs/page.tsx:649-653`: "Same-session signing is
unchanged by this feature... My Deals makes a previously-created deal's
indexed record easy to find again; it does not add multi-device or
multi-session signing." This is the same explicit, correctly-scoped
disclosure found in the Phase 5 gate — persistent deal recovery (a lookup
capability) is not conflated with multi-session signing (a capability that
does not exist) anywhere in current documentation. Nothing in Phase 6
touched this area.

**Classification: DEFERRED, unchanged. No accidental implication of
support found.**

## 7. Remaining technical risks — new items exposed during Phase 6

Reviewed all three Phase 6 steps' own disclosed limitations plus this
checkpoint's independent re-verification for anything new:

- **No new P0 or P1 found.** Phase 6 Step 1's own audit surfaced and
  *resolved* one real, concrete risk during its own execution (the live
  indexer process not hot-reloading `.env.local`) — this was caught,
  fixed, and documented within that step, not left open.
- **One operational characteristic worth carrying forward, not a defect**:
  changing `PRICEFLOOR_WASM_HASH` (or any env var) requires restarting the
  indexer process to take effect — expected Node.js behavior, not a bug,
  but worth remembering for any *future* config change, since Step 1
  proved this gap is real and easy to miss without explicit verification.
- **Step 3's own disclosed, still-open item**: node-relayer's generic
  `OracleError` for every non-`tx_too_late` Oracle rejection (no
  `NotAuthorizedNode`/`UnknownCommodity`/`InvalidPrice`/
  `DuplicateSubmission`-specific messages) — deliberately out of scope for
  the consolidation, unchanged, not a new finding.

**No new blocker of any severity was created by or exposed during Phase 6
Steps 1–3.**

## 8. Documentation

- **Persistent PriceFloor deals**: current, unchanged since Phase 5 Step
  5's documentation pass.
- **New `Cancelled` flag**: **one confirmed, still-open staleness item**,
  found independently by both this checkpoint and Phase 5's final
  readiness gate (that report's item G) — `services/indexer/src/api/
  deals.ts`'s own doc comment still states "the contract writes no
  corresponding storage flag," which has been inaccurate since Phase 5
  Step 6. **This checkpoint additionally found the identical stale claim
  in the public-facing docs page**, `apps/web/app/docs/page.tsx:280-285`
  ("`cancelled` is event-only... the contract itself writes no
  corresponding storage flag"). Both are the same underlying inaccuracy,
  now confirmed in two locations, neither fixed since first identified.
  The *functional* conclusion in both (indexed `status` is event-derived
  only, never re-derived from the storage flag) remains correct — only the
  stated reason ("the contract writes no flag") is wrong.
- **WASM cutover**: not mentioned anywhere in the public-facing docs page
  — expected, since this was a deployment/configuration change, not a
  product capability change, and the page correctly never claimed a
  specific wasm hash to begin with.
- **Shared node-relayer transaction lifecycle**: not mentioned in the
  public-facing docs page — also expected; this is an internal
  implementation/reliability detail with no user-visible behavior change,
  and the page does not describe node-relayer's internals at that level of
  detail anywhere.
- **Freighter status / cancel() verification status / Testnet-only
  positioning**: all confirmed current and accurate (§§4, 5 above);
  Testnet identity remains widely and consistently surfaced (unchanged
  from Phase 5's own audit of this).

**Verdict: documentation is current except for the one carried-forward,
still-unfixed staleness item (P2, now confirmed in two locations instead
of one) — not a new defect, a previously-identified one still open.**

## 9. Live evidence inventory (strongest, current, after Phase 6)

1. **New-WASM instance recognition**: real deploy/initialize
   (`CDAO5WFFNI4KTRA43BBEIHUE4SKVRPL45DJQ2P7TE7R4NELCLFS7WC7S`, Step 1),
   real registration accepted by the live, restarted indexer process,
   real refusal of a freshly-deployed old-wasm instance by the same
   process — all independently re-verified live, not simulated.
2. **API/deal registry**: `/api/deals` confirmed (Step 1) to expose all
   deals, old- and new-wasm alike, with no regression across the cutover.
3. **Settlement**: unchanged from Phase 5 — real settled instance
   (`CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272`) still
   present and correctly reported.
4. **node-relayer `submit_price`**: real, live call through the refactored
   lifecycle (Step 3), transaction hash
   `66525c3d5db1f3cf8066d60a68157bf18c7c18909ba743a10c480aca3a78aca6`.
5. **Independent RPC verification**: Step 3's live check re-read the
   confirmed transaction's own on-chain event via a *second*, freshly
   constructed `StellarRpc.Server` instance (not reusing `submitPrice`'s
   own server object) and decoded a real `price_submitted` event matching
   node identity, commodity, and price exactly — the strongest
   verification pattern used anywhere in this project, deliberately not
   trusting a function's own self-reported success.

## Remaining limitations, classified

| Item | Classification | Change since Phase 5 gate |
| --- | --- | --- |
| Freighter/browser wallet integration | **UNVERIFIED** | Unchanged |
| Live `cancel()` verification | **UNVERIFIED** / **DEFERRED** (48–96h grace period) | Unchanged |
| Multi-session/two-device signing | **DEFERRED** | Unchanged |
| `submit.ts` SDK-lifecycle duplication | — | **RESOLVED** (was P1, closed by Steps 2–3) |
| PriceFloor WASM cutover status | — | **RESOLVED** (was CONFIRMED-not-done, closed by Step 1) |
| node-relayer external data dependencies | **ACCEPTED LIMITATION** | Unchanged |
| Indexer/docs stale "no storage flag" comment | **P2** | Unchanged (now confirmed in 2 locations, not fixed) |
| node-relayer generic Oracle error-code messages | **ACCEPTED LIMITATION** (deliberately deferred, Step 3) | Unchanged |
| `/api/deals` is public-data filtering, not per-user auth | **ACCEPTED LIMITATION** (correct by design) | Unchanged |
| Frontend route-naming mapping (Markets/Price Protection) | **UNVERIFIED** (not re-checked this step, out of scope) | Unchanged |
| Frontend accessibility | **UNVERIFIED** (not re-checked this step, out of scope) | Unchanged |

## Comparison against the Phase 5 CONDITIONAL PASS

Phase 5's gate named four items gating specific stronger claims:
Freighter (A), live `cancel()` (B), `submit.ts` duplication (D), and the
WASM cutover (H). **Two of those four are now resolved** (D and H), each
with real, independently-verified Testnet evidence, not just code review.
The remaining two (A, B) are unchanged in kind — both are execution-
environment/time-constrained verification gaps (no Freighter-capable
browser available; a 48–96h grace period not yet waited out), not code
defects, exactly as Phase 5 already characterized them.

This is **material, evidenced improvement**, not a lateral move: the
gating surface narrowed from four items to two, and the two that resolved
did so with the same evidence bar (real Testnet transactions, independent
RPC re-verification, real CI runs) as everything else in this project.

## Overall verdict

# CONDITIONAL PASS

**Rationale**: No P0 blocker exists anywhere in either repository —
security-critical authorization is unchanged and still code-verified
correct, both repositories' CI is green and current, no secret leakage,
and no regression was found anywhere in this checkpoint's re-verification
of Phase 6's own claims.

The verdict remains CONDITIONAL rather than full PASS because two specific
stronger claims are still gated, per this task's own decision rule
("CONDITIONAL PASS: no P0 blocker remains, but one or more unresolved
items still prevent a specific stronger readiness/usage claim"):

- A "browser-wallet-verified" claim remains gated by Freighter's
  UNVERIFIED status (item A).
- A "cancel()-verified-on-chain" claim remains gated by live `cancel()`'s
  UNVERIFIED status (item B).

Neither item is treated as a P0 (per this task's explicit instruction),
and neither prevents the product from being credibly represented at its
intended Testnet/reference level — that level has never depended on
either claim, and current documentation does not make either claim.

## Recommended next priority

If the next step is to close the gap between CONDITIONAL PASS and full
PASS, the two remaining items are:

1. **Freighter** — the highest-value remaining gap: obtain a real,
   Freighter-capable browser environment and perform one genuine
   end-to-end signed-transaction test. This is an environment
   availability problem, not an engineering task.
2. **Live `cancel()`** — schedule a real Testnet cancel test once a
   48–96h grace period can actually be waited out, or explicitly accept
   the current unit-test-only evidence for whatever release step is next.

Neither is blocking; both are the same two items Phase 5 already
identified as the natural next verification targets, now with a narrower,
cleaner path to closing them since every other originally-cited gap has
been resolved.
