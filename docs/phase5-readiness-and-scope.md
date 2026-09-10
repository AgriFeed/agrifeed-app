# Phase 5 Step 1: Product Readiness and Technical Scope Audit

**Baseline**: `origin/main` at `ad35492` (Phase 4 Step 7, final verdict
PASS). No code changes in this step — audit only, per its own
instructions.

**Method**: every finding below is sourced from reading the current code,
the current Phase 4 doc set
([architecture](./phase4-pricefloor-deal-registry.md),
[Step 4](./phase4-step4-lifecycle-and-decision.md),
[Step 5](./phase4-step5-deals-api.md),
[Step 6](./phase4-step6-my-deals.md),
[Step 7](./phase4-step7-final-e2e-and-release-audit.md)), the root docs
(`README.md`, `PRODUCT.md`, `CONTRIBUTING.md`, `DESIGN.md`), the
`agrifeed-contract` repository's `SECURITY.md` and contract source, the
GitHub Actions run history (`gh run list`), and the open-issues list
(`gh issue list`) — not from re-deriving prior reports' conclusions from
memory. Every claim below is a fact about the current baseline; where a
Phase 3/4 finding has since been resolved, this doc says so explicitly
rather than re-listing it as open.

## Headline finding: CI has been failing since before Phase 4 began

This is the single most consequential thing this audit found, and it was
**not previously known or reported anywhere in this project's docs**:

```
$ gh run list --limit 10
completed  failure  docs(phase4): finalize e2e validation...   2026-09-10T14:04:31Z
completed  failure  feat(web): add persistent pricefloor...    2026-09-10T13:46:31Z
completed  failure  feat(api): expose persistent pricefloor... 2026-09-10T13:10:49Z
completed  failure  docs(phase4): document lifecycle...        2026-09-10T12:49:40Z
completed  failure  feat(web): persist deployed pricefloor...  2026-09-10T12:11:27Z
completed  failure  feat(indexer): support multi-instance...   2026-09-10T10:56:25Z
completed  failure  docs(phase4): define persistent...         2026-09-10T09:49:35Z
completed  failure  fix(web): polish cross-page consistency... 2026-09-10T09:37:59Z
completed  failure  feat(web): redesign reporting network...   2026-09-09T16:03:05Z
completed  success  fix(web): fetch oracle decimals live...    2026-09-08T19:24:45Z
```

The last **green** run was `8cb1da4` (2026-09-08). Every push since
`de12ce2` (2026-09-09, late Phase 3) through the current HEAD `ad35492`
— 9 consecutive pushes, all of Phase 4's real work — has failed CI. The
`typecheck` and `lint` steps pass; `pnpm test` fails and `pnpm build`
never even runs (the job aborts on first failure):

```
services/indexer test: Error: connect ECONNREFUSED ::1:5433
FAIL src/instances.test.ts / src/poll.test.ts / src/db/schema.test.ts / src/api/deals.test.ts
Tests  2 failed | 51 skipped (53)
```

**Root cause**: `services/indexer`'s test files default to a real
Postgres test database at `localhost:5433` (`TEST_DATABASE_URL`,
matching every real-database test convention this project has used since
Phase 4 Step 2 — see `instances.test.ts`, `poll.test.ts`,
`schema.test.ts`, `deals.test.ts`, all real-Postgres by design, never
mocked). `.github/workflows/ci.yml`'s `node` job (the one that runs
`pnpm test`) provisions **no Postgres service at all**. A separate
`indexer-migration` job does have a Postgres service, but on port `5432`,
and it only runs `pnpm --filter @agrifeed/indexer migrate` — never the
actual test suite. This gap has existed since `poll.test.ts` was
introduced (commit `22b1d1c`, "fix(indexer): reconcile oracle events and
contributors", 2026-09-09, the first commit to require a real database in
a CI-executed test file) and was never closed as the indexer's test
surface grew through Phase 4.

**Impact**: every test-count claim in every Phase 3 Step 9+ / Phase 4
report in this repository (including this session's own) was true when
run **locally**, but has never been independently confirmed by CI. This
does not mean any of those numbers were fabricated — this audit
independently re-ran the full suite locally against `ad35492` and it is
genuinely green, 123/123 — but it means the project's own stated
"before opening a PR: `pnpm typecheck`, `pnpm lint`, `pnpm build`" gate
in `CONTRIBUTING.md` has been silently unenforced by CI for the indexer's
tests specifically, for the project's most safety-critical recent work
(the deal registry). A regression introduced today in `services/indexer`
would not be caught by CI at all right now.

**Classification: P0.** Not because anything is currently broken (it
isn't — local evidence is solid), but because a broken CI signal is a
false sense of safety for every commit going forward, and this project's
own stated engineering standard depends on it. See §Contract 4 (finding
F10) and the proposed sequence below for the (small) recommended fix.

---

## 1. Contract readiness

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| C1 | AgriPriceFloor's core lifecycle (`initialize`/`fund`/`settle`) is correct and live-proven. | Real Testnet `settle()` execution with hand-verified payout math (Phase 4 Step 4); real multi-instance isolation re-confirmed independently this session (Step 7). | None — this is the product's working core. | ACCEPTED (strength) |
| C2 | `cancel()`'s Cancelled event carries no corresponding storage flag; a funded-then-cancelled instance's storage becomes indistinguishable from "never funded." | Read directly from `cancel()`'s body (`agrifeed-contract/contracts/agripricefloor/src/lib.rs`); documented in [Step 4](./phase4-step4-lifecycle-and-decision.md) with the exact line. Mitigated today by the indexer's event-sourced design (status is never re-derived from a storage snapshot), but that mitigation depends on unbroken event coverage. | Real, but currently masked by architecture; would matter if indexer coverage were ever interrupted for longer than the RPC's event-retention window. | **P1** — item B, see ranking below |
| C3 | `cancel()` has never been exercised live end to end; its grace periods (`UNFUNDED_CANCEL_GRACE`/`SETTLE_FAILURE_GRACE`, both real `48*60*60`-second constants) make a live test a genuine multi-day wait with no fast-forward possible on Testnet. | Confirmed by reading the constants directly (unchanged since Step 4); confirmed again this session (Step 7 §A) that no attempt was made to fake or accelerate them. | Real coverage gap, but honestly and consistently disclosed everywhere it matters (docs page, deal detail page, `DemoFlow.tsx`'s `LiveExecutionDisclosure`). | **P1** for verification value / **ACCEPTED LIMITATION** for "can this ship as-is" |
| C4 | Neither `AgriPriceFloor` nor `AgriFeedOracle` has an upgrade mechanism. | `grep -rn "upgrade" contracts/*/src/lib.rs` in `agrifeed-contract` returns nothing. | Every deployed instance is permanently immutable; a future contract fix (e.g. C2's storage flag) can only apply to instances deployed *after* the fix, never retroactively. This is a real constraint on any future contract change, not a bug. | ACCEPTED LIMITATION (by design — no admin key on PriceFloor at all, consistent with its trust model) |
| C5 | `agrifeed-contract`'s own `SECURITY.md` states explicitly: "an engineering example, not yet audited... do not deploy them with real value until they have been reviewed by security professionals." | Read directly, `agrifeed-contract/SECURITY.md` lines 42-44. | This is the actual, current ceiling on any "production readiness" claim for the contracts themselves — no amount of app/indexer/frontend work changes this. | ACCEPTED LIMITATION (explicitly, by the contract repo's own maintainers) — any Phase 5+ plan that implies real-value production use without addressing this would be a false claim |
| C6 | Oracle admin centralization (one admin key controls the node set, threshold, and tracked commodities) is real and self-disclosed. | `SECURITY.md`'s own threat model section; also disclosed on `/docs`. | Consistent, honest positioning as a reference implementation, not a decentralization overclaim. | ACCEPTED LIMITATION |

## 2. SDK/application readiness

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| S1 | Transaction primitives (`deploy.ts`, `pricefloor.ts`, `multiparty.ts`) are typed, tested (27 SDK tests, unchanged since Step 7), and have real Testnet evidence behind every write path except `cancel()`. | `packages/sdk/src/*.test.ts`; Step 2/4 real deploy/init/fund/settle tx hashes. | Solid foundation. | ACCEPTED (strength) |
| S2 | Multiparty signing is correct and live-proven **via CLI/SDK signing with locally-held keys** (Step 2, Step 4). It has never been proven correct via a real, currently-installed browser Freighter extension. | Step 2/4 reports explicitly distinguish CLI/SDK evidence from the still-open browser question; this session found no Freighter extension available at all to re-test (see D below). | The feature the product is actually built around (two independent parties, each with their own wallet, signing in a browser) has real-world evidence only for the "both keys held by one operator" case, not the "two separate humans, two separate wallets" case that is the actual product story. | **P1** — item D, ranked highest of the five explicit items below |
| S3 | Error handling is typed and consistent everywhere checked: `OracleError`/`IndexerUnavailableError`, no bare `catch {}`, explicit wrong-wallet defense-in-depth in `signAuthEntryAsExpectedParty` before ever requesting a signature. | Read `packages/sdk/src/wallet.ts` and `apps/web/lib/api.ts` directly this step. | Matches `CONTRIBUTING.md`'s stated standard exactly. | ACCEPTED (strength) |
| S4 | `deploy.ts`'s transaction validity window (`.setTimeout(60)`) produced **three consecutive real `tx_too_late` failures** in Step 4's live E2E run before a fourth attempt succeeded, because a human's real Freighter-approval latency exceeded 60 seconds more than once. | Directly observed and logged in [Step 4](./phase4-step4-lifecycle-and-decision.md)'s "Errors and fixes" section (carried in this session's history) — a real, repeated, user-facing failure mode, not hypothetical. | Every real deploy this project has ever done live hit this at least once. A production user would likely hit it too. The UI handles it honestly (clean `failed` state, "Start over") but does not reduce its likelihood. | **P1** — cheap, evidence-backed, directly actionable (widen the window or add a retry-with-fresh-envelope path) |
| S5 | Recoverable vs non-recoverable flows are now correctly two-tiered since Phase 4 Step 6: an in-progress signing session (draft terms, partial signatures) is **never** recoverable, by design, and the UI says so explicitly; a contract that reached `initialize` is recoverable as an indexed record via My Deals, independent of any browser session. | `DealPersistenceNotice.tsx`, `DealDetailView.tsx`'s `RecoveryGuidance`, both re-read this step. | Correctly scoped and consistently communicated — no finding, this is Phase 4's actual achievement working as intended. | ACCEPTED (strength) |

## 3. Indexer/API readiness

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| I1 | Multi-instance registry, lifecycle/event ingestion, and API correctness are all real and independently re-verified this session's Phase 4 Step 7 (fresh RPC reads matched fresh indexer/API reads, field-for-field, for 4 real instances). | Step 7 report. | Solid. | ACCEPTED (strength) |
| I2 | **CI does not validate the indexer's test suite at all** (see headline finding above). | `gh run list` / `gh run view --log-failed`. | See headline. | **P0** |
| I3 | `services/indexer` has no `dotenv`/`.env.local` auto-loading of its own; only `apps/web` (via Next.js) gets that for free. Item A. | `services/indexer/src/env.ts` reads `process.env` directly; confirmed by testing (Phase 4 Step 7 §E) that a bare `pnpm dev:indexer` needs either manual `export` or an explicit `source .env.local` first. | Local-dev-only friction, already root-caused, already worked around for this session (`.env.local`'s `DATABASE_URL` port corrected in Step 7, gitignored, no secret exposure). No evidence this affects anything beyond a developer's first local run. | **P2** — item A, ranked lowest of the five explicit items |
| I4 | `registerInstance`'s tests make **real live calls to Testnet RPC** inside the test suite (`instances.test.ts`). | Read the test file directly; confirmed this pattern is deliberate ("real network, no mocks" per its own doc comment). | Once CI is fixed (I2), these same tests will make CI's green/red status depend on Testnet RPC's own availability and latency, not just this repo's code — a flaky-network day could fail an unrelated PR. | **P2** — worth deciding, when I2 is fixed, whether these need retry tolerance or a separate non-blocking job; not a reason to delay the I2 fix itself |
| I5 | Polling's 25-contract-id-per-request ceiling (`MAX_CONTRACT_IDS_PER_REQUEST`, Step 2) remains unsolved; only 4 real instances exist today, nowhere near the ceiling. | `services/indexer/src/instances.ts`'s own doc comment, unchanged since Step 2. | None at current scale. | ACCEPTED LIMITATION / DEFERRED until real usage approaches the ceiling |
| I6 | No automated alerting exists if polling silently stalls; the only signals are `Freshness`/`StaleBanner` UI components (someone has to look) and structured JSON logs (someone has to read them). | `services/indexer/src/logger.ts` — plain structured stdout logging, no external sink, no metrics, no alert integration anywhere in the repo. | Acceptable for a reference implementation with no production deployment target established (see §6); would be a real gap for anything actually running unattended for real users. | ACCEPTED LIMITATION at current stage |
| I7 | `migrate()` is idempotent and self-healing (the F-07 stale-constraint fix), re-confirmed live against the real dev database this session (Step 7). | `services/indexer/src/db/schema.test.ts`; live `migrate()` run in Step 7. | Solid. | ACCEPTED (strength) |

## 4. Frontend/product readiness

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| F1 | Markets, Commodity Detail, Reporting Network are stable and unchanged since Phase 3; the "source unavailable, never fabricated" pattern is consistently applied (`SourceUnavailable.tsx` used identically across `/nodes`, `/commodity/[symbol]`, and (new in Phase 4) `/deals`, `/deals/:contractId`). | Direct code read this step. | Solid, consistent design system application. | ACCEPTED (strength) |
| F2 | Price Protection, My Deals, and deal recovery are real, live-verified (Steps 4, 6, 7), correctly isolated per contract id, and correctly distinguish indexed vs. on-chain state everywhere checked. | Step 6/7 reports. | Solid — this is Phase 4's actual deliverable working as claimed. | ACCEPTED (strength) |
| F3 | `README.md`'s Routes table and Quickstart, and `PRODUCT.md`'s "Who this is for" section, **do not mention `/deals`, `/deals/:contractId`, `/api/deals`, or any Phase 4 capability at all.** `DESIGN.md`'s component inventory still describes `DealPersistenceNotice` by its pre-Step-6 copy ("a deal in progress exists only in the current browser tab") and never mentions `DealCard`/`DealDetailView`/`IndexedDealStatusBadge`/`DealFieldRow`. | Direct read of all three files this step. | A developer or reviewer reading only the top-level docs would not know Phase 4 shipped. This directly undercuts the project's own stated audience ("developers... reviewers... deciding whether to trust or run this feed," `PRODUCT.md`). | **P1** — cheap, no code risk, directly serves the project's own stated positioning goal |
| F4 | Accessibility/responsive behavior has strong **static** evidence (correct heading hierarchy confirmed via live DOM query, correct responsive Tailwind classes confirmed present in served HTML, `:focus-visible` rule verified unchanged and not overridden anywhere new) but **no live narrow-viewport screenshot and no live keyboard-tab-order walkthrough have ever actually been obtained**, across two separate steps (Phase 4 Steps 6 and 7), because this session's browser-automation `resize_window` tool does not actually change the rendered viewport and a `Tab` keypress did not reliably move `document.activeElement` off `<body>` in this environment. | Both Step 6 and Step 7 reports disclose this identically; re-confirmed this step by reading both. | Real, disclosed (not glossed over) verification gap — distinct from an implementation gap. Code review gives reasonable confidence (identical patterns to already-shipped, already-visually-verified Phase 3 components) but is not the same as having actually seen it. | **P2** — recommend one real manual pass (a real phone or a real resized desktop browser, by a human) before any broader release; cheap, no code change implied unless something is actually found |
| F5 | Freighter's real-world compatibility remains an open, unresolved question: Phase 3 Step 7 found an *installed* Freighter version that could not parse `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries; this session's environment (Phase 4 Steps 6-7 and this step) has **no Freighter extension installed at all**, so that specific finding could not be re-tested either way. | Phase 3 Step 7 (carried in this session's history); this step's own direct check: `window.freighterApi === undefined` on a live `/demo` page load, confirmed twice across Steps 6 and 7. | The core two-party signing feature's real-world browser compatibility has never been confirmed working, only confirmed *not* working (once, on one version, months of Freighter releases ago). | **P1** — item D, see ranking below |
| F6 | No UI copy anywhere checked overstates decentralization, fund safety, or production readiness beyond current evidence: `NetworkBadge` always shows full "Stellar Testnet" text (never a color-only dot), `/docs`' own "current limitation"/"environment note" badges are used consistently, and the oracle's node-set language on `/docs` explicitly says "not the large, permissionless node set... decentralized usually implies." | Direct code read this step (`NetworkBadge.tsx`, `docs/page.tsx`). | This is a genuine strength worth stating explicitly, not just an absence of a finding — the audit specifically checked for overstatement and found none. | ACCEPTED (strength) |
| F7 | Multi-session/two-device signing remains correctly deferred and is not implied anywhere, including in the new recovery UI — re-verified by reading `RecoveryGuidance`'s actual current copy this step, not assumed from Step 6's report. | `DealDetailView.tsx`. | Item E; no drift found. | ACCEPTED (intentional deferral, confirmed still accurate) |

## 5. Testing and verification

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| T1 | Automated test coverage: 123 tests (27 SDK + 43 web + 53 indexer), all passing locally against `ad35492`, re-run this step. | Direct `pnpm test` run this step. | Real, current, accurate. | ACCEPTED (strength) — but see I2: not CI-verified |
| T2 | Real Testnet evidence exists for deploy, register, initialize, fund, and settle (not cancel) — re-independently-confirmed this session via fresh RPC reads (Step 7), not merely cited from history. | Step 7. | Solid. | ACCEPTED (strength) |
| T3 | Browser E2E coverage is real but narrow: live deploy/init/fund/settle has been exercised through the actual UI at least once (Step 3/4); My Deals' list/detail pages have been live-verified for disconnected, error, not-found, invalid, and populated (via direct navigation, not wallet-driven) states, but **never** with an actual connected Freighter wallet driving the list (blocked by F5/D — no Freighter available). | Step 6/7 reports, re-confirmed this step. | The one browser flow never actually exercised end-to-end with a real wallet is farmer/buyer-driven "connect and see my deals" — the exact flow a real user would use. | Ties to **P1** item D |
| T4 | `services/node-relayer` has **zero automated tests** and no `test` script in its `package.json`. | `find services/node-relayer -iname "*.test.ts"` → empty; `package.json` has no `test` key. | Its correctness (the sole write path feeding real prices into the oracle) rests entirely on one-time "verified live" comments in source/`.env.example`, never regression-tested. A future change to an adapter has no automated safety net. | **P1** — it is the project's only untested write path into anything on-chain |
| T5 | This project's own `CONTRIBUTING.md` states "No em dash in commit messages, docs, or UI copy"; em dashes appear in 4 of the docs files and 30 of the frontend component/page files. | `grep -rl "—" docs/*.md README.md PRODUCT.md` → 4 files; same against `apps/web/components apps/web/app` → 30 files. | Cosmetic, no functional impact, but a real, verifiable inconsistency between a stated standard and actual practice across the whole project (not introduced by any single step). | **P2** |

## 6. Operations/deployment

| # | Finding | Evidence | Impact | Classification |
|---|---|---|---|---|
| O1 | Local dev setup works and is documented, but `README.md`'s Quickstart omits `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`/`PRICEFLOOR_WASM_HASH` — required for the Phase 4 registration flow to work at all locally. | `README.md` Quickstart section vs. `.env.example`'s actual variable list. | Ties to F3; a newcomer following only the README would have a working oracle/ticker but a broken deal-registration flow with no explanation why. | **P1** (same root cause and same fix as F3) |
| O2 | Database startup/recovery: `docker-compose.yml` declares Postgres on host port 5432; on the machine this session ran on, that port was already occupied by an unrelated project's container, so this repo's own compose service never started, and the real working database has been on port 5433 the entire time. Root-caused and fixed locally in Phase 4 Step 7 (`.env.local`, gitignored). | Phase 4 Step 7 §E; re-confirmed still correct this step (`docker ps -a` unchanged). | Machine-specific, not a repo defect — `docker-compose.yml`/`.env.example` correctly assume port 5432 is free, which is the reasonable default. No further action needed unless this recurs on another machine. | ACCEPTED LIMITATION (environment-specific, already fixed where it mattered) |
| O3 | Indexer startup behavior depends on either manually-exported env vars or explicitly sourcing `.env.local` — see I3/item A. | — | — | **P2** (duplicate of I3, listed once) |
| O4 | RPC assumptions: both the indexer and the SDK hardcode/default to `https://soroban-testnet.stellar.org` with no fallback RPC endpoint or retry-with-backoff strategy visible in `poll.ts`/`instances.ts` beyond per-event try/catch. | `services/indexer/src/env.ts`'s default; `poll.ts`'s per-event error handling (swallows and logs, does not retry the specific call). | Acceptable for Testnet development; a single public RPC endpoint with no fallback is a real availability risk if this ever needs to run unattended for real users. | ACCEPTED LIMITATION at current (reference-implementation) stage |
| O5 | Logging/observability: structured JSON to stdout in both `services/indexer` and `services/node-relayer`; no external sink, no metrics, no dashboards, no alerting anywhere in the repo. | `logger.ts` in both services, read directly this step. | Matches `CONTRIBUTING.md`'s stated minimum ("both run unattended... log structured JSON"), nothing more is claimed anywhere, so no gap between claim and reality — but also no evidence of readiness for actually running unattended for real stakes. | ACCEPTED LIMITATION — consistent with "no production deployment target established" (see O7) |
| O6 | Secrets handling is disciplined everywhere checked: `NODE_RELAYER_SECRET_KEY` is never logged, never committed (`.env.local`/`.env` gitignored, verified), and `services/node-relayer/Dockerfile` has an explicit comment enforcing runtime injection, never baking it into the image. | Direct read of `Dockerfile`, `.gitignore`, `git check-ignore -v .env.local`. | Strength. | ACCEPTED (strength) |
| O7 | **No production deployment target exists anywhere in this repo.** Only `services/node-relayer` has a `Dockerfile`; `apps/web` and `services/indexer` have none. No hosting platform config (Vercel, systemd unit, k8s manifest, etc.) exists for any service. | `find . -iname "Dockerfile*"` → one match, `services/node-relayer/Dockerfile`; no other deployment config found anywhere in the repo. | This audit was explicitly told not to assume production infrastructure exists if unverified — confirmed: it does not exist. Any Phase 5+ plan that implies "deploy this for real users" needs to originate that infrastructure from scratch; it is not a gap in something that already exists. | ACCEPTED LIMITATION, explicitly stated rather than assumed either way |
| O8 | CI/build/release process: typecheck/lint/build/research-notebook jobs are real and currently green; the test job is currently broken (I2/headline finding). One already-tracked, already-open issue (`#3`, "Migrate CI workflow off Node 20 (deprecated)") exists in this repo's own issue tracker. | `gh run list`, `gh issue list --repo AgriFeed/agrifeed-app`. | See headline finding for the test-job gap; the Node 20 issue is minor and already correctly tracked by the team, not a new finding. | I2 is **P0**; the Node 20 issue is **P2**, already DEFERRED by its own open-issue status |
| O9 | Testnet deployment reproducibility: `agrifeed-contract/docs/testnet-deployment.md` documents the full deploy sequence step by step, and this project has independently followed it live multiple times across Phase 2 and Phase 4 with consistent, reproducible results (same wasm hash confirmed identical across builds, per `.env.local`'s own comment history). | `agrifeed-contract/docs/testnet-deployment.md`; cross-session consistency of `PRICEFLOOR_WASM_HASH`. | Solid, genuinely reproducible. | ACCEPTED (strength) |

## 7. Product claims and positioning

Combines F3/F6/O1 above into a direct answer to the question asked:

**Claims that exceed current evidence, found**: none in `README.md`,
`PRODUCT.md`, or any live UI copy checked this step — see F6. The one
real positioning problem is not overclaiming, it's **under-claiming by
omission**: `README.md`, `PRODUCT.md`, and `DESIGN.md` simply don't
mention Phase 4 exists (F3), which is a currency gap, not a credibility
gap. `agrifeed-contract/SECURITY.md`'s explicit "not yet audited, do not
deploy with real value" framing is the one hard ceiling on any future
"production ready" claim this project could make, and nothing checked
this step tries to claim past it.

---

## Explicit ranking of the five named items (A–E)

Not auto-promoted to implementation, ranked strictly by evidence-based
actual impact, as instructed:

| Rank | Item | Classification | Why this rank |
|---|---|---|---|
| 1 (highest) | **D. Freighter/browser wallet compatibility** | **P1** | Blocks the product's actual differentiating feature (two independent human parties, each with their own wallet, signing in a browser) from having ever been proven to work in any currently-tested environment. Everything else about Price Protection is proven; this one link in the chain has only ever been proven *not* to work (once, on an old Freighter version) or untested (no extension present). Highest real user-facing risk of the five. |
| 2 | **B. PriceFloor Cancelled storage-state gap** | **P1** | Real architectural gap, correctly mitigated today by event-sourcing, but the mitigation has a real failure mode (a polling outage longer than the RPC retention window) that grows more likely to matter as the registry accumulates more real deals over time. Not urgent at 4 instances; genuinely important before this scales. |
| 3 | **C. cancel() unverified live** | P1 for verification value / **ACCEPTED LIMITATION** for shipping as-is | Structurally blocked (real 48-96h wait, no way to fast-forward), and — critically — already honestly disclosed everywhere it matters. Lower urgency than B because the disclosure itself is the mitigation and it's already complete; this is "worth eventually proving," not "currently misleading anyone." |
| 4 | **A. `.env.local` auto-load gap** | **P2** | Narrowest possible blast radius: local development only, already root-caused, already has a working manual workaround, affects zero end users or real deployments. |
| 5 (lowest) | **E. Multi-session/two-device signing deferred** | **DEFERRED**, confirmed correctly so | This was never a bug to begin with — it is a scope decision, made explicitly, and re-verified this step to still be accurately and consistently disclosed everywhere (no drift, no accidental implication of support anywhere in the new recovery UI). Nothing to rank against risk; it is working exactly as intended. |

## New blockers identified during Phases 3–4

One, and it is the headline finding above: **CI has not validated
`services/indexer`'s test suite since before Phase 4 began** (I2). This
was not flagged in any Phase 3 or Phase 4 report — every one of those
reports' test-count claims was independently re-verified as true by this
audit, but none of them checked whether CI itself was confirming the same
thing, and it was not. No other new blocker was found: every other gap
this audit surfaced (F3/F4/F5/O1/T4/T5) was already either known and
disclosed in an existing report, or is a documentation-currency issue
directly caused by Phase 4 landing without a corresponding README/
PRODUCT.md/DESIGN.md update.

---

## Proposed Phase 5 sequence

Ordered for highest risk reduction first, smallest necessary scope, real
evidence over speculative engineering, no duplicate functionality, no new
contracts unless truly required, no frontend rebuild:

1. **Fix CI's indexer test job (P0, I2).** Smallest possible change: add
   a `postgres:16-alpine` service to the `node` job in
   `.github/workflows/ci.yml`, matching the exact convention this
   project's own tests already use (`agrifeed_test` on port `5433`, or
   point `TEST_DATABASE_URL` at whatever port the service uses) — no
   application code change required, this is a CI-config-only fix. This
   is first because every other step in this sequence depends on CI
   actually meaning something again.
2. **Freighter re-verification (P1, item D).** Manually test the current
   two-party `initialize` flow against the latest published Freighter
   release, in a real browser, with the extension actually installed.
   Record exact evidence either way (version number, exact error or exact
   success). No code change unless a real, currently-reproducible
   incompatibility is found — if one is, scope a fix as a separate,
   evidence-driven follow-up rather than guessing at one now.
3. **`tx_too_late` resilience (P1, S4).** Small, targeted SDK change:
   widen or make configurable the transaction validity window in
   `deploy.ts`/the multiparty submit path, or add a single
   retry-with-a-fresh-envelope path, directly addressing the repeatedly
   observed real failure mode from Step 4. Smallest fix that removes a
   proven, repeated point of user friction.
4. **Documentation currency pass (P1, F3/O1).** Update `README.md`'s
   Routes table and Quickstart (add `/deals`, `/deals/:contractId`,
   `/api/deals`, the WASM-hash env vars), `PRODUCT.md`'s "Who this is
   for," and `DESIGN.md`'s component inventory (current
   `DealPersistenceNotice` copy, the four new My Deals components) to
   reflect Phase 4. No code, no design decisions — purely bringing
   existing docs in line with what already shipped.
5. **PriceFloor `Cancelled` storage flag (P1, item B).** Only after 1-4:
   this requires a new contract build, a new wasm hash, and new
   deployments going forward (existing instances are immutable, see C4) —
   real scope, not urgent at current usage (4 real instances), and the
   exact fix is already fully specified in
   [Step 4's report](./phase4-step4-lifecycle-and-decision.md) (add
   `DataKey::Cancelled`, mirroring `Settled`). Sequenced last among the
   P1s because it has the largest blast radius (a contract change) for
   the least urgent actual risk today.
6. **`services/node-relayer` regression tests (P1, T4), time permitting.**
   The project's only completely untested write path into anything
   on-chain. Smallest useful scope: unit tests for the adapters' parsing
   logic (the actual risk surface — a source changing its response shape
   silently), not a live-network integration suite.

Explicitly **not** sequenced into Phase 5 on current evidence: a contract
security audit (C5 — real, but far beyond "smallest necessary scope" for
a Testnet reference implementation, and this project's own `SECURITY.md`
already discloses the gap honestly rather than hiding it); any production
hosting/deployment infrastructure (O7 — no evidence this repo has ever
had one, and none was requested); narrow-viewport/keyboard manual QA
(F4 — cheap and worth doing, but not risk-reducing enough to rank above
the P1s, better scheduled opportunistically); the em-dash convention
cleanup (T5 — purely cosmetic); and multi-session signing (E — correctly
deferred, no evidence it needs revisiting yet).

---

## Full findings index

| ID | Area | Classification |
|---|---|---|
| Headline / I2 | CI does not run indexer tests | **P0** |
| C1 | Core PriceFloor lifecycle | ACCEPTED (strength) |
| C2 / B | Cancelled storage flag absent | **P1** (rank 2 of 5) |
| C3 / C | cancel() live-unverified | P1 verification / ACCEPTED shipping |
| C4 | No contract upgrade mechanism | ACCEPTED LIMITATION |
| C5 | Contracts not yet audited | ACCEPTED LIMITATION |
| C6 | Oracle admin centralization | ACCEPTED LIMITATION |
| S1 | SDK transaction primitives | ACCEPTED (strength) |
| S2 / D | Browser Freighter multiparty unproven | **P1** (rank 1 of 5) |
| S3 | SDK error handling | ACCEPTED (strength) |
| S4 | tx_too_late repeated real failures | **P1** |
| S5 | Recoverable/non-recoverable flows | ACCEPTED (strength) |
| I1 | Multi-instance registry correctness | ACCEPTED (strength) |
| I3 / A | `.env.local` indexer auto-load gap | **P2** (rank 4 of 5) |
| I4 | Live-RPC tests once CI is fixed | **P2** |
| I5 | 25-contract-id polling ceiling | ACCEPTED LIMITATION / DEFERRED |
| I6 | No automated stale-data alerting | ACCEPTED LIMITATION |
| I7 | Migration idempotency/self-heal | ACCEPTED (strength) |
| F1 | Markets/Detail/Reporting stability | ACCEPTED (strength) |
| F2 | Price Protection/My Deals/recovery | ACCEPTED (strength) |
| F3 | README/PRODUCT.md/DESIGN.md stale re: Phase 4 | **P1** |
| F4 | Accessibility/responsive: static-only evidence | **P2** |
| F5 / D | Freighter compatibility unresolved | **P1** (same as S2) |
| F6 | No overstated claims found | ACCEPTED (strength) |
| F7 / E | Multi-session signing correctly deferred | DEFERRED (confirmed accurate) |
| T1 | 123 tests passing locally | ACCEPTED (strength) |
| T2 | Real Testnet evidence, independently re-confirmed | ACCEPTED (strength) |
| T3 | No wallet-driven My Deals browser E2E yet | ties to P1 (D) |
| T4 | node-relayer has zero tests | **P1** |
| T5 | Em dash convention violated project-wide | **P2** |
| O1 | README Quickstart missing WASM-hash vars | **P1** (same fix as F3) |
| O2 | `.env.local` DB port, machine-specific | ACCEPTED LIMITATION (fixed) |
| O3 | Duplicate of I3 | **P2** |
| O4 | Single RPC endpoint, no fallback | ACCEPTED LIMITATION |
| O5 | Minimal logging, no alerting/metrics | ACCEPTED LIMITATION |
| O6 | Secrets handling discipline | ACCEPTED (strength) |
| O7 | No production deployment target exists | ACCEPTED LIMITATION (explicit) |
| O8 | CI Node 20 deprecation (tracked issue #3) | **P2**, already DEFERRED |
| O9 | Testnet deployment reproducibility | ACCEPTED (strength) |

## Files changed this step

```
docs/phase5-readiness-and-scope.md | new (this file)
```

No application code, test, schema, contract, or CI config was modified.
The existing test suite was re-run for verification only (123/123
passing, unchanged from Phase 4 Step 7) and was not touched.
