# Phase 5 — Final Readiness Gate

**Audit type**: read-only cross-repository readiness audit. No implementation
changes were made to reach the verdict below; only this report was written.

## 1. Final commit baselines

| Repository | Baseline commit | Confirmed |
| --- | --- | --- |
| `AgriFeed/agrifeed-app` | `1c50d90` — "docs(phase5): record node-relayer ci verification" | `git log -1` re-run at audit time, matches |
| `AgriFeed/agrifeed-contract` | `190f009` — "docs: record CI run evidence for clippy wasm fix" | `git log -1` re-run at audit time, matches |

Both working trees were clean (no staged/unstaged/untracked changes) at the
start of this audit.

## 2. Phase-by-phase summary

| Step | Scope | Verdict as recorded | Evidence type |
| --- | --- | --- | --- |
| Readiness/scope audit | Full sweep, ranked findings | N/A (audit) | Code reading, CI log inspection, local test re-run (123/123) |
| Step 2 — CI Postgres restoration | Added Postgres service to `node` CI job | Implicit PASS | Real CI run `34491438284`, all green |
| Step 3 — Freighter re-verification | Re-check browser wallet integration | **UNVERIFIED** (explicit) | Browser evidence (partial — connect gate only), version-diff reasoning |
| Step 4 — tx_too_late fix | Time-bound refresh for signing delay | PASS | Real Testnet before/after reproduction, 14 new unit tests |
| Step 5 — Documentation currency | Corrected 10 stale doc statements | PASS | typecheck/lint/test(137)/build + one live doc render check |
| Step 6 — Cancelled storage-state | Added `DataKey::Cancelled`, indexer diagnostic | PASS (with disclosed limitation) | Contract-level real Testnet deploy/initialize; `cancel()` itself only unit-tested |
| Step 7 — node-relayer tests | 55 new tests, 2 real bugs fixed | PASS | Real CI run `34577096104`, all green |
| agrifeed-contract CI clippy fix | Build WASM before Clippy | PASS | Real CI run `34578328985`, all green |

Test count trail, reconciled against current HEAD: 123 → 137 (+14 SDK,
tx_too_late) → 137 (doc-only) → 139 (+2 indexer, Cancelled diagnostic) → 194
(+55 node-relayer). Current `agrifeed-app` CI (run `34577621859`, matching
HEAD `1c50d90` exactly) reports **194 tests total** (SDK 41, apps/web 43,
indexer 55, node-relayer 55), consistent with this trail. `agrifeed-contract`
currently reports **51 tests** (1 root crate + 28 oracle + 22 pricefloor,
consistent with earlier "50" counts that excluded the root crate's own test).

No regressions detected in this trail — every step's test count is
additive over the previous step's.

## 3. Security verdict

- **Oracle admin authorization** — code-verified. Every admin-gated function
  (`add_node`, `remove_node`, `set_threshold`, `set_retention`,
  `add_commodity`) calls `admin.require_auth()` and separately re-checks the
  passed address against stored `DataKey::Admin` via `require_admin`, closing
  the gap where `require_auth` alone would only prove *some* valid signer,
  not the *admin* signer. `initialize` authenticates before checking
  `AlreadyInitialized`, closing a front-run window.
- **PriceFloor two-party authorization** — code-verified. `initialize`
  requires both `farmer.require_auth()` and `buyer.require_auth()` before any
  write. `fund` requires and matches the stored buyer. `cancel` requires
  `caller.require_auth()` and restricts to `caller == farmer || caller ==
  buyer`. `settle` is intentionally permissionless — by design, since payout
  math is fixed and no unauthorized party can redirect funds by calling it.
- **Cancellation authorization** — code-verified, correct. No party other
  than farmer or buyer can cancel.
- **Signer/source-account handling** — code-verified in `multiparty.ts` and
  `NewDealFlow.tsx`: each party signs independently via their own Freighter
  session; wrong-wallet detection (`assertExpectedSigner`) is wired per role.
- **No authentication bypasses found** in any audited contract or SDK path.
- **No secret leakage found**. `NODE_RELAYER_SECRET_KEY` is converted to a
  `Keypair` once in `env.ts` and never logged or interpolated into error
  messages; a regression test enforces this.
- **node-relayer write-path safety** — code-verified: config validated at
  startup (including the Step 7 fix for malformed
  `NODE_RELAYER_SUBMIT_INTERVAL_SECONDS`), transaction built, simulated,
  signed, submitted, and polled to confirmation, with typed error handling
  on rejection/failure/timeout.

**Verdict: no security P0 or P1 findings.** One precision note, not a
finding: `/api/deals` filtering by `farmer`/`buyer` query parameter is
*query filtering over public on-chain-derived data*, not authenticated
per-user access control — anyone can query any address's deals. This matches
the nature of public blockchain data and should not be described as private
data isolation in product claims.

## 4. Contract verdict

- **Oracle behavior**: unchanged this phase, previously audited, tests green.
- **PriceFloor behavior**: unchanged core lifecycle (`initialize` → `fund` →
  `settle`/`cancel`), only the `Cancelled` diagnostic flag added.
- **Persistent `Cancelled` flag — important nuance**: `DataKey::Cancelled` is
  set unconditionally by `cancel()` (both funded and unfunded branches) but
  is **write-only** — it is never read anywhere else in the contract. It is
  *not* a behavioral gate. Post-cancel rejection of `settle()` still comes
  from the pre-existing `Funded`/`Settled` flags (a funded-then-cancelled
  deal has `Funded` reset to `false`, so `settle()` fails with `NotFunded`
  independent of the new flag). Do not describe this as "cancel() now blocks
  settle()" — it doesn't do that directly; it adds point-in-time
  observability for indexers/consumers that may have missed the `Cancelled`
  *event*.
- **Backward compatibility**: purely additive, code-verified. Unset
  instance-storage keys return `None` and are handled without panics
  everywhere. Soroban contracts have no in-place upgrade mechanism, so
  already-deployed instances predating this change can never retroactively
  gain the flag — this is expected and disclosed, not a defect.
- **WASM deployment assumptions**: unchanged — same `wasm32v1-none` target,
  same relative `contractimport!` path. Only CI job wiring changed (see §9
  CI/build).
- **Live Testnet evidence**: a real instance was deployed from the *updated*
  wasm (hash `5d99a31e...`, vs. old `05faa570...`), with real deploy/init tx
  hashes, and RPC-reconfirmed. **This audit did not independently re-verify
  whether the production `PRICEFLOOR_WASM_HASH` config has since been cut
  over to the new hash** — Step 6 explicitly left it on the old hash. Treat
  the wasm cutover as an **open item requiring confirmation**, not resolved
  by this audit.
- **Live `cancel()` status — NOT FOUND.** No tx hash, log, or doc in either
  repository records an actual on-chain `cancel()` invocation. All
  `Cancelled`-flag evidence is `env.as_contract()` unit-test storage
  inspection in the Soroban test environment, not a real Testnet state
  transition. This remains **UNVERIFIED**, consistent with Step 6's own
  disclosed limitation (48–96h real grace period, no fast-forward available).

**Verdict: contract layer PASS on code correctness and CI; `cancel()`'s live
on-chain behavior remains explicitly unverified — do not claim it "works" on
Testnet, only that its logic is unit-tested and its authorization is
code-verified.**

## 5. SDK / transaction verdict

- **Multiparty signing**: code-verified, real 3-phase design
  (`prepareMultiPartyInvocation` → independent per-party signing →
  `submitMultiPartyInvocation`), documented rationale for why a single
  `signTransaction` call cannot satisfy two-party auth.
- **Time-bound refresh fix (Step 4)**: code-verified, present and unchanged
  since Step 4 — `refreshTimeBounds` (180s validity, applied immediately
  before signing, reattaches Soroban resource footprint) and `isTxTooLate`
  (narrow XDR-discriminant check).
- **`tx_too_late` classification**: typed `TxTooLateError`, distinct from
  generic `OracleError`, in `soroban-tx.ts`'s `submitAndConfirm`.
- **Stale transaction handling**: the refresh is applied as late as possible
  in the multiparty submission path; this reduces but does not eliminate the
  possibility of a stale transaction under sufficiently long human-approval
  delay.
- **Source auth preservation**: code-verified in `NewDealFlow.tsx` — address
  validation, wrong-wallet detection, independent per-role signing.
- **Error handling**: typed distinctions between `TxTooLateError` and
  generic `OracleError` at the SDK level.
- **Browser wallet integration / Freighter verification status**: **still
  UNVERIFIED**, unchanged from Step 3. No Freighter extension was available
  in the audited browser session; the connect flow stopped at step 1 of 9.
  This is an external-environment limitation, not a code defect — SDK and
  Freighter API package versions are current and unchanged since the
  original Phase 3 finding. **Do not upgrade this to "Freighter is broken."**
  It has simply never been exercised end-to-end in this environment.
- **Same-session signing limitation**: explicitly documented in
  `NewDealFlow.tsx` itself — both parties must sign in the same browser tab
  by switching the active Freighter account; there is no persistence or
  link-sharing across devices/sessions. **Do not describe deal recovery
  (§7) as multi-session or two-device signing support** — recovery lets a
  party look up an already-created deal later; it does not let two different
  browser sessions jointly complete an unsigned deal.

**Verdict: SDK/transaction layer PASS on code correctness and the tx_too_late
fix; Freighter/browser wallet integration remains UNVERIFIED (environment,
not code).**

## 6. Indexer / API verdict

- **Multi-instance registry**: code-verified, one row per deployed PriceFloor
  instance in `pricefloor_instances`.
- **Lifecycle/event ingestion**: code-verified — `Initialized`/`Funded`/
  `Settled`/`Cancelled` events advance `status` forward-only with timestamps.
- **Cancelled diagnostic**: code-verified and current. `enrichInstanceStorage`
  reads the contract's `DataKey::Cancelled` flag and cross-checks it against
  the indexed `status`, logging a warning on mismatch (possible missed
  event). Indexed `status` still derives exclusively from the event, never
  from the storage flag directly — this matches the intended design from
  Step 6.
- **New finding (minor, P2, doc staleness)**: `services/indexer/src/api/
  deals.ts`'s own doc comment (lines 16–20) still states "the contract
  writes no corresponding storage flag" for `Cancelled` — this is now stale
  relative to Step 6, which added exactly that flag. The functional
  conclusion in the comment (status still comes from the event) remains
  correct; only the stated reason is outdated. This was not present in any
  prior report and is a new item surfaced by this audit (see §12, item G).
- **`/api/deals`**: code-verified — parameterized SQL, address-format
  validated inputs, explicit response allowlist (`serializeDeal` never
  spreads a raw DB row). As noted in §3, this is public-data query filtering,
  not authenticated per-user isolation.
- **Database migrations**: single idempotent `schema.sql` applied via
  `migrate.ts`; no separate migration-file history. CI's `node` job verifies
  this applies cleanly to a fresh database.
- **Restart/configuration behavior**: not independently re-verified in this
  audit pass beyond confirming CI provisions Postgres and applies the schema
  cleanly.
- **`.env.local` limitation**: referenced in three prior Phase 4/5 docs, not
  independently re-verified this audit — carried forward as previously
  documented, not re-confirmed or refuted.

**Verdict: indexer/API PASS.** One new minor doc-staleness item found (P2,
not a functional defect).

## 7. Frontend / product verdict

- **Working tree**: confirmed clean at audit time (`git status` — "nothing
  to commit, working tree clean"). An earlier session-start snapshot showing
  modifications to `demo/page.tsx`, `DemoFlow.tsx`, `NewDealFlow.tsx`, and a
  new `lib/txHash.ts` is stale relative to the current state; those files
  are present, tracked, and already committed with no outstanding diff.
- **Markets / Commodity Detail / Reporting Network / Price Protection / My
  Deals**: routes located as `app/page.tsx`, `app/commodity/[symbol]`,
  `app/nodes` (Reporting Network), `app/deals` + `app/deals/[contractId]`
  (My Deals). No dedicated `/markets` or `/price-protection` route
  directories were found by those exact names — they likely correspond to
  sections within `page.tsx`/`commodity`/`deals` rather than standalone
  routes. This is a naming-mapping gap in the audit, not a confirmed product
  defect; flagged for follow-up rather than asserted as broken.
- **No mock/placeholder-as-real data**: grep across `apps/web/app` for
  mock/fake/placeholder/TODO/"coming soon" markers found matches only in the
  `demo/` route, which is expected and self-labeled.
- **Persistent deal recovery**: code-verified, strong evidence.
  `apps/web/lib/deals.ts` sources deals exclusively from `/api/deals`; its
  own doc comment states no localStorage/sessionStorage is read, and a
  dedicated regression test seeds a fabricated localStorage deal and asserts
  it never surfaces. The only localStorage/sessionStorage references in the
  entire `apps/web` tree are in this file and its test.
- **Network/Testnet identity**: widely and consistently surfaced across
  `layout.tsx`, `page.tsx`, `nodes/page.tsx`, `docs/page.tsx`, `demo/page.tsx`,
  `NewDealFlow.tsx`, `SiteFooter.tsx`, `DemoFlow.tsx`, `DocsNav.tsx` — not
  confined to one page.
- **Accessibility**: only spot-checked, not fully audited. `NewDealFlow.tsx`
  (the most complex interactive flow) has some `aria-`/`role=`/`<label>`
  usage; `app/page.tsx` showed none in the same shallow grep. This is
  UNVERIFIED beyond a spot check — do not claim a11y compliance from this
  audit.
- **No unsupported recovery claims found**: deal recovery is consistently
  described as address-based lookup via the indexer API, not as
  multi-session signing (see §5).
- **No unsupported production claims found**: Testnet identity is
  consistently surfaced; no "production" claims were found in the audited
  copy.

**Verdict: frontend/product PASS**, with one unresolved naming-mapping
question (Markets/Price Protection route identity) and accessibility left
UNVERIFIED beyond a shallow spot check.

## 8. Node-relayer verdict

- **Configuration validation**: code-verified, including the Step 7 fix for
  malformed `NODE_RELAYER_SUBMIT_INTERVAL_SECONDS`.
- **Transaction construction, simulation, signing, submission,
  confirmation**: code-verified — `submitPrice()` builds via
  `TransactionBuilder`, calls `prepareTransaction` (simulation), signs with
  the server-held `Keypair`, sends, and polls up to 20×1.5s for confirmation,
  throwing `OracleError` on rejection/failure/timeout.
- **Automated coverage**: local-run-verified — 7 test files, 55 tests, all
  passing (32s). Matches the CI-reported count exactly.
- **No secret leakage**: confirmed, `NODE_RELAYER_SECRET_KEY` never logged or
  included in error messages, enforced by a regression test.
- **submit.ts duplication with SDK — CONFIRMED, still present.** `submit.ts`
  does **not** use `packages/sdk/src/soroban-tx.ts`'s shared
  `refreshTimeBounds()`/`submitAndConfirm()` helpers; it hand-rolls its own
  build/sign/send/poll loop (~35 lines), with an explicit comment stating it
  mirrors `pricefloor.ts`'s `invokeAndConfirm` since it runs unattended.
  Consequence: the Step 4 `tx_too_late`-specific classification and
  time-bound-refresh fix does **not** apply to node-relayer's submission
  path — any rejection surfaces only as a generic `OracleError`, and time
  bounds are fixed once at build time (`.setTimeout(60)`) with no refresh
  before signing. This is lower-risk than the human-approval path (no
  multi-second approval gap for an unattended signer) but is a genuine,
  disclosed, and — per Step 7's report — **deliberately deferred**, not
  fixed, gap. This is a known item, not a new regression.
- **External data dependencies**: FAO and IMF adapters make real external
  HTTP/bulk-CSV calls; AMIS is diagnostic-only by design (always throws
  `SourceUnavailableError`, confirmed by its own test). Per-commodity
  failures are caught individually in `tick()`, so one commodity's total
  source failure does not block other commodities in the same cycle.

**Verdict: node-relayer PASS on delivered scope**; the SDK-duplication gap
remains an explicitly disclosed, deliberately deferred P1-adjacent item, not
a new finding.

## 9. CI / build verdict

**agrifeed-app** (CI-verified for current HEAD `1c50d90`, run `34577621859`,
success, 2m3s — no staleness, matches HEAD exactly):
- `indexer-migration` ✅
- `node` ✅ — runs against a real Postgres service container; steps:
  install → build SDK → `pnpm typecheck` ✅ → `pnpm lint` ✅ → migrations
  apply cleanly to a fresh DB ✅ → `pnpm test` ✅ (194 tests: SDK 41, web 43,
  indexer 55, node-relayer 55, all passing) → `pnpm build` ✅
- `research` ✅

**agrifeed-contract** (CI-verified for current HEAD `190f009`, run
`34578645215`, success, 1m45s — no staleness, matches HEAD exactly):
- Format ✅
- Clippy ✅ (now builds oracle wasm then pricefloor wasm before linting)
- Build and test ✅ (51 tests: 1 root + 28 oracle + 22 pricefloor)

**Verdict: CI/build PASS for both repositories, current and non-stale.**

## 10. Documentation verdict

- Step 5's documentation currency pass (10 corrections across `docs/`,
  `README.md`, `PRODUCT.md`, `DESIGN.md`) remains intact — no regressions
  found in this audit's spot checks of those files.
- One new stale doc comment found this audit (§6, `services/indexer/src/
  api/deals.ts`) — P2, functional conclusion still correct, only the stated
  reason is outdated.
- No reintroduced Phase 3/early-Phase-4 claims (e.g. "not indexed," "single
  fixed instance") were found in the files reviewed.

**Verdict: documentation PASS**, one new minor staleness item identified
(§12, item G).

## 11. Live Testnet evidence summary

Strongest real evidence found, ranked by directness:

1. **tx_too_late reproduction and fix (Step 4)**: real before-fix failure and
   after-fix success against live Testnet, plus a full real
   `deployInstance` (contract id `CAJSQW6...`, independently
   RPC-reconfirmed wasm hash).
2. **Updated PriceFloor wasm deployment (Step 6)**: real deploy tx
   (`56b40be2...`) and initialize tx (`313fbb93...`) against Testnet from
   the new wasm (hash `5d99a31e...`), RPC-reconfirmed field-by-field,
   confirming `Cancelled` genuinely absent pre-cancel.
3. **CI-run evidence (both repos)**: real, current, matching HEAD exactly —
   not simulated, not stale.
4. **node-relayer submission logic**: local deterministic test evidence
   only (stubbed RPC boundary) — real submission to live Testnet was
   demonstrated in earlier phases' node-operator work, not re-verified this
   audit.

Not found / not real Testnet evidence:
- **Live `cancel()` invocation** — no tx hash exists anywhere in either
  repository. UNVERIFIED.
- **Live Freighter browser wallet flow** — connect gate only, no signed
  transaction. UNVERIFIED.
- **Multi-session/two-device signing** — never attempted; explicitly not
  built.

## 12. Open limitations

| Item | Description | Classification |
| --- | --- | --- |
| A. Freighter compatibility | No Freighter extension available in audited browser session; connect flow unverified past step 1 of 9. SDK/API versions current. | **UNVERIFIED** (external environment, not a code defect) |
| B. Live `cancel()` verification | No on-chain `cancel()` invocation has ever been executed against a live Testnet instance; only Soroban-test-env unit tests and code-level auth review exist. | **UNVERIFIED** / **DEFERRED** (48–96h real grace period, explicitly out of scope for Step 6) |
| C. Multi-session/two-device signing | Both parties must sign in the same browser tab today; no persistence or link-sharing across sessions/devices. | **ACCEPTED LIMITATION** (explicitly documented as not built, not a regression) |
| D. `submit.ts` duplicated transaction lifecycle | node-relayer hand-rolls its own build/sign/submit/confirm loop instead of reusing the SDK's `refreshTimeBounds`/`submitAndConfirm`; the `tx_too_late` fix does not apply to this path. | **P1** — important, deliberately deferred per Step 7's explicit, user-approved decision; not a regression |
| E. node-relayer external data dependencies | FAO/IMF are real external HTTP/bulk-CSV sources; AMIS is diagnostic-only by design. Per-commodity failure isolation confirmed. | **ACCEPTED LIMITATION** (working as designed) |
| F. `.env.local` / indexer restart-configuration gap | Referenced in three prior Phase 4/5 docs; not independently re-verified this audit. | **UNVERIFIED** (carried forward, not re-confirmed or refuted) |
| G. Indexer doc comment staleness (`deals.ts`) | Comment still claims no `Cancelled` storage flag exists; flag was added in Step 6. Functional conclusion still correct. | **P2** (new issue found this audit) |
| H. PriceFloor WASM cutover status | Step 6 explicitly left production `PRICEFLOOR_WASM_HASH` on the old hash; this audit did not independently re-verify current config value. | **UNVERIFIED** — requires explicit follow-up confirmation before claiming the new Cancelled-flag wasm is live in any deployed environment |
| I. Frontend route-naming mapping (Markets/Price Protection) | No routes found by these exact names; likely sections of existing pages. Not confirmed as a defect. | **UNVERIFIED** |
| J. Frontend accessibility | Only a shallow spot check performed; no full a11y audit. | **UNVERIFIED** |
| K. `/api/deals` is public-data filtering, not per-user auth | Correct-by-design for public blockchain data, but should not be marketed as private isolation. | **ACCEPTED LIMITATION** (precision note, not a defect) |

## 13. Regressions found

**None.** Every prior Phase 5 step's claimed capability was re-confirmed
against current source: test counts are strictly additive across the
recorded trail, both repositories' most recent real CI runs match their
current HEAD commits exactly with all jobs green, contract authorization
logic is unchanged and correct, and the frontend's no-localStorage-recovery
guarantee still holds with an active regression test. The two new items
found (G: stale indexer doc comment, H: unconfirmed wasm cutover status)
are omissions/documentation gaps, not regressions of previously-working
behavior.

## 14. Recommended next action

1. Confirm the current `PRICEFLOOR_WASM_HASH` production/deployment config
   value (item H) and record explicitly whether the Cancelled-flag-bearing
   wasm is live anywhere, before making any claim about the Cancelled
   diagnostic being active in a running deployment.
2. Correct the stale doc comment in `services/indexer/src/api/deals.ts`
   (item G) — low effort, no behavior change.
3. When a real Freighter-capable browser environment becomes available,
   perform an actual end-to-end signed-transaction Freighter test (item A)
   — this is the single highest-value verification gap blocking any
   "browser wallet works" claim.
4. If/when a release step depends on `cancel()` being demonstrated live
   (item B), schedule a real Testnet cancel test that accounts for the
   48–96h grace period, or explicitly accept the unit-test-only evidence
   for that release step.
5. Treat `submit.ts`'s SDK duplication (item D) as a still-open P1 to
   schedule, not to re-defer indefinitely — the risk is currently low but
   not zero (an unattended signer with a rejected/stale transaction only
   gets a generic error, not the typed classification the rest of the
   system relies on).

## 15. Overall verdict

# CONDITIONAL PASS

**Rationale**: No P0 blocker was found anywhere in either repository —
security-critical authorization (oracle admin, PriceFloor two-party,
cancellation) is code-verified correct, both repositories' CI is green and
current at their exact HEAD commits, no secret leakage was found, and no
regressions were detected against any prior Phase 5 claim.

However, several P1-level items materially limit the next readiness level
and should be resolved or explicitly accepted before any claim of
"browser-wallet-verified," "cancel()-verified-on-chain," or
"production-deployed-with-Cancelled-diagnostic-active" is made:

- Freighter/browser wallet integration remains UNVERIFIED end-to-end (item A).
- Live `cancel()` has never been executed on Testnet (item B).
- `submit.ts`'s SDK-lifecycle duplication remains unresolved (item D).
- The PriceFloor WASM cutover status is unconfirmed by this audit (item H).

None of these represent a security, correctness, reliability, or
data-integrity defect in the code as written — they are verification gaps
and one deliberately deferred hardening item. This is precisely the profile
of a **CONDITIONAL PASS**: proceed, but address or explicitly accept items
A, B, D, and H before making the specific claims they gate.
