# Phase 6, Step 2 — node-relayer Transaction Lifecycle Consolidation Audit

**This is an audit report. No production code was changed to produce it.**
Baseline: `origin/main` at `2cc05d6`. All findings below are based on
reading the current source of both `services/node-relayer/src/submit/
submit.ts` and `packages/sdk/src/soroban-tx.ts` at this commit, plus their
respective test suites, the Oracle contract's `submit_price` implementation,
and the two prior reports this step was scoped from
(`docs/phase5-step4-tx-too-late.md`, `docs/phase5-step7-node-relayer-tests.md`).

## Current `submit.ts` flow (exact, line-by-line)

`services/node-relayer/src/submit/submit.ts`, function `submitPrice`:

1. **Construction**: `new StellarRpc.Server(config.rpcUrl)`, `new
   Contract(config.oracleContractId)`, `server.getAccount(keypair.publicKey())`
   to fetch the current sequence number.
2. **Build**: `new TransactionBuilder(account, { fee: "1000000",
   networkPassphrase: Networks.TESTNET })` (hardcoded Testnet, hardcoded
   fee, matching every other write path in this codebase), one operation
   (`contract.call("submit_price", node, asset, price, source_ts)`),
   `.setTimeout(60)`, `.build()`.
3. **Simulation/fee-resource prep**: `server.prepareTransaction(built)` —
   a single call that both simulates and assembles the Soroban resource
   footprint (`sorobanData`) onto the transaction, standard Soroban RPC
   usage, identical to every other write path in this codebase.
4. **Time bounds**: whatever `.setTimeout(60)` fixed at build time (step
   2), **never refreshed**. This is the entire gap this audit was
   commissioned to evaluate.
5. **Authorization/signing**: `prepared.sign(keypair)` — a single envelope
   signature from the node's own server-held `Keypair`. No explicit
   `SorobanAuthorizationEntry` handling anywhere in this file (see "Auth/
   signing analysis" below for why this is correct as-is).
6. **Submission**: `server.sendTransaction(prepared)`. On `status ===
   "ERROR"`, throws `new OracleError(`submit_price(${commodity}) rejected:
   ${JSON.stringify(sendResult.errorResult)}`)` — generic, no
   `tx_too_late`-specific classification.
7. **Polling/confirmation**: up to 20 attempts, 1500ms apart, calling
   `server.getTransaction(hash)`. `SUCCESS` → log and return. `FAILED` →
   throw `OracleError`. Falls through to a timeout `OracleError` after 20
   attempts (30s of polling).
8. **Error classification**: exactly two `OracleError` throw sites
   (rejected submission, on-chain failure) plus one timeout `OracleError`.
   All three are the same generic `OracleError` type — no distinguishable
   subtype for any failure reason.
9. **Retry/rebuild**: none, inside `submitPrice` itself. The caller
   (`index.ts`'s `tick()`) catches any error per-commodity, logs it, and
   moves on to the next commodity; the same commodity is only retried on
   the *next scheduled interval* (`NODE_RELAYER_SUBMIT_INTERVAL_SECONDS`,
   default 3600s = 1 hour) — there is no immediate retry anywhere in this
   path.

## Current SDK lifecycle (exact)

`packages/sdk/src/soroban-tx.ts` exports two functions actually relevant
here (a third, `isTxTooLate`, is an internal helper both use):

- **`refreshTimeBounds(tx, validitySeconds = 180)`**: `TransactionBuilder
  .cloneFrom(tx, { fee: tx.fee })`, clears and resets `timebounds` via
  `.setTimeout(validitySeconds)`, then explicitly re-attaches the original
  transaction's `sorobanData` (extracted from `tx.toEnvelope()`) — required
  because `cloneFrom` does not itself carry it over, a real bug the Phase 5
  Step 4 live deploy caught and fixed. Rejects (throws) if given a
  fee-bump transaction. Must be called on an **unsigned** transaction, as
  late as possible before signing.
- **`submitAndConfirm(server, signedTx, method)`**: `server
  .sendTransaction(signedTx)`; on `status === "ERROR"`, checks
  `isTxTooLate(sendResult.errorResult)` — if true, throws the typed
  `TxTooLateError(method)`; otherwise throws a generic `OracleError(
  `${method} submission failed: ...`)`. On success, polls
  `server.getTransaction(hash)` up to `MAX_POLL_ATTEMPTS = 20`, every
  `POLL_INTERVAL_MS = 1500` — **identical constants to `submit.ts`'s own
  hand-rolled loop**. `SUCCESS` returns `result.returnValue`. `FAILED`
  throws `OracleError(`${method} transaction failed on-chain: ${hash}`)`.
  Timeout throws `OracleError(`${method} transaction ${hash} did not
  confirm in time`)`.

The full write-path lifecycle these two functions are embedded in (as used
by `pricefloor.ts`'s `invokeAndConfirm`, the SDK's own reference caller):
build → `prepareTransaction` → `refreshTimeBounds` → sign → `TransactionBuilder
.fromXDR` (round-trip through a `SignAndSend` callback, needed because that
caller signs via Freighter across a browser-extension boundary) →
`submitAndConfirm`. **`submit.ts` needs no XDR round-trip or `SignAndSend`
callback at all** — it holds a real, in-process `Keypair` and can call
`.sign(keypair)` directly on the `Transaction` object `refreshTimeBounds`
returns, exactly as it already does today with `prepared.sign(keypair)`.
This makes node-relayer's integration **simpler** than `pricefloor.ts`'s,
not equally complex.

`invokeAndConfirm`'s `friendlyContractError` (PriceFloor-specific contract
error-code-to-message mapping, `CONTRACT_ERROR_MESSAGES`) is **not**
part of `soroban-tx.ts` and is not proposed for reuse — see "Node-relayer-
specific behavior" below for why pulling it in would be wrong.

## Side-by-side compatibility matrix

| Aspect | `submit.ts` (current) | `soroban-tx.ts` (SDK) | Compatible? |
| --- | --- | --- | --- |
| Inputs | `SubmitConfig{rpcUrl, oracleContractId}`, `Keypair`, `commodity`, `rawPrice`, `sourceTs` | `refreshTimeBounds(tx, validitySeconds?)`; `submitAndConfirm(server, signedTx, method)` — generic, contract-agnostic | Yes — `submit.ts` keeps owning its own inputs and tx construction; only the refresh/submit/poll steps are proposed for reuse |
| Outputs | `Promise<void>` (throws on any failure) | `refreshTimeBounds` → `Transaction`; `submitAndConfirm` → `Promise<xdr.ScVal \| undefined>` (submit_price returns nothing meaningful, `undefined` is fine, matches current `Promise<void>` contract) | Yes |
| Transaction source account | `keypair.publicKey()`, fetched via `getAccount` | Unchanged — `soroban-tx.ts` does not construct the account or transaction, it operates on whatever is handed to it | Yes, no divergence possible |
| Contract function invocation | `contract.call("submit_price", node, asset, price, source_ts)`, built by `submit.ts` itself | Not the SDK's concern — `refreshTimeBounds`/`submitAndConfirm` never inspect operation contents beyond checking it is a single-operation `Transaction` | Yes |
| Simulation requirements | `server.prepareTransaction(built)`, unchanged either way | Not touched by either reused function; still called by `submit.ts` exactly as today, before `refreshTimeBounds` | Yes |
| Soroban data/resource footprint | Attached by `prepareTransaction`; never re-touched today (no refresh happens) | `refreshTimeBounds` explicitly re-attaches it after `cloneFrom` (the exact live-caught bug from Phase 5 Step 4) | Yes — this is the fix being adopted, not a divergence |
| Time bounds | Fixed at build time (`.setTimeout(60)`), never refreshed | Refreshed immediately before signing, 180s default | **This is the intended change**, not a compatibility gap |
| Authorization entries | None beyond the envelope signature — `node.require_auth()` in the contract is satisfied by `SourceAccount` credentials since `node == tx source account` (confirmed against `contracts/agrifeed-oracle/src/ingest.rs:126`) | `refreshTimeBounds` explicitly never touches `SorobanAuthorizationEntry` (documented, and covered by its own byte-for-byte preservation test) | Yes — and this case (zero `ADDRESS`-credentialed entries) is strictly simpler than the multiparty case the function already supports |
| Signing mechanism | Direct `.sign(keypair)` on the `Transaction` object, in-process | Function-agnostic to signing mechanism — operates before (`refreshTimeBounds`) or after (`submitAndConfirm`) signing, never performs it | Yes — no `SignAndSend`/XDR-round-trip/Freighter dependency needed |
| Submission | `server.sendTransaction(prepared)`, generic `OracleError` on any rejection | `server.sendTransaction(signedTx)`, `TxTooLateError` on `tx_too_late` specifically, generic `OracleError` otherwise | Compatible, strictly more informative |
| Confirmation/polling | 20 attempts × 1500ms, identical constants | 20 attempts × 1500ms (`MAX_POLL_ATTEMPTS`/`POLL_INTERVAL_MS`) | **Identical**, not just compatible |
| Error behavior | 3 generic `OracleError` throw sites, message text includes `commodity` via string interpolation at each site | `TxTooLateError` (extends `OracleError`) for `tx_too_late`; generic `OracleError(`${method}: ...`)` otherwise; `method` is caller-supplied | Compatible if caller passes `method = `submit_price(${commodity})`` — preserves commodity-in-message for existing tests (see "Error semantics" below) |
| Retry semantics | None inside `submitPrice`; caller retries next scheduled tick | None inside `submitAndConfirm` either — confirmed by its own test ("does not retry submission itself: sendTransaction is called exactly once, even on tx_too_late") | **Identical** — no behavior change to retry cadence |

## A. `tx_too_late` behavior

**Yes, `submit.ts` can currently construct and submit a stale transaction,
and it lacks `refreshTimeBounds` entirely.** Its `.setTimeout(60)` is fixed
at build time, before `prepareTransaction`'s RPC round trip and before
`sendTransaction`'s own round trip — exactly the pattern Phase 5 Step 4
proved insufficient for the browser/human-approval path (three consecutive
real `tx_too_late` failures). If it rejects with `tx_too_late` today, it
surfaces as the same generic `OracleError` as every other rejection reason
— an operator reading logs cannot currently distinguish "transient timing
issue, will very likely succeed on the next scheduled tick" from "a real,
persistent problem" (bad auth, unknown commodity, etc.).

**However, the actual risk profile differs materially from the browser
case this fix originally targeted.** `submit.ts` has no human-approval gap
between `prepareTransaction` and `sendTransaction` — those two RPC round
trips happen back-to-back, in-process, typically sub-second to a few
seconds apart. A 60-second window is very likely sufficient under normal
network conditions. The realistic trigger for `tx_too_late` here is
transient RPC/network slowness, not (as in the browser case) a human
reading a wallet prompt. **This audit does not claim `submit.ts` has
observably hit this bug** — no failure evidence exists for it, unlike the
browser path, which had three live reproductions. The recommendation below
is a defensive-hardening and diagnostics improvement, not a fix for an
observed outage.

## B. Soroban auth

**Fully preserved, and the case is simpler than the one `refreshTimeBounds`
already supports.** `contracts/agrifeed-oracle/src/ingest.rs:126`:
`node.require_auth()`. Since `node` (the first `submit_price` argument) is
always set to `keypair.publicKey()`, which is also the transaction's own
source account, Soroban satisfies this via `SorobanCredentials::
SourceAccount` — authorization is carried entirely by the transaction
envelope's own signature, with **no separate `SorobanAuthorizationEntry`**
at all. `refreshTimeBounds` is documented to never touch
`SorobanAuthorizationEntry` (needed for the harder multiparty case, where
entries carry independent signatures from other parties) and this is
directly covered by its own test ("preserves already-signed Soroban
authorization entries embedded in the operation, byte for byte"). The
zero-entries case relevant here is implicitly covered by the simpler
"preserves the operation unchanged" test. **Signer identity is completely
unchanged**: the node's own `Keypair` signs the same way, at the same
point in the flow (after `refreshTimeBounds` instead of after the original
unrefreshed build — a strictly later point, changing nothing about who
signs or what is signed beyond the time-bounds field).

## C. Transaction shape

**The SDK helpers produce exactly the shape `submit.ts` needs, including
the resource footprint.** Neither `refreshTimeBounds` nor `submitAndConfirm`
contain any PriceFloor- or Oracle-specific logic — both operate on a
generic single-operation `Transaction`/`StellarRpc.Server`. The one
documented constraint (`refreshTimeBounds` "every write path in this SDK
invokes exactly one Soroban operation") holds for `submit_price` exactly as
it does for every existing caller. `refreshTimeBounds`'s `sorobanData`
re-attachment (the Phase 5 Step 4 bug fix) applies identically regardless
of which contract or function is being invoked — it operates on the
envelope's `ext` field, not on operation contents.

## D. Node-relayer-specific requirements

**Nothing found that `soroban-tx.ts` would need to newly accommodate, and
one thing correctly identified as *not* to reuse:**

- `submit.ts` has no relayer-specific submission or confirmation behavior
  beyond message wording (see "Error semantics"). Poll interval, attempt
  count, and overall retry-free semantics are already identical, not just
  compatible.
- `pricefloor.ts`'s `invokeAndConfirm` — the SDK's other candidate
  reference implementation — additionally wraps every result in
  `friendlyContractError`, which maps `agripricefloor`'s own error-code
  enum (`CONTRACT_ERROR_MESSAGES`, keys 1–10, e.g. "already initialized,"
  "not funded yet") to human messages. **This is PriceFloor-specific and
  must not be reused for Oracle's `submit_price`** — the Oracle contract
  has an entirely different error enum (`NotAuthorizedNode`,
  `UnknownCommodity`, `InvalidPrice`, ...), and blindly reusing
  `invokeAndConfirm` (rather than the lower-level `refreshTimeBounds`/
  `submitAndConfirm` primitives directly) would silently produce wrong or
  misleading error text. The recommendation below reuses only the two
  generic primitives, not `invokeAndConfirm` itself.

## E. Error semantics

**One genuine friction point, with a minimal, non-invasive fix.**
`TxTooLateError`'s message (`packages/sdk/src/types.ts:61-71`) is phrased
for a human-in-a-browser-wallet context: "most likely because approving it
in the wallet took longer than the window allowed... Try again: a fresh
transaction will be prepared and will need a fresh signature." For an
unattended server process with no wallet and no human approval step, this
wording is misleading if surfaced verbatim to an operator reading logs.

**Recommendation: do not fork or edit the shared SDK message** (it is
correct for its actual callers, `pricefloor.ts`/`multiparty.ts`, and
forking it would reintroduce the duplication this step exists to remove).
Instead, add a small, node-relayer-local `catch` branch in `index.ts`'s
`tick()` that checks `err instanceof TxTooLateError` and logs a relayer-
appropriate line (e.g. "submit_price: signing window expired before
reaching the network, this is transient and the next scheduled cycle will
retry" instead of the SDK's wallet-phrased message) while still relying on
the typed distinction for the check itself. This is additive to
`index.ts`, not a modification of the shared primitive, and requires
`TxTooLateError` to be part of what `submit.ts`/`index.ts` can import (see
implementation sequence).

**Message-shape compatibility with existing tests**: `submitAndConfirm`'s
error messages are parameterized by a caller-supplied `method` string, not
hardcoded to `"settle"`/`"initialize"`. Passing `method =
`submit_price(${commodity})`` preserves the exact substrings
`submit.ts`'s current tests already assert on:
- `"includes the commodity in the error"` test (`.rejects.toThrow(/COFFEE/)`)
  → `submit_price(COFFEE) submission failed: ...` still contains "COFFEE".
- `"throws...did not confirm in time"` test → `submit_price(COCOA)
  transaction ${hash} did not confirm in time` — same trailing phrase,
  unchanged.
- All `toBeInstanceOf(OracleError)` assertions remain valid unchanged,
  since `TxTooLateError extends OracleError`.

No test currently asserts on the *exact* prefix wording ("rejected:" vs.
"submission failed:"), so this minor wording change is not a breaking
change to any existing assertion — confirmed by reading every assertion in
`submit.test.ts` line by line (see "Test-coverage mapping" below).

## F. Configuration/environment

**No assumptions would be lost.** `submit.ts` hardcodes `Networks.TESTNET`
and fee `"1000000"` — both patterns are already identical, codebase-wide
conventions (`index.ts`'s own `oracleConfig.networkPassphrase =
Networks.TESTNET`, `pricefloor.ts`'s own `fee: "1000000"`), not something
introduced or assumed uniquely by `submit.ts`. `SubmitConfig` carries no
`networkPassphrase` field today and does not need one for this
consolidation — `refreshTimeBounds`/`submitAndConfirm` operate on an
already-built `Transaction`/`StellarRpc.Server`, never re-deriving the
passphrase. Module resolution is compatible: both packages use `NodeNext`/
matching TypeScript configuration, and `services/node-relayer` already
depends on and successfully imports from `@agrifeed/sdk` (`OracleError`,
today) — the workspace link and build pipeline are already proven to work
end to end.

**One real gap, not a loss but a missing prerequisite**: `soroban-tx.ts`'s
exports (`refreshTimeBounds`, `submitAndConfirm`, `isTxTooLate`,
`SIGNING_VALIDITY_SECONDS`) are **not currently part of `@agrifeed/sdk`'s
public surface**. `packages/sdk/src/index.ts` exports `types.js`,
`format.js`, and namespaced `oracle`/`pricefloor`/`multiparty`/`deploy` —
`soroban-tx.js` itself is never re-exported; it is only consumed
internally, within the SDK package, by `pricefloor.ts` and `multiparty.ts`.
`TxTooLateError` **is** already exported (via `export * from "./types.js"`)
and already importable — `submit.ts` could reference it today for the
`instanceof` check even before the rest of this plan lands. Adding a
public export path for `soroban-tx.ts` is therefore a small, required,
purely additive first step (see implementation sequence) — reaching into
`@agrifeed/sdk`'s internal `dist/soroban-tx.js` path directly, bypassing
the package's declared public surface, would be fragile and was
deliberately not considered.

## G. Test-coverage mapping

**`services/node-relayer/src/submit/submit.test.ts`** (7 tests, all real
XDR round-trips through `submitPrice`'s own logic, network boundary
stubbed at exactly the 4 `StellarRpc.Server` methods it calls):

| Test | Exercises | Affected by consolidation? |
| --- | --- | --- |
| "builds, signs, submits, and confirms... unchanged shape" | build → sign → send → confirm, asserts real decoded operation args | Compatible — construction/args unchanged, only submit/poll internals move |
| "signs with the node's own keypair..." | real signature verification against `submittedTx.hash()` | Compatible — same `Keypair.sign()` semantics, only the surrounding call sequence changes |
| "throws...OracleError...when submission is rejected" | generic rejection → `OracleError` | Compatible — `submitAndConfirm` still throws `OracleError` for non-`tx_too_late` rejections |
| "includes the commodity in the error..." | message contains commodity string | Compatible if `method = submit_price(${commodity})` (see "Error semantics") |
| "does not attempt a second submission..." | `sendTransaction` called exactly once | Compatible — `submitAndConfirm`'s own test proves the identical property |
| "throws...for a real on-chain execution failure..." | `FAILED` status → `OracleError` | Compatible — same classification, same `OracleError` type |
| "throws...not hanging forever, when confirmation never arrives" | 20-attempt timeout → `OracleError` | Compatible — identical constants (`MAX_POLL_ATTEMPTS`/`POLL_INTERVAL_MS` match `submit.ts`'s own `20`/`1500`) |
| "error messages never leak the signing secret" | secret never in thrown message | Compatible — neither function ever handles or logs the raw secret, only the `Keypair` object (unchanged) |

**`packages/sdk/src/soroban-tx.test.ts`** (11 tests) already independently
proves the two functions proposed for reuse:
`refreshTimeBounds` — stale-window refresh, default duration, operation
preservation, `SorobanAuthorizationEntry` byte-for-byte preservation,
fee-bump rejection. `submitAndConfirm` — `TxTooLateError` classification,
generic-`OracleError` classification, no-retry, success path returns
value, on-chain-failure classification. **This existing coverage is not
duplicated by anything proposed below**; it is exactly the coverage that
justifies trusting the reused primitives without re-proving their internal
correctness from node-relayer's side.

**Gaps that exist today, to close if consolidation proceeds** (none of
these gaps block the decision, since they describe coverage to *add*, not
missing prerequisites):

1. No test today proves `submit.ts` classifies a real `tx_too_late`
   rejection as `TxTooLateError` specifically (impossible to write today,
   since the current code has no such classification at all).
2. No test today proves a call to `submitPrice` actually results in a
   ~180-second time-bounds window rather than the original 60 — i.e., a
   regression test that would fail if `refreshTimeBounds` were removed or
   never wired in.
3. No test exists for `index.ts`'s `tick()` function at all (only
   `env.test.ts` exists at that directory level) — the proposed
   `TxTooLateError`-specific log branch (§E) would be new, currently-
   untested code unless a test is added alongside it.

## Architectural decision

# CONSOLIDATE

**Rationale**: every compatibility dimension investigated (A–G) resolves
to "compatible" or "compatible with a small, well-understood, additive
adjustment" — none resolve to "incompatible" or "unacceptable risk."
Specifically://
- Authorization (B) is not just compatible but a *simpler* case than what
  `refreshTimeBounds` already handles correctly and safely.
- Transaction shape (C) requires no contract-specific accommodation in the
  reused code.
- The one real node-relayer-specific concern (D, PriceFloor's
  `friendlyContractError`) is correctly avoided by reusing the two
  low-level primitives (`refreshTimeBounds`/`submitAndConfirm`) rather than
  the higher-level `invokeAndConfirm` wrapper — this is not "blindly
  replacing one implementation with another," it is deliberately choosing
  the right layer of the existing SDK to reuse.
- The one genuine friction point (E, wallet-phrased error text) has a
  minimal, local, non-invasive resolution that does not require touching
  the shared SDK code at all.
- No configuration or environment assumption (F) is lost; the only
  prerequisite is a small, additive SDK export change, not a redesign.
- Test coverage (G) is already strong on both sides, with a small,
  enumerable set of new tests needed, not a coverage cliff.

This also directly closes the actual defect class this audit exists to
address: **`submit.ts` can currently submit a stale transaction and cannot
tell an operator that's what happened**; consolidation both reduces the
likelihood (via the freshened window) and, if it still happens, makes it
diagnosable.

## Exact implementation sequence (not implemented this step)

1. **SDK**: add a public export for the two primitives needed
   (`refreshTimeBounds`, `submitAndConfirm`) — e.g. `export * as sorobanTx
   from "./soroban-tx.js";` in `packages/sdk/src/index.ts`. Purely
   additive; no existing export changes. `TxTooLateError` needs no new
   export (already public via `export * from "./types.js"`).
2. Rebuild the SDK (`pnpm --filter @agrifeed/sdk build`) so
   `services/node-relayer` (already a `workspace:*` dependent) sees the
   new export.
3. **`submit.ts`**: replace the hand-rolled sign/send/poll block (current
   lines 56–77) with:
   - keep `prepareTransaction` unchanged;
   - `const readyToSign = sorobanTx.refreshTimeBounds(prepared);`
   - `readyToSign.sign(keypair);` (replaces `prepared.sign(keypair)`)
   - `return await sorobanTx.submitAndConfirm(server, readyToSign,
     `submit_price(${commodity})`);` wrapped to return `void` (discard the
     unused return value, matching the current `Promise<void>` contract) —
     or change the return type to `Promise<xdr.ScVal | undefined>` if a
     future caller ever needs it; **not required for this consolidation**,
     keep `Promise<void>` to avoid an unrelated signature change.
   - Delete the now-dead manual polling loop, the two now-redundant
     `OracleError` throw sites it contained, and the now-unused
     `StellarRpc.Api.GetTransactionStatus` import if nothing else in the
     file needs it.
4. **`index.ts`**: import `TxTooLateError` from `@agrifeed/sdk`; in
   `tick()`'s `catch` block, add an `instanceof TxTooLateError` branch with
   a relayer-appropriate log message (see §E), falling through to the
   existing generic log line for every other error type — no change to
   control flow (still catches, logs, continues to the next commodity, no
   new retry).
5. **`submit.test.ts`**: add the two regression tests identified in
   "Test-coverage mapping" gap 1 and 2 (real `tx_too_late` xdr rejection →
   `TxTooLateError`; asserted time-bounds window ≈180s, not 60s). Do not
   remove or weaken any existing test — all 7 remain, adjusted only where
   `method`-string interpolation changes an assertion's exact match (none
   currently do, per the "Error semantics" analysis).
6. **New test file** (or extend `env.test.ts`'s directory with a small
   `index.test.ts`) for the `tick()` `TxTooLateError`-specific log branch
   from step 4 — currently `tick()` has zero test coverage, so this is new
   coverage, not a regression risk to existing tests.
7. Run the full validation this project always requires before any commit:
   `pnpm typecheck`, `pnpm lint`, `pnpm test` (full workspace, not just the
   two touched packages), `pnpm build`.

## Required regression tests (summary)

- `submitPrice` classifies a real `tx_too_late` `TransactionResult`
  rejection as `TxTooLateError`, not generic `OracleError` (new).
- `submitPrice`'s submitted transaction carries a refreshed, ~180-second
  time-bounds window, not the original 60 (new — proves the fix is wired
  in, not just imported and unused).
- All 7 existing `submit.test.ts` tests continue to pass unmodified in
  their assertions (only internal wiring changes).
- All 11 existing `soroban-tx.test.ts` tests continue to pass unmodified
  (no change proposed to `soroban-tx.ts` itself).
- New: `tick()`'s `TxTooLateError`-specific log branch fires correctly and
  falls through to the generic branch for every other error type.

## Required real Testnet verification

Consistent with this project's established evidence bar (never claim a
change works from unit tests alone when a real network call is
practical):

1. **A real, live `submit_price` call through the refactored code path**
   — proves the SDK integration genuinely works end to end against
   Testnet (correct account/build/simulate/refresh/sign/submit/confirm),
   not just against stubbed RPC responses. Low cost, low risk (this
   project already has an authorized oracle node keypair and does this
   routinely).
2. **No new live `tx_too_late` reproduction is required.** The underlying
   mechanism (`refreshTimeBounds`/`submitAndConfirm`, `isTxTooLate`'s XDR
   discriminant check) is unchanged from what Phase 5 Step 4 already
   proved live against real Testnet rejections and successes. Re-proving
   the same shared, unchanged mechanism a second time for a second caller
   would be exactly the kind of redundant, low-value verification this
   project's own principles argue against — the *new* thing to verify
   live is that node-relayer's call site is wired correctly (item 1), not
   that `tx_too_late` classification itself works (already proven).

## Risks and rollback considerations

- **Risk**: the additive SDK export (step 1) changes `@agrifeed/sdk`'s
  public surface. Mitigation: purely additive (`export * as sorobanTx`),
  cannot break any existing importer; confirmed by re-running the full
  workspace test suite after the change (step 7 already requires this).
- **Risk**: deleting `submit.ts`'s hand-rolled loop could silently change
  behavior if any subtle difference between it and `submitAndConfirm` was
  missed. Mitigation: the compatibility matrix above shows the two loops
  are already **byte-identical in constants** (20 attempts, 1500ms), and
  the required regression tests (above) directly re-assert every existing
  behavior before this is considered complete.
- **Risk**: the `TxTooLateError` wallet-phrased message reaching an
  operator's logs verbatim before the `index.ts` log branch (step 4) is
  implemented, if steps are landed out of order. Mitigation: implement
  steps 3 and 4 together, not separately, and mention this explicitly in
  the PR/commit description for whoever implements this.
- **Rollback**: every change is confined to `submit.ts`, `index.ts`,
  their test files, and one additive line in the SDK's `index.ts`. Revert
  is a straightforward `git revert` of that single commit; no data
  migration, no contract change, no config change is involved.
- **No security regression**: authorization semantics are provably
  unchanged (§B); no new signer, no new credential type, no relaxation of
  `node.require_auth()`'s enforcement (which lives entirely in the
  contract, untouched).

## Explicit non-findings (per this task's scope)

- No Oracle contract change was made or is proposed.
- No PriceFloor behavior was touched or is proposed to change.
- No frontend behavior was touched or is proposed to change.
- No authentication was weakened; `node.require_auth()`'s enforcement is
  entirely contract-side and untouched by anything in this report.
- No existing `submit.ts` test is proposed for removal.
- No SDK code was duplicated into node-relayer — the recommendation is the
  opposite: stop duplicating, reuse the existing shared primitives.
- No generic abstraction is proposed beyond what already exists
  (`refreshTimeBounds`/`submitAndConfirm` already exist and are already
  contract-agnostic; nothing new is introduced solely for this report).

## Validation performed this step (audit-only)

- `pnpm --filter @agrifeed/sdk test` — 41/41 passed.
- `pnpm --filter @agrifeed/node-relayer test` — 55/55 passed.
- `pnpm --filter @agrifeed/sdk typecheck` — clean.
- `pnpm --filter @agrifeed/node-relayer typecheck` — clean.
- `pnpm lint` (full workspace) — clean.
- No `pnpm build` changes were needed to validate this audit (no source
  changed); the full-workspace build was already confirmed green in Phase
  6 Step 1's validation at the same baseline commit lineage.

**Baseline confirmed green throughout. No production code, test, or
configuration file was modified to produce this report.**
