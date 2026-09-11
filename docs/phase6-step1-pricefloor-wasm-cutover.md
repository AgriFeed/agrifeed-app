# Phase 6, Step 1 — PriceFloor Cancelled-Flag WASM Cutover

## Goal

Cut the `agrifeed-app` application/indexer configuration over from the
pre-Cancelled-flag PriceFloor WASM to the Cancelled-flag-bearing WASM
introduced in Phase 5 Step 6, with real evidence the cutover is correct and
does not regress existing functionality. This is a deployment/configuration
change: no contract logic, indexer architecture, or frontend behavior was
modified.

## Old hash / new hash

| | Value | Source |
| --- | --- | --- |
| Old hash | `05faa5704ac6f8fe0d21268b16782315a6573946bc6ab40b8277faf70eb43d53` | Pre-Cancelled-flag `agripricefloor` build (predates `agrifeed-contract` commit `9347841`) |
| New hash | `5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b` | Post-Cancelled-flag `agripricefloor` build (`agrifeed-contract` commit `9347841`, `fix(pricefloor): persist cancelled state`) |

**Exact new hash, independently re-verified this step** (not taken from the
abbreviated `5d99a31e...` in prior reports): at `agrifeed-contract` HEAD
`190f009` (current, `9347841` plus two CI-only commits, no contract code
changed since `9347841`), ran `stellar contract build --package
agripricefloor`, which reported `Wasm Hash:
5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b`, then
independently cross-checked with `sha256sum
target/wasm32v1-none/release/agripricefloor.wasm`, which returned the
identical value. Confirmed this commit is the one that introduced
`DataKey::Cancelled` via `git show 9347841 --stat` (touches
`contracts/agripricefloor/src/{lib,types,test}.rs`, nothing else).

## Configuration locations

Located every reference to `PRICEFLOOR_WASM_HASH` /
`NEXT_PUBLIC_PRICEFLOOR_WASM_HASH` across the repository and classified each:

| Location | Kind | Action taken |
| --- | --- | --- |
| `.env.local` (repo root) | Local-only runtime config (gitignored), read by `services/indexer` (`PRICEFLOOR_WASM_HASH`) and by `apps/web` builds run from the root (`NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`) | **Cut over** to the new hash |
| `apps/web/.env.local` | Local-only runtime config (gitignored), read by `apps/web` when built/run from that directory | **Cut over** to the new hash |
| `.env.example` | Committed, tracked template — both `PRICEFLOOR_WASM_HASH` and `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH` are blank placeholders with explanatory comments | No value to cut over (blank); left unchanged — comments already correctly describe the mechanism and do not hardcode a stale value |
| `.github/workflows/*.yml` (agrifeed-app CI) | CI values | Grepped: no hardcoded wasm hash anywhere in CI workflow files | No change needed |
| `services/indexer/src/instances.test.ts` | Test fixture constant (`PRICEFLOOR_WASM_HASH` local `const`, real Testnet RPC fixture, not read from env) | Kept the old-hash constant (renamed in a comment, not in code, to clarify it now represents "the old hash" for cutover-refusal tests) and added a new `NEW_PRICEFLOOR_WASM_HASH` constant with real new-wasm instance fixtures — see "Automated tests" below |
| `packages/sdk/src/pricefloor.ts` | Error-message prose only ("PRICEFLOOR_WASM_HASH", generic reference, no hardcoded value) | No change needed |
| `docs/*.md` (Phase 4/5 reports) | Historical documentation of past state | Left as historical record, not rewritten — this new report documents the current, post-cutover state |
| Production/runtime configuration | No separate production deployment exists for this project (Testnet-only, dev-environment configuration is the only running instance) — confirmed by re-reading `docs/phase5-readiness-and-scope.md`'s own disclosure that no production deployment target exists anywhere | `.env.local` (root and `apps/web`) **is** the only "runtime configuration" this project has |

## Indexer WASM-hash validation — exactly where, against what, for what operations

Read `services/indexer/src/instances.ts` in full to answer this precisely:

- **Where**: `registerInstance()`, the single function invoked by the
  `POST /pricefloor-instances` HTTP endpoint (`services/indexer/src/api/
  server.ts`).
- **Against what**: `instance.executable.wasmHash.toString()` (read live
  over Soroban RPC via `server.getContractInstance(contractId)`) compared
  for exact string equality against `env.pricefloorWasmHash` (the single
  currently-configured hash).
- **For what operations**: registration only — this check runs exactly
  once, the first time a client submits a contract id that is not already
  in `pricefloor_instances`. It is never re-run for an already-registered
  instance.
- **Does changing the configured hash affect legacy instances? No.**
  `isKnownPriceFloorInstance()` (used by the event-polling path) checks the
  database (`SELECT 1 FROM pricefloor_instances WHERE contract_id = $1`) or
  an exact match against the fixed `legacyContractId`
  (`PRICEFLOOR_CONTRACT_ID`, `CDHPDF4TZ...`) — **never** the wasm hash.
  Once an instance is registered, its row is permanent and its lifecycle
  polling is entirely independent of whatever `PRICEFLOOR_WASM_HASH` is
  currently configured. The fixed legacy instance is exempted from the
  wasm-hash check entirely, by contract-id equality, not by hash.

## Legacy pre-Cancelled-flag instance handling

Confirmed, both by code reading and by live evidence (below):

1. **Already-registered old-wasm instances remain registered and pollable
   forever**, regardless of the currently configured hash — the check
   above only runs at first registration.
2. **The one fixed legacy/demo instance**
   (`CDHPDF4TZDJVBFGSOGVTNEKQNNJQR326JSATYXY7ZWD63L6PS2NTJB47`, old wasm)
   remains watched unconditionally via `PRICEFLOOR_CONTRACT_ID`/
   `NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID`, which were deliberately **left
   unchanged** this step — this is correct: it is a real, already-funded/
   settled demo instance, not something to migrate or hide.
3. **`readInstanceStorageFields`'s handling of an absent `Cancelled` key**
   (every legacy instance's exact shape, forever, since Soroban contracts
   have no upgrade mechanism): `cancelledFlagObserved` defaults to `false`
   and is only ever set to `true` on an explicit `Cancelled: true` storage
   entry — absence is handled without error, exactly as documented in
   `InstanceStorageFields`'s own doc comment (Phase 5 Step 6, unchanged
   this step). No code change was needed or made here.

**Conclusion: this made all historical deals continue to work correctly.**
No already-registered instance (old or new wasm) became unreadable; only
the set of contract ids *eligible for future registration* changed.

## Migration-window decision: single-hash hard cutover (smallest safe change)

Considered whether the indexer must support both hashes simultaneously
during a migration window, and concluded **no** — a hard, synchronized
single-hash cutover is the smallest safe architecture, for three concrete
reasons confirmed by code reading:

1. **No re-validation ever happens.** As shown above, registration is a
   one-time gate; switching the configured hash cannot retroactively break
   or hide any already-registered instance, old or new wasm alike.
2. **Deploy and register happen in the same client session.** A new deal's
   contract is deployed (`NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`) and then
   immediately registered (`PRICEFLOOR_WASM_HASH`, same request cycle,
   `NewDealFlow.tsx`) — keeping both env values synchronized at every
   moment (as done here, in one coordinated change) means there is no
   window where a client deploys from one hash while the indexer expects
   the other.
3. **Building dual-hash support was not required by any real, observed
   need** — no deal is currently mid-flight in the narrow gap this would
   protect against (deployed-but-not-yet-registered, old wasm, exactly at
   the moment of cutover), and adding an `PRICEFLOOR_WASM_HASHES` (plural,
   allow-list) mechanism would be the kind of speculative engineering this
   project's Phase 5 principles already argue against building without a
   concrete, evidenced need. **Not built.**

**Disclosed limitation of this decision**: a hard cutover means a deal
deployed from the old wasm but not yet registered *at the exact moment of
cutover* would be refused registration afterward. This is a narrow,
inherent property of any single-hash-at-a-time design (it already existed
in the reverse direction before this step, for any old/new config
mismatch) and was accepted rather than engineered around, since the
project has no production deployment where an in-flight deal could
actually be caught in this window today.

## Implementation

Only configuration and test changes were made:

- `.env.local` (root): `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH` and
  `PRICEFLOOR_WASM_HASH` both updated to the new hash, with an updated
  comment explaining the cutover and cross-referencing this document.
  `PRICEFLOOR_CONTRACT_ID`/`NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID` (the fixed
  legacy instance) **left unchanged**, deliberately.
- `apps/web/.env.local`: `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH` updated to the
  new hash.
- `.env.example`: unchanged (blank placeholders, comments already correct).
- `services/indexer/src/instances.test.ts`: added a new `describe` block,
  "`registerInstance -- Phase 6 Step 1 WASM cutover (real network, no
  mocks)`", five new tests, all exercised against real Testnet RPC — see
  below.
- **No contract code changed.** No indexer architecture changed
  (`registerInstance`/`isKnownPriceFloorInstance`/
  `readInstanceStorageFields` are all byte-identical to before this step).
  No frontend behavior changed beyond the env value it reads.
- **No secret committed.** `.env.local` files remain gitignored (confirmed
  via `git check-ignore -v`); only `services/indexer/src/instances.test.ts`
  is a tracked, committed change. No throwaway keypair's secret used for
  this step's live Testnet verification (see below) was committed or
  logged anywhere in a tracked file.

## Automated tests (real network, no mocks)

Five new tests added to `services/indexer/src/instances.test.ts`, all
against real, live Testnet RPC (no fixtures, no simulated chain state):

1. **Accepts a real, live instance deployed from the new WASM once
   configured with its hash** — registers a genuinely fresh instance
   deployed this step (`CDAO5WFF...`, see below), asserts `{ outcome:
   "registered" }`.
2. **Also accepts the Step 6 verification instance** (`CBNCQWUF...`,
   deployed in Phase 5 Step 6, never previously registered because it was
   refused under the old config at that time) — asserts `{ outcome:
   "registered" }`.
3. **Refuses a real, live old-WASM instance once configured with the new
   hash** — the documented, intended hard-cutover behavior for *new*
   registrations going forward.
4. **A legacy instance already registered *before* cutover remains
   registered and readable *after* cutover** — registers a real old-wasm
   instance under the old-hash config (simulating the pre-cutover world),
   then confirms `isKnownPriceFloorInstance` and a second `registerInstance`
   call both still recognize it as already-registered under the new-hash
   config, proving no re-validation occurs.
5. **Decodes the Cancelled diagnostic correctly from a real, live instance
   built from the new WASM** — reads the fresh instance's real on-chain
   storage and asserts `cancelledFlagObserved: false` (absent, correct
   pre-cancel), alongside correctly decoded `settlementToken`/
   `oracleContractId`.

Full suite after this change: **199 tests** (41 SDK + 43 web + 60 indexer
[55 + 5 new] + 55 node-relayer + 0 contract changes), all passing.
`pnpm typecheck`, `pnpm lint`, and `pnpm build` all pass clean across the
whole workspace.

## Real Testnet validation

A genuinely fresh instance was deployed and initialized this step, from
the *exact* verified new hash, using the SDK's own `deployInstance`/
`initialize` functions (the same functions the application uses), signed
by a freshly generated, funded-via-friendbot, throwaway `Keypair` (never
committed, never reused, matching this project's established convention):

| | Value |
| --- | --- |
| New instance (this step) | `CDAO5WFFNI4KTRA43BBEIHUE4SKVRPL45DJQ2P7TE7R4NELCLFS7WC7S` |
| Deployed/initialized from | `5d99a31ede4e84a0a6c3c42f117262c6e01b5f1bd2fc020181e19db7e441935b` |
| Farmer/buyer (single-signer demo) | throwaway keypair, funded via friendbot, secret never persisted |
| Commodity / floor price / notional | COCOA / 40000000000 / 100 |
| Settlement token | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (native XLM SAC, same as Step 6) |
| Oracle | `CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T` |

Validation performed against this instance and the Step 6 instance
(`CBNCQWUFRDNH75SFPSWJCXY3NHA7RUM3G6U4N2ITOPXDMHBFMHV63PAF`), using the
real, running indexer process and its real Postgres database (`agrifeed`,
port 5433):

1. **Register it** — real `POST /pricefloor-instances` call, `201
   registered`.
2. **Initialize it** — done live, above, via the SDK.
3. **Confirm the indexer accepts it after cutover** — confirmed via the
   live HTTP endpoint (see "Live indexer verification" below).
4. **Confirm the Cancelled flag is readable/decodable** — a direct live
   RPC read plus `readInstanceStorageFields` (the indexer's real function)
   both confirm `cancelledFlagObserved: false` (correctly absent
   pre-cancel).
5. **Confirm existing fields remain correct** — `settlementToken` and
   `oracleContractId` both decoded correctly from real on-chain storage,
   matching what was passed to `initialize`.
6. **Confirm a legacy instance remains handled correctly** — the fixed
   legacy instance (`CDHPDF4TZ...`) is still recognized by
   `isKnownPriceFloorInstance` regardless of the new hash config (by
   contract-id match, not hash); separately, a real old-wasm instance
   registered *before* cutover was confirmed to remain `already-registered`
   and readable *after* cutover (automated test 4, above).

**No accelerated/fake `cancel()` was attempted.** Live `cancel()` remains
exactly as unverified as it was before this step — this step did not
change, and did not attempt to change, that status. The 48–96h grace
period was not bypassed or simulated.

## Live indexer process verification (item D)

This step surfaced a real, concrete gap between "the config file is
updated" and "the running service uses the new config," and resolved it
rather than assuming:

- After updating `.env.local`, the **already-running** local indexer dev
  process (bound to port 4000) still had the **old** hash loaded in its
  process environment — confirmed by inspecting `/proc/<pid>/environ`
  directly, and independently confirmed functionally: a freshly-deployed
  old-wasm instance was **incorrectly accepted** by that live process's
  real `/pricefloor-instances` endpoint.
- Editing an env file does not hot-reload a running Node process's
  environment — this is expected Node behavior, not a defect in this
  project's code.
- With the user's explicit approval, the stale process was stopped and a
  fresh one started (`node --env-file=.env.local dist/index.js`), loading
  the updated configuration directly from the same `.env.local` this step
  edited.
- **Re-verified against the restarted live process**: a newly-deployed
  old-wasm instance is now correctly **refused** (`{"error":"contract was
  not deployed from the configured PriceFloor WASM hash"}`); the new-wasm
  instance from this step is still recognized (`already-registered`,
  status advanced to `initialized` by the live poll loop's own real event
  ingestion). This is the definitive, live confirmation that the running
  indexer now uses the new configured hash, not an inference from the
  config file alone.

## Frontend/API regression check (item E)

Queried the real, live `GET /api/deals` endpoint before and after the
cutover and process restart. All 7 known deals remain present with correct
statuses, including deals predating this step (`funded`, `settled`,
`registered`, `initialized` states across both old- and new-wasm
instances) — no deal disappeared, no status regressed, no field was lost.

## CI evidence

Commit `c97c39f` (`feat(config): cut over to cancelled-aware pricefloor
wasm`), pushed to `origin/main`.

Run: https://github.com/AgriFeed/agrifeed-app/actions/runs/34582767765
(run ID `34582767765`)

| Job | Result | Duration |
| --- | --- | --- |
| `node` (typecheck, lint, migrations-apply-cleanly, full test suite, build) | ✅ success | 2m1s |
| `research` | ✅ success | 35s |
| `indexer-migration` | ✅ success | 35s |

Exact test counts pulled from the `node` job's own log, confirming the
5 new cutover tests landed and everything else stayed green:

```
packages/sdk test:       Tests  41 passed (41)
apps/web test:            Tests  43 passed (43)
services/indexer test:    Tests  60 passed (60)
services/node-relayer test: Tests  55 passed (55)
```

41 + 43 + 60 + 55 = **199 tests**, matching the local run exactly (indexer
55 → 60, +5 new real-Testnet cutover tests; nothing else changed).

## Compatibility analysis (carried forward, re-confirmed unchanged)

No contract behavior changed this step — Phase 5 Step 6's compatibility
analysis (unchanged `cancel()` signature, unchanged event shapes, unchanged
existing `DataKey` variant encodings, purely additive) still applies
unmodified, since `agrifeed-contract` HEAD (`190f009`) has had zero
contract-code commits since `9347841`.

## Remaining limitations (unchanged or newly precise)

| Item | Status |
| --- | --- |
| Live on-chain `cancel()` | Still **UNVERIFIED** — unchanged by this step, deliberately not attempted (48–96h grace period not satisfied) |
| Freighter/browser wallet integration | Still **UNVERIFIED** — out of scope for this step |
| `submit.ts` SDK duplication (node-relayer) | Unchanged, still deliberately deferred, unrelated to this step |
| Dual-hash migration support | **Not built**, deliberately — see "Migration-window decision" above; a hard cutover was judged the smallest safe architecture given the real, current registration semantics |
| Production deployment | Still does not exist for this project; "runtime configuration" in this report refers to the Testnet dev-environment configuration, the only configuration that exists |
| Generated TS bindings (`agrifeed-contract/packages/sdk/generated`) | Still not regenerated against the new wasm — unchanged from Step 6's own disclosed, justified decision; no real consumer depends on it |
