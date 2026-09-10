# Phase 5 Step 4: tx_too_late Resilience Audit and Fix

**Baseline**: `origin/main` at `d3be95a` (Phase 5 Step 3, Freighter
verification — UNVERIFIED). This step implements a repository-side fix,
following investigation-first, evidence-based root-causing as instructed.

## Original observed evidence

Phase 4 Step 4's live deploy verification hit `tx_too_late` **three
consecutive times** before a fourth attempt succeeded:

```
deployInstance submission failed: {"fee_charged":"31213","result":"tx_too_late","ext":"v0"}
```

Each time, the user was mid-way through approving the transaction in
Freighter when the rejection came back. No prior step localized *why*;
this step does.

## Investigation

### Where tx_too_late is produced and detected

`server.sendTransaction(signedTx)` (Soroban RPC) rejects a transaction
outright, before it is ever queued for a ledger, if the envelope's own
`timeBounds.maxTime` has already elapsed — this is a pre-flight Stellar
Core validity check, not something that shows up later via
`getTransaction`'s polling loop. Confirmed live, not assumed: this step
built a real transaction with a deliberately past `maxTime`, submitted it
to `https://soroban-testnet.stellar.org` for real, and got back exactly
the same shape as the original Step 4 evidence:

```
status: ERROR
errorResult JSON: {"fee_charged":"100","result":"tx_too_late","ext":"v0"}
```

Before this step, nothing in this codebase classified this specific
rejection at all — `soroban-tx.ts`'s `submitAndConfirm` just
`JSON.stringify`'d the whole `errorResult` into one generic
`"${method} submission failed: ..."` message, the same treatment given
to every other possible rejection reason (bad auth, bad sequence,
insufficient fee, ...). This is exactly the "hide it as a generic
success/failure message" this task's instructions warned against, and it
was already happening.

### Exact trigger: time bounds fixed before the human ever sees the prompt

Every write path in this SDK (`deployInstance`, `invokeAndConfirm` for
`fund`/`settle`/`cancel`/single-signer `initialize`, and
`prepareMultiPartyInvocation` for two-party `initialize`) built its
transaction as:

```
TransactionBuilder(...).addOperation(...).setTimeout(60).build()   // maxTime = now + 60, fixed HERE
  ↓
server.prepareTransaction(...) / server.simulateTransaction(...)    // RPC round trip, seconds
  ↓
signAndSend(...)                                                    // HUMAN approval, unbounded
  ↓
submit + poll
```

`TransactionBuilder.setTimeout(60)` computes an *absolute* `maxTime`
(`Date.now()/1000 + 60`) the moment it runs, at the very top of this
chain — before the RPC round trip and, critically, before the human is
ever shown anything to approve. The 60-second budget therefore had to
cover RPC latency *and* the human's own reaction/approval time combined,
and by the time a real human actually saw and clicked "approve," a
meaningful fraction of that budget could already be gone. Three
consecutive real failures during Phase 4 Step 4 is exactly what running
out of that shared budget looks like.

### Affected transaction classes

All of them: `deploy` (`deployInstance`), `fund`/`settle`/`cancel`/
single-signer `initialize` (all share `pricefloor.ts`'s `invokeAndConfirm`),
and the two-party `initialize` flow (`multiparty.ts`). The multiparty
path has a second, structurally worse version of the same defect (below),
never previously exercised live because the browser/Freighter signing
path has been blocked since Phase 3 Step 7 (see Step 3's report) — this
is a real bug that has simply never had the chance to fail live yet.

### The multiparty flow's own extra staleness bug

`submitMultiPartyInvocation`'s own doc comment already acknowledges "a
whole independent signing round, possibly minutes or more" can pass
between `prepareMultiPartyInvocation`'s original simulation and final
submission — and correctly re-simulates for a fresh *resource fee*
footprint to handle that gap. But it never refreshed the envelope's
*time bounds*: `TransactionBuilder.cloneFrom(originalTx, ...)` (confirmed
by reading `cloneFrom`'s own source,
`node_modules/.../transaction_builder.js`) explicitly carries the
original transaction's `timeBounds` onto the new builder
(`builderOpts.timebounds = tx.timeBounds`), and `setTimeout()` refuses to
override an already-set positive `maxTime`
(`"TimeBounds.max_time has been already set..."`). So the *stale* window
computed back at `prepareMultiPartyInvocation` time — potentially minutes
or hours before the source account's own envelope signature is finally
requested — silently rode along all the way to submission, unrefreshed.
This is a genuinely worse case than single-signer deploy: two independent,
asynchronous signing rounds (farmer, then buyer, each in their own time)
had to fit inside the *same* original 60-second window that was fixed
before either of them even started.

### Was retrying the same bytes valid? No — and why

Resubmitting the identical signed transaction bytes would fail
identically: the same stale `maxTime` is still stale, nothing about it
changed. This was ruled out on inspection, not attempted.

### What must be rebuilt vs. what can stay untouched

- **Must be rebuilt**: the envelope's own `timeBounds`, since that is
  what makes the transaction stale and it is what Stellar Core actually
  rejects on. This must happen **before** the transaction is signed
  (time bounds are part of what gets hashed and signed; mutating them
  afterward silently invalidates the signature rather than erroring
  cleanly).
- **Must never be touched, and is not**: any party's already-collected
  `SorobanAuthorizationEntry`. Soroban authorizes each entry independently
  via its own `signatureExpirationLedger` (a ledger-based expiry,
  unrelated to the envelope's time-based `maxTime` — confirmed against
  `@stellar/stellar-sdk`'s own generated XDR types, `SorobanAddressCredentials`).
  Refreshing the envelope's time bounds has no effect on that field at
  all, so it never requires, and must never trigger, a fresh signature
  from the farmer or the buyer.
- **A real defect this step's own live testing caught before shipping**:
  `TransactionBuilder.cloneFrom` (used to rebuild the envelope) does not
  itself carry a Soroban transaction's resource footprint
  (`sorobanData`, attached by `prepareTransaction`/`assembleTransaction`)
  onto the new builder — confirmed by reading `cloneFrom`'s source line
  by line. A first version of this fix, verified only by unit tests and
  typecheck, passed both cleanly but **failed live on real Testnet with
  `tx_malformed`** the moment it was exercised against a real
  `createCustomContract` operation with a real resource footprint. This
  was caught, root-caused, and fixed (`refreshTimeBounds` now explicitly
  re-attaches the original `sorobanData` via `builder.setSorobanData(...)`)
  before this report was written — see "Real Testnet verification" below
  for the before/after evidence. This is exactly why the task asked for
  real Testnet verification rather than stopping at green unit tests.

## Implementation

### `TxTooLateError` (`packages/sdk/src/types.ts`)

A new, narrow error type distinguishing this specific, recoverable
failure from every other kind:

```ts
export class TxTooLateError extends OracleError {
  constructor(method: string) {
    super(
      `${method}: this transaction's signing window expired before it reached the network ` +
        "(most likely because approving it in the wallet took longer than the window allowed). " +
        "Nothing was submitted, no funds moved and no state changed. Try again: a fresh transaction " +
        "will be prepared and will need a fresh signature.",
    );
    this.name = "TxTooLateError";
  }
}
```

### `isTxTooLate` (`packages/sdk/src/soroban-tx.ts`)

```ts
export function isTxTooLate(errorResult: xdr.TransactionResult | undefined): boolean {
  return errorResult?.result.type === "txTooLate";
}
```

Checked against `@stellar/stellar-sdk`'s own generated XDR discriminant
(`TransactionResultResultTxTooLate`'s `type: "txTooLate"` field), not a
string match on `JSON.stringify` output — narrow by construction, so
`tx_bad_auth`/`tx_bad_seq`/a real on-chain contract error/etc. all
correctly return `false` and keep surfacing through the existing generic
path.

### `refreshTimeBounds` (`packages/sdk/src/soroban-tx.ts`)

Rebuilds a transaction with a fresh `maxTime` computed from *now*,
re-attaching its original `sorobanData` (the fix for the defect found
above), safe to call only on an unsigned transaction:

```ts
export function refreshTimeBounds(tx: Transaction, validitySeconds = SIGNING_VALIDITY_SECONDS): Transaction {
  const builder = TransactionBuilder.cloneFrom(tx, { fee: tx.fee });
  builder.timebounds = null;
  builder.setTimeout(validitySeconds);
  const envelope = tx.toEnvelope();
  const sorobanData = envelope.type === "envelopeTypeTx" && envelope.value.tx.ext.type === "sorobanData"
    ? envelope.value.tx.ext.value
    : undefined;
  if (sorobanData) builder.setSorobanData(sorobanData);
  const rebuilt = builder.build();
  if (!(rebuilt instanceof Transaction)) {
    throw new OracleError("expected a single-operation Transaction, not a fee-bump transaction");
  }
  return rebuilt;
}
```

Called as late as possible, immediately before each write path's final
`signAndSend`, in exactly three places:

- `deploy.ts`'s `deployInstance`, right after `server.prepareTransaction(...)`.
- `pricefloor.ts`'s shared `invokeAndConfirm` (covers `fund`/`settle`/
  `cancel`/single-signer `initialize`), same spot.
- `multiparty.ts`'s `submitMultiPartyInvocation`, applied to `built`
  (after `withAuthEntries`), immediately before the source account's own
  fresh envelope signature is requested — closing the extra staleness gap
  described above, without touching `authEntries` at all.

### `SIGNING_VALIDITY_SECONDS = 180`

A deliberate, evidence-based widening from the original 60 seconds,
applied only at this one point (the final pre-signing window), not as a
blanket change to every timeout in the codebase. Justification: 60
seconds was demonstrated insufficient by three consecutive real
failures even before RPC latency is subtracted from it; moving the
computation to right before signing (this fix's main structural change)
already removes the RPC round-trip's share of that budget, and 180
seconds gives real human approval time actual room without being
unbounded.

### `submitAndConfirm`'s classification

```ts
if (sendResult.status === "ERROR") {
  if (isTxTooLate(sendResult.errorResult)) {
    throw new TxTooLateError(method);
  }
  throw new OracleError(`${method} submission failed: ${JSON.stringify(sendResult.errorResult)}`);
}
```

Every other rejection reason is completely unchanged — same generic
message, same behavior, nothing weakened or removed.

## Recovery semantics (why no new UI plumbing was needed)

No infinite retry loop was added, and none was needed: this SDK-level fix
plugs into the **existing** manual-retry UI pattern already present in
`NewDealFlow.tsx` (`ParticipantCard`'s "Try again" for a rejected
signature, the top-level `failed` state's "Start over") and `DemoFlow.tsx`
(each form's own error display, re-clickable). Every one of those buttons
already re-invokes its handler from scratch on click — a fresh `deploy`/
`invokeAndConfirm`/`prepareMultiPartyInvocation` call, meaning a fresh
transaction build, fresh simulation, and now a freshly-refreshed time
window, requiring a genuinely fresh signature request from Freighter (or
a CLI/SDK signer). Nothing caches or reuses the old signed bytes across a
retry; there was never a code path that could. `TxTooLateError`'s own
message ("Nothing was submitted... Try again: a fresh transaction will be
prepared and will need a fresh signature") is written for exactly this
existing UI to display as-is, without needing a special case to tell the
difference — a caller that does want to branch on it specifically can
`instanceof TxTooLateError`.

## Tests added (`packages/sdk/src/soroban-tx.test.ts`, new file)

14 new tests, all deterministic, no live network calls, no mocked
browser wallet:

- **`isTxTooLate`** (4): recognizes a real `txTooLate` `TransactionResult`
  (constructed via the SDK's own real XDR types, not hand-typed);
  returns `false` for a different real rejection (`txBadAuth`) and for a
  real success result, never a false positive; returns `false` for no
  `errorResult` at all.
- **`refreshTimeBounds`** (5): replaces an already-expired `maxTime` with
  a fresh future one; defaults to `SIGNING_VALIDITY_SECONDS`; preserves
  the operation (same invoked function) unchanged; **preserves an
  already-signed `SorobanAuthorizationEntry` embedded in the operation
  byte-for-byte** (the multiparty-safety guarantee); rejects a fee-bump
  transaction.
- **`submitAndConfirm`** (5, against a stub RPC server matching only the
  two methods it actually calls): throws `TxTooLateError` — not a generic
  message — for a real `tx_too_late` rejection; still throws a plain
  `OracleError` (never `TxTooLateError`) for a different rejection reason;
  **calls `sendTransaction` exactly once**, even on `tx_too_late` (no
  retry loop inside the SDK itself); the existing successful path is
  unchanged (sends once, polls once, returns the real return value);
  a real on-chain execution failure is still classified as a plain,
  distinct `OracleError`.

Full suite after this step: **137 tests** (41 SDK, up from 27 + 43 web +
53 indexer, both unchanged). No test was removed, weakened, or skipped;
this is a net increase.

## Real Testnet verification

Reproducing the *original* failure deterministically via real human
Freighter latency is impractical (that's the whole point — it depends on
unpredictable human timing, and Step 3 already found no Freighter
extension exists in this session's browser environment at all, a
*separate* limitation from this one). Instead, this step used a
deterministic, equally real substitute: a transaction whose `maxTime` is
constructed already in the past, submitted for real. This is not a
simulation of `tx_too_late` — it is a real transaction that a real
Stellar Core node genuinely, correctly rejects for exactly that reason,
just reached by construction instead of by waiting.

**Before the fix, live, real Testnet** (a genuinely stale
`createCustomContract` operation, complete with a real resource
footprint from a real `prepareTransaction` call):

```
status: ERROR
isTxTooLate: true
```

**The same stale transaction, run through the actual fixed
`refreshTimeBounds`, live, real Testnet:**

```
status: PENDING
CONFIRMED, real new contract: <a real ScAddress>
```

**A full, real, integrated exercise of the exact code path that failed
three times in Phase 4 Step 4** (`deploy.deployInstance`, unmodified
call signature, using a real locally-held Testnet key as the signer —
the same "CLI/SDK signing, distinct from and not a substitute for the
browser/Freighter path" convention this project has used honestly
whenever Freighter itself is unavailable, per Phase 2 and Phase 4 Steps 2
and 4):

```
DEPLOYED, real contract id: CAJSQW6ACVJU6YIQXKKV4MEFNES6XVJVPW4SPRA2AFUTHWJFQXR4RYIZ
```

Independently re-confirmed via a fresh, separate RPC read (not just
trusting the deploy call's own return value):

```
executable type: contractExecutableWasm
wasm hash: 05faa5704ac6f8fe0d21268b16782315a6573946bc6ab40b8277faf70eb43d53
```

(matching `PRICEFLOOR_WASM_HASH` exactly — a genuine, permanent,
on-chain AgriPriceFloor instance, not a stand-in.)

This proves, with real evidence rather than by inference from passing
unit tests: (1) the original failure mode is real and exactly
classified, (2) the fix resolves it for a real transaction carrying a
real Soroban resource footprint, not just a trivial operation, and (3)
the normal, non-stale flow through the actual production function
(`deployInstance`) remains fully intact after the change.

All verification scripts used for this were temporary, run via `tsx`
directly against `packages/sdk/src`, and deleted after use — they are not
part of the committed change; only the actual fix and its tests are.

## User-facing behavior

Unchanged unless `tx_too_late` is actually hit, in which case: previously
a raw `{"fee_charged":"...","result":"tx_too_late","ext":"v0"}` blob
surfaced (wrapped in a slightly-more-readable but still generic
`"${method} submission failed: ..."` string); now, a specific, plain-
English explanation that nothing was submitted, no funds moved, and a
fresh attempt (with a fresh signature) is what's needed — surfaced
through each flow's existing error display and "Try again"/"Start over"
controls, with no new UI code required.

## Remaining limitations

- **This fix could not be verified through an actual browser/Freighter
  signing flow**, because Step 3 already found no Freighter extension
  exists in this session's environment. This is the same, unresolved,
  separately-tracked limitation from Step 3 — not a new one, and not
  something this step's evidence changes either way. The SDK-level fix
  and its real-Testnet verification (above) are independent of, and do
  not require, the browser wallet layer at all: `refreshTimeBounds`
  operates purely on a `Transaction` object regardless of what will
  eventually sign it.
- **180 seconds is a considered, evidence-based value, not a guarantee**:
  an unusually slow approval (well over 3 minutes) could still hit
  `tx_too_late`, now with a clear, actionable message instead of a raw
  error, and the existing "try again" UI already handles that
  case correctly (a fresh attempt gets a fresh window).
- **The multiparty flow's fix has direct-mechanism verification
  (`refreshTimeBounds` preserving auth entries, unit-tested and
  live-verified via the single-signer path) but not a full live two-party
  browser submission**, since that path remains blocked by the same
  Freighter unavailability as Step 3. The exact mechanism
  (`submitMultiPartyInvocation` calling `refreshTimeBounds` on the
  fully-assembled, auth-entry-bearing transaction) is unit-tested
  directly and reuses the identical, live-verified `refreshTimeBounds`
  function the single-signer paths now use in production, so this is a
  reasoned extrapolation from real evidence, not a guess — but it is
  disclosed as one step short of a full live multiparty confirmation.

## Files changed

```
packages/sdk/src/deploy.ts             | +7 -2
packages/sdk/src/multiparty.ts         | +12 -2
packages/sdk/src/pricefloor.ts         | +8 -2
packages/sdk/src/soroban-tx.ts         | +91 -3
packages/sdk/src/soroban-tx.test.ts    | new
packages/sdk/src/types.ts              | +24
docs/phase5-step4-tx-too-late.md       | new (this file)
```

No application/UI code, contract, schema, or CI config was modified.
