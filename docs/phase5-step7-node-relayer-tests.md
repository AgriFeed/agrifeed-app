# Phase 5 Step 7: node-relayer Automated Test Coverage

**Baseline**: `origin/main` at `030f4b2` (Phase 5 Step 6). Baseline test
count confirmed before any change: **139/139** (41 SDK + 43 web + 55
indexer; `services/node-relayer` had no test script at all).

## Verdict: **PASS**

Meaningful, deterministic automated coverage now exists for the write
path this project's own [readiness audit](./phase5-readiness-and-scope.md)
(finding T4) flagged as its "only completely untested write path into
anything on-chain." Two real defects were found during the audit and
fixed (one before writing tests, with the user's explicit sign-off; one
discovered *by* the new tests and fixed immediately). Full suite: **194
tests** (up from 139, +55, 0 removed or weakened), all green; CI
confirmed green on the actual pushed commit.

## Initial audit

### 1-8: execution flow, established before writing any test

`index.ts`'s `main()` loads config (`env.ts`), reads the oracle's
`decimals` once, then runs `tick()` on a fixed interval forever. Each
`tick()`, for each of 8 tracked commodities independently: calls
`aggregatePrice()` (fetches from `[fetchFaoPrice, fetchImfPrice,
fetchAmisPrice]` via `Promise.allSettled`, converts each success to
USD/MT, takes the median, requires at least one real source), then
`submitPrice()` (builds a real `submit_price` invocation, signs with the
node's own server-held `Keypair`, submits, polls up to 20×1500ms for
confirmation). A failure for one commodity is logged and that commodity
is skipped **for this cycle only** — it is retried automatically on the
next interval tick, which is the relayer's only retry mechanism; there is
no immediate in-cycle retry anywhere. The relayer polls external HTTP
APIs (FAO, IMF, AMIS) and Soroban RPC; it does not subscribe to
anything. Credentials load from `NODE_RELAYER_SECRET_KEY` via
`Keypair.fromSecret`, required at startup, never logged.

### 9-10: what's deterministic vs. genuinely network-bound

Deterministic, unit-testable without any network: `parseSubmitIntervalSeconds`
(new, see below), `aggregatePrice`'s median/oldest-timestamp/never-fabricate
logic (given fake adapters), `toUsdPerMetricTonne`'s unit conversion,
`splitFaoRow`'s CSV parsing, `parsePcpsPeriod`'s date parsing, and
`submitPrice`'s entire transaction-construction/signing/error-classification
logic (given a stubbed RPC network boundary, following the exact same
"real logic, substituted network edge" pattern
`packages/sdk/src/soroban-tx.test.ts` already established in Phase 5
Step 4). Genuinely network-bound and correctly left untested by this
step: `fetchFromBulkCsv`/`ensureBulkCsvCached` (an 11.7MB real file
download + local disk cache, not something to fixture-fake without
either a real network call or a large committed binary fixture, neither
appropriate here) and every adapter's actual live upstream behavior
beyond its own decision logic (already covered separately, see below).

## Findings requiring a stop-and-report decision (per this step's own instructions)

Both were presented to the user before any test was written; answers
below.

### A. `NODE_RELAYER_SUBMIT_INTERVAL_SECONDS` — malformed config silently became `NaN`

**Fixed, with explicit approval.** The original `loadEnv()` computed
`Number(process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS ?? 3600)` with
no validation. A typo, empty string, or negative value silently produced
`NaN`, and `setInterval(fn, NaN * 1000)` fires almost immediately and
*repeatedly* in Node.js rather than throwing — a real runaway-submission
risk for an unattended process, not a cosmetic config error. This is
exactly the kind of malformed-configuration case this step's own category
A explicitly asks to cover, and testing it meaningfully required it to
actually fail rather than silently misbehave.

**Fix**: extracted `parseSubmitIntervalSeconds(raw: string | undefined):
number`, validating `Number.isFinite(value) && value > 0`, throwing a
clear error naming the actual invalid value. `loadEnv()` now uses it.
6 new tests cover the default, valid values, non-numeric strings, zero,
negative, and `Infinity`.

### B. `submit.ts` duplicates `packages/sdk/src/soroban-tx.ts`'s transaction lifecycle

**Not fixed — test-only this step, with explicit approval.**
`services/node-relayer/src/submit/submit.ts` has its own hand-written
build/prepare/sign/submit/poll implementation, completely separate from
`packages/sdk/src/soroban-tx.ts` (the module Phase 5 Step 4 fixed for the
`tx_too_late` staleness bug and gave explicit `isTxTooLate`/
`TxTooLateError` classification). `submit.ts` has neither: an ERROR
status still surfaces as a raw `JSON.stringify(sendResult.errorResult)`
dump, and its `.setTimeout(60)` is set before `prepareTransaction`,
without a `refreshTimeBounds`-equivalent step, the same latent pattern
Step 4 fixed elsewhere (lower risk here specifically, since this is an
unattended server-side signer with no human-approval-latency gap between
prepare and sign — but the same class of gap, structurally).

Tests in this step exercise `submit.ts` **exactly as it currently
behaves**, including this gap (its error messages are still the raw
JSON dump, confirmed by the tests, not idealized) — per the explicit
decision not to expand this step's scope into a refactor.
**Recommended follow-up, not implemented here**: make `submit.ts` reuse
`soroban-tx.ts`'s `submitAndConfirm`/`refreshTimeBounds`/`isTxTooLate`,
removing ~50 lines of duplicated, less-safe logic.

## Deterministic test strategy, by file

| File | New tests | What's actually exercised |
|---|---|---|
| `src/env.test.ts` | 14 | `parseSubmitIntervalSeconds` (default, valid, malformed, zero/negative, non-finite, error message names the bad value); `loadEnv` (missing secret, missing oracle id, malformed secret never echoed in the error, malformed interval surfaces its own clear error, a full successful load with a real-but-throwaway `Keypair.random()` secret); `TRACKED_COMMODITIES` (exact list, no duplicates). |
| `src/normalize/units.test.ts` | 5 | `toUsdPerMetricTonne`: USD/MT passthrough, real cents/lb→USD/MT conversion with the real constant, a realistic coffee-price figure, rejects an unrecognized unit, rejects an empty unit. |
| `src/normalize/aggregate.test.ts` | 9 | `aggregatePrice` against fake adapters conforming to the real `SourceAdapter` contract (not mocks of `aggregatePrice`'s own internals): odd-count median, even-count average, single-survivor case, "never fabricate when everything fails" (throws `SourceUnavailableError`), oldest-observation `source_ts` selection, per-source unit conversion happening *before* the median (not after), which sources actually contributed, exact decimal scaling with no float precision loss, rejects an unrecognized unit from a source. |
| `src/submit/submit.test.ts` | 8 | `submitPrice` against a stubbed RPC network boundary (see below): builds the real `submit_price` invocation with the real argument order/encoding (independently XDR-decoded and asserted, not read off a mock's call arguments); produces a real, independently cryptographically-verified signature (`Keypair.verify` against the transaction's own real hash); throws a typed `OracleError` on a rejected submission, naming the commodity; calls `sendTransaction` exactly once (no retry loop inside `submitPrice` itself); throws a typed `OracleError` for a real on-chain execution failure, distinctly from a submission rejection; throws (rather than hanging) when confirmation never arrives; never leaks the node's real secret key into any error message. |
| `src/adapters/fao.test.ts` | 7 | `splitFaoRow` (real quoted-CSV parsing, including an embedded comma inside a field); `tryClassicApi` against a stubbed `fetch` (picks the most recent year from real-shaped data; returns `null`, never throwing, on a non-ok response, a network failure, or an empty result set — each triggering the real bulk-CSV fallback path this step does not itself test). |
| `src/adapters/imf.test.ts` | 10 | `parsePcpsPeriod` (real format parsing, rejects malformed periods); `fetchImfPrice` against a stubbed `fetch`: single-indicator case, the documented COFFEE two-indicator average, oldest-of-two-dates selection, rejects an unmapped commodity, `SourceUnavailableError` on network failure and on non-ok HTTP, skips a null observation for the latest real one instead of fabricating a value, throws when every observation is null. |
| `src/adapters/amis.test.ts` | 3 | `fetchAmisPrice` always throws `SourceUnavailableError`, never a price — for a commodity with no AMIS product code (zero network calls, confirmed by not stubbing `fetch` at all and still passing); for the 4 commodities AMIS *does* have a product code for, regardless of whether its purely-diagnostic fetch succeeds or fails (both stubbed and asserted separately) — locking in the documented guarantee that AMIS can never contribute to a submitted price under any circumstance. |

**Total: 55 new tests**, all deterministic (fixed inputs, stubbed
network boundaries where a boundary exists, real application logic
everywhere else), no flakiness from real external state.

## A real defect the new tests themselves surfaced

Running the new suite the first time reported **110 tests, not 55** —
exactly double. `services/node-relayer`'s `build` script was `tsc -p
tsconfig.json` (the same config used for `typecheck`, with no
`tsconfig.build.json` excluding test files, unlike `packages/sdk` and
`services/indexer`, which both already had one). This meant `pnpm build`
compiled `*.test.ts` straight into `dist/*.test.js`, and vitest's default
file discovery picked up both `src/**/*.test.ts` and the compiled
`dist/**/*.test.js`, running every test twice. This defect existed before
this step (node-relayer's build config was always missing the exclusion)
but was invisible with zero test files to compile; adding the first ones
is what exposed it.

**Fixed**: added `services/node-relayer/tsconfig.build.json` (identical
pattern to `services/indexer`'s: `{"extends": "./tsconfig.json",
"exclude": ["src/**/*.test.ts"]}`), and pointed `build` at it. Confirmed:
`pnpm build` no longer emits any `dist/**/*.test.js`, and `pnpm test`
correctly reports 55, not 110.

## Final test count

| Workspace | Before this step | After |
|---|---|---|
| `packages/sdk` | 41 | 41 (unchanged) |
| `apps/web` | 43 | 43 (unchanged) |
| `services/indexer` | 55 | 55 (unchanged) |
| `services/node-relayer` | 0 (no test script) | **55** |
| **Total** | **139** | **194** |

No test was removed or weakened anywhere. `pnpm typecheck`, `pnpm lint`
(only `apps/web` has a lint script, unchanged, still clean), and `pnpm
build` all pass across the full workspace.

## Coverage observations

No coverage tool (`@vitest/coverage-v8` or equivalent) is configured
anywhere in this repository — confirmed by checking every workspace's
`package.json` and every `vitest.config.ts`, and by attempting `npx
vitest run --coverage` directly, which reports the dependency missing.
Per this step's own instruction ("use existing coverage tooling if
available... do not set an arbitrary coverage target merely to generate
a number"), no new coverage dependency was added just to produce a
percentage. What is actually covered, stated plainly instead:

- **Fully covered, deterministically**: config loading and validation
  (`env.ts`), the entire price-aggregation decision (`aggregate.ts`),
  unit conversion (`units.ts`), the entire `submit_price` transaction
  construction/signing/error-classification path (`submit.ts`), and
  every adapter's own parsing/decision logic given a controlled response
  (`fao.ts`'s `splitFaoRow`/`tryClassicApi`, `imf.ts`'s
  `parsePcpsPeriod`/`fetchImfPrice`, `amis.ts`'s always-throws guarantee).
- **Not covered by this step, and correctly so**: `fetchFromBulkCsv`/
  `ensureBulkCsvCached`'s real 11.7MB download and disk-cache behavior;
  any adapter's real live upstream response shape drifting from what's
  documented (that risk is inherent to consuming external, uncontrolled
  APIs and cannot be meaningfully unit-tested — it is instead what the
  project's own `.env.example` "verified live" comments and periodic
  manual re-verification are for); the real Soroban Testnet round trip
  of an actual `submit_price` call (this project already has that
  evidence from earlier phases' live oracle work; this step adds
  deterministic regression coverage for the decision logic around it,
  not a duplicate of that live evidence).

## Security/secret-handling observations

- `NODE_RELAYER_SECRET_KEY` is never logged anywhere in `src/` (grep
  confirmed, unchanged by this step).
- Every test that needs a `Keypair` uses `Keypair.random()` — a genuinely
  fresh, throwaway keypair generated in-process, funding nothing, reused
  nowhere — the identical convention `packages/sdk`'s own tests already
  established, never a real secret.
- A dedicated test (`submitPrice -- error messages never leak the
  signing secret`) asserts a rejected submission's error message does
  not contain the node's own secret key, and `env.test.ts`'s malformed-
  secret test asserts the same for `loadEnv`'s own error path.
- No secret or private key is committed anywhere in this diff (confirmed
  by reading every new/changed file's own content, not just by
  intention).

## CI evidence

Pushed as `cfde665`. Real GitHub Actions run
[`34577096104`](https://github.com/AgriFeed/agrifeed-app/actions/runs/34577096104) —
all three jobs passed: `node` (1m53s), `research` (39s),
`indexer-migration` (32s). Exact log output from the `node` job's `pnpm
test` step, this run, not predicted:

```
packages/sdk test:      Test Files  5 passed (5)
packages/sdk test:           Tests  41 passed (41)
apps/web test:          Test Files  3 passed (3)
apps/web test:               Tests  43 passed (43)
services/indexer test:  Test Files  4 passed (4)
services/indexer test:       Tests  55 passed (55)
services/node-relayer test:  Test Files  7 passed (7)
services/node-relayer test:       Tests  55 passed (55)
```

`services/node-relayer` reports exactly **55**, confirming the
`tsconfig.build.json` fix (double-counting to 110) holds in the real CI
environment, not just locally. No test was skipped anywhere; `pnpm
build` also completed successfully as part of the same job.

## Remaining untested behavior

- `submit.ts`'s duplicated, less-safe transaction lifecycle (finding B
  above) — tested as-is, not refactored; the recommended fix is
  documented, not implemented, per the explicit test-only decision.
- The bulk-CSV download/cache path in `fao.ts` — a real, large, external
  file fetch with local disk caching; left as a genuinely network-bound
  boundary, not unit-tested, consistent with this step's own instruction
  not to fabricate a mock network solely to manufacture coverage.
- Any adapter's real upstream API response format silently changing
  (a live-data risk inherent to any external HTTP integration, not
  something a deterministic unit test can catch — this project's
  existing practice of dated "verified live" comments and periodic
  manual re-verification remains the actual mitigation, unchanged by
  this step).
- No coverage percentage is reported, per the reasoning above; this
  section and "Coverage observations" together are the intended
  substitute.

## Files changed

```
services/node-relayer/package.json               | +2 -1 (test script, vitest devDependency, build script)
services/node-relayer/tsconfig.build.json         | new
services/node-relayer/src/env.ts                  | +22 -1 (parseSubmitIntervalSeconds, exported)
services/node-relayer/src/adapters/fao.ts         | +9 -3 (splitFaoRow, tryClassicApi exported)
services/node-relayer/src/adapters/imf.ts         | +3 -2 (parsePcpsPeriod exported)
services/node-relayer/src/env.test.ts             | new
services/node-relayer/src/normalize/units.test.ts | new
services/node-relayer/src/normalize/aggregate.test.ts | new
services/node-relayer/src/submit/submit.test.ts   | new
services/node-relayer/src/adapters/fao.test.ts    | new
services/node-relayer/src/adapters/imf.test.ts    | new
services/node-relayer/src/adapters/amis.test.ts   | new
pnpm-lock.yaml                                    | +3 (vitest linked into node-relayer)
docs/phase5-step7-node-relayer-tests.md           | new (this file)
```

No contract, Oracle, PriceFloor, Markets, Commodity Detail, Reporting
Network, Price Protection, My Deals, or API behavior was modified. The
only production-code changes are the two findings above (both disclosed,
both small, both directly required for this step's own stated goal of
meaningful, safe test coverage).
