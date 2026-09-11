# Phase 6, Step 3 — node-relayer Transaction Lifecycle Consolidation

Implements the CONSOLIDATE decision from
`docs/phase6-step2-submit-lifecycle-audit.md`. Baseline: `origin/main` at
`0603a8b`.

## What was duplicated

`services/node-relayer/src/submit/submit.ts`'s `submitPrice` hand-rolled
its own sign/send/poll sequence: `prepared.sign(keypair)` directly (no
time-bounds refresh), `server.sendTransaction`, then a manual 20-attempt,
1500ms-interval polling loop with three separate `OracleError` throw
sites — a second, independently-maintained copy of exactly the lifecycle
`packages/sdk/src/soroban-tx.ts`'s `refreshTimeBounds`/`submitAndConfirm`
already implement and already test (used by every other write path in
this project: `pricefloor.ts`'s `invokeAndConfirm`, `multiparty.ts`'s
`submitMultiPartyInvocation`). The duplicate copy never inherited the
Phase 5 Step 4 `tx_too_late` fix or classification.

## What was consolidated

`submitPrice` now builds and simulates its own transaction (Oracle's
`submit_price` shape remains node-relayer's own concern, not the SDK's),
then hands off to the shared primitives for everything after simulation:

```ts
const prepared = await server.prepareTransaction(built);
const readyToSign = refreshTimeBounds(prepared);
readyToSign.sign(keypair);

const hash = Buffer.from(readyToSign.hash()).toString("hex");
await submitAndConfirm(server, readyToSign, `submit_price(${commodity})`);
logger.info("submit_price confirmed", { commodity, hash, rawPrice });
```

The manual 20-attempt polling loop and its three `OracleError` throw sites
are gone entirely — not left in place as dead code, verified by re-reading
the final file (`services/node-relayer/src/submit/submit.ts`, 84 lines,
down from a functionally-equivalent but duplicated 79-line original with a
now-removed 22-line hand-rolled loop replaced by 3 lines calling the
shared primitives).

`submitPrice` deliberately does **not** call `pricefloor.ts`'s
`invokeAndConfirm` itself — only the two lower-level primitives it is
built from (`refreshTimeBounds`, `submitAndConfirm`). `invokeAndConfirm`
wraps every result in `friendlyContractError`, which maps
`agripricefloor`'s own error-code enum to human messages; reusing it would
silently misdescribe Oracle's entirely different error enum
(`NotAuthorizedNode`, `UnknownCommodity`, `InvalidPrice`, ...). This
matches the audit's "D. Node-relayer-specific requirements" finding
exactly.

## Public SDK export change

`packages/sdk/src/soroban-tx.ts` was previously internal to the SDK
package (consumed only by `pricefloor.ts`/`multiparty.ts`, never
re-exported). `packages/sdk/src/index.ts` now additionally exports:

```ts
export { refreshTimeBounds, submitAndConfirm } from "./soroban-tx.js";
```

Only these two primitives — not the whole module. `isTxTooLate` and
`SIGNING_VALIDITY_SECONDS` remain internal; node-relayer needs neither
directly (only the `instanceof TxTooLateError` check, and `TxTooLateError`
was already public via the pre-existing `export * from "./types.js"`).
This is purely additive: no existing export was changed or removed, and
the full SDK test suite (41 tests) passes unchanged.

## Preserved node-relayer-specific behavior

- **Oracle write path unchanged**: same contract (`config.oracleContractId`),
  same function (`submit_price`), same four arguments in the same order
  (node address, `Asset::Other(commodity)`, `i128` price, `u64`
  source_ts), same source account (`keypair.publicKey()`, fetched via
  `server.getAccount`), same hardcoded fee (`"1000000"`) and network
  passphrase (`Networks.TESTNET`) — none of this construction logic moved
  into the SDK; it remains entirely in `submit.ts`, as node-relayer's own
  concern.
- **Signing identity unchanged**: `readyToSign.sign(keypair)` — the same
  server-held `Keypair`, at a point in the flow that is strictly later
  than before (after the refresh, not before it), never a different
  signer.
- **Authorization semantics unchanged**: `submit_price`'s
  `node.require_auth()` (`agrifeed-contract/contracts/agrifeed-oracle/src/
  ingest.rs:126`) is satisfied by `SorobanCredentials::SourceAccount`
  since `node == keypair.publicKey() == tx.sourceAccount` — no separate
  `SorobanAuthorizationEntry` was ever needed, none was introduced, and
  `refreshTimeBounds` is documented and tested to never touch
  authorization entries regardless.
- **Confirmation log preserved**: `logger.info("submit_price confirmed", {
  commodity, hash, rawPrice })` still fires on success, with the same
  fields — `hash` is now computed locally via `readyToSign.hash()` before
  submission (deterministic from the signed envelope) rather than read
  back from `sendResult.hash`; both are the same transaction hash.
- **Config/env validation untouched**: `services/node-relayer/src/env.ts`
  (including the Phase 5 Step 7 `parseSubmitIntervalSeconds` fail-fast fix
  for `NODE_RELAYER_SUBMIT_INTERVAL_SECONDS`) was not modified at all — no
  lines changed, confirmed via `git diff` scope check.

## `tx_too_late` behavior

`submitPrice` now inherits the SDK's real classification: a genuine
`tx_too_late` rejection from Stellar Core throws `TxTooLateError` (which
`extends OracleError`, so every existing `toBeInstanceOf(OracleError)`
assertion remains valid), not the generic `OracleError` every other
rejection reason still produces. The refreshed ~180-second signing window
(vs. the original, unrefreshed 60 seconds fixed at build time) also
reduces how often this can happen in the first place — though, as the
audit noted, node-relayer's actual risk here was always lower than the
browser/human-approval case this fix originally targeted, since there is
no human-approval gap between `prepareTransaction` and `sendTransaction`.
No independent implementation of refresh or classification was added;
both come exclusively from the shared SDK primitives.

## Error handling: server-appropriate `TxTooLateError` messaging

Per the audit's "E. Error semantics" finding, the shared SDK
`TxTooLateError` message (`packages/sdk/src/types.ts`) is worded for a
human at a browser wallet ("approving it in the wallet took longer than
the window allowed... a fresh transaction will be prepared and will need
a fresh signature") — correct for its real callers
(`pricefloor.ts`/`multiparty.ts`), misleading for an unattended server.

**The shared SDK message was not edited or forked** — doing so would
reintroduce the kind of duplication this step removes. Instead, a new,
small, node-relayer-local module,
`services/node-relayer/src/submitFailureLog.ts`, exports
`logSubmitFailure(err, commodity)`:

```ts
export function logSubmitFailure(err: unknown, commodity: string): void {
  if (err instanceof TxTooLateError) {
    logger.warn(
      "submit_price: signing window expired before reaching the network -- transient, no funds moved, " +
        "the next scheduled cycle will retry with a fresh transaction",
      { commodity },
    );
    return;
  }
  logger.error("failed to submit price, skipping this commodity this cycle", {
    commodity,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

`services/index.ts`'s `tick()` now calls this instead of its previous
inline `catch` body. The message never mentions a wallet, browser, or
prompt, and correctly describes the real behavior: no immediate retry
exists (the next scheduled cycle, up to
`NODE_RELAYER_SUBMIT_INTERVAL_SECONDS` later, is what actually retries) —
"try again" language from the SDK's own message would be actively wrong
here, since nothing in this process acts on that instruction.

`logSubmitFailure` was placed in its own module, not inlined in
`index.ts`, specifically so it could be imported and tested directly
without triggering `index.ts`'s top-level `main()` call (an import side
effect that would call `loadEnv()` outside a configured environment and
set `process.exitCode`) — this is a scope-minimal structural change, not
unrelated cleanup: `index.ts` itself keeps the exact same `tick()` control
flow, just calling `logSubmitFailure(err, commodity)` where it previously
inlined the same logic.

## Tests

### A. SDK public export
New test in `submit.test.ts`: `refreshTimeBounds`/`submitAndConfirm`
imported directly from `@agrifeed/sdk` (the package's public surface, not
an internal `dist/` path) and asserted to be functions.

### B. Successful submission path
Pre-existing test ("builds, signs, submits, and confirms... unchanged
shape") re-verified unmodified against the refactored code: real XDR
decode of the submitted operation confirms `submit_price` is still
invoked with the same four arguments in the same order.

### C. `tx_too_late` path
Two new tests: a real `xdr.TransactionResultResult.txTooLate()` rejection
is classified as `TxTooLateError` (not generic `OracleError`), with the
commodity still present in the message via the `submit_price(${commodity})`
method label; and `sendTransaction` is confirmed called exactly once even
on `tx_too_late` (no silent stale-transaction resubmission — `submitAndConfirm`'s
own no-retry guarantee, not a second, possibly-divergent implementation).
Three new tests total in `submitFailureLog.test.ts` cover the
`logSubmitFailure` branch itself: the `TxTooLateError` case never mentions
"wallet"/"browser"/"prompt" and logs at `warn`; every other error kind
still logs the original generic `error`-level line unchanged; a
non-`Error` thrown value is still routed through the generic path,
stringified, without crashing.

### D. Transaction correctness
Covered by the pre-existing "builds, signs, submits..." and "signs with
the node's own keypair..." tests (source account, contract, function,
arguments, and a real cryptographic signature-verification check), plus a
new test asserting the submitted transaction's `timeBounds.maxTime` is
well beyond the original 60-second build-time window — direct,
non-inferential proof that `refreshTimeBounds` is genuinely wired into the
call path, not merely imported.

### E. Confirmation/failure behavior
All four pre-existing tests covering the successful-confirmation,
submission-rejection, on-chain-failure, and confirmation-timeout paths
pass unmodified.

### F. Configuration regression
`env.ts` was not touched; its own existing test suite
(`env.test.ts`, unaffected) continues to cover
`parseSubmitIntervalSeconds`'s fail-fast validation. Re-run as part of the
full suite below with no changes.

### G. No duplicate lifecycle
The `timeBounds.maxTime` test (D, above) is the direct proof: the old,
duplicated implementation never refreshed time bounds, so a passing
assertion that the window is refreshed is only possible if the shared SDK
path — not a coincidentally-identical parallel implementation — is what
actually ran. Additionally, `submit.ts` itself was re-read after the edit
to confirm the manual polling loop's code no longer exists anywhere in the
file (not commented out, not left unreachable).

**No test mocks the entire SDK or the `submit` module.** Every stub
remains at the true external boundary already established by this
project's convention: `@stellar/stellar-sdk`'s `rpc.Server` constructor
only (real `TransactionBuilder`, real `Transaction`, real XDR
encode/decode, real `Keypair` signing throughout) — the SDK's
`refreshTimeBounds`/`submitAndConfirm` functions themselves run for real
in every test, unmocked.

## Real Testnet verification

Using this project's already-established, already-authorized Testnet
oracle node identity (`NODE_RELAYER_SECRET_KEY` from `.env.local` — a
Testnet-only key added via `add_node` in an earlier phase, not a
production/mainnet secret):

1. **Configuration loaded successfully**: `loadEnv()` returned node
   identity `GCG3CEYVBAH3DD33AM76A3BGEYWUDNS2F5HNOWHXL3MU6KXSGUQREIWD`,
   oracle contract `CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T`.
2. **A real `submit_price(COCOA)` call** was made through the refactored
   `submitPrice` (built `dist/`, real Testnet RPC, no stubs) with a fresh
   `rawPrice` (`61234567890`) and current `sourceTs`.
3. **Signed by the expected node identity**: the same `Keypair` loaded
   from `NODE_RELAYER_SECRET_KEY`.
4. **Submitted and confirmed**: `submitPrice` returned without throwing,
   logging `"submit_price confirmed"` with transaction hash
   `66525c3d5db1f3cf8066d60a68157bf18c7c18909ba743a10c480aca3a78aca6`.
5. **Independently re-verified**, in a *separate* script invocation, over
   a *fresh* `StellarRpc.Server` instance (not reusing `submitPrice`'s own
   server object or trusting its self-reported success alone):
   `server.getTransaction(hash)` → `status: "SUCCESS"`, ledger `4619181`;
   the transaction's own real, on-chain `contractEventsXdr` decodes to:
   ```
   topics: ["price_submitted", ["Other", "COCOA"], "GCG3CEYVBAH3DD33AM76A3BGEYWUDNS2F5HNOWHXL3MU6KXSGUQREIWD"]
   data:   { price: 61234567890n }
   ```
   — exact match to the submitted node, commodity, and price. This is not
   a fabricated or assumed-successful RPC response; it is a second, fresh
   RPC round trip reading the real transaction's own recorded result.
6. **No live `tx_too_late` reproduction was attempted**, per this task's
   own instruction ("not mandatory if it cannot be safely produced"). The
   underlying mechanism (`refreshTimeBounds`/`isTxTooLate`/
   `submitAndConfirm`) is unchanged from what Phase 5 Step 4 already
   proved live against real Testnet rejections and successes, and the
   deterministic tests above (§C) directly exercise the classification
   path node-relayer now shares. Re-proving the same unchanged, already-
   live-proven mechanism a second time would not produce new evidence.

## Validation

| Check | Baseline (Step 2 audit) | After this step |
| --- | --- | --- |
| `pnpm --filter @agrifeed/sdk test` | 41 passed | 41 passed (unchanged) |
| `pnpm --filter @agrifeed/node-relayer test` | 55 passed | 62 passed (+7: 4 in `submit.test.ts`, 3 in new `submitFailureLog.test.ts`) |
| Full workspace `pnpm test` | 199 passed | 206 passed (SDK 41 + web 43 + indexer 60 + node-relayer 62) |
| `pnpm typecheck` (full workspace) | clean | clean |
| `pnpm lint` (full workspace) | clean | clean |
| `pnpm build` (full workspace) | clean | clean |

No test was removed or weakened; every new test count is additive and
explained above.

## CI evidence

Commit `<pending>` (`refactor(node-relayer): reuse shared transaction
lifecycle`), pushed to `origin/main`. Real GitHub Actions run recorded
here once pushed, matching this project's established pattern of never
predicting CI results before they exist.

## Remaining limitations

- **Live `cancel()` remains unverified** — unrelated to and untouched by
  this step; carried forward exactly as documented in every prior phase
  report. This step does not claim otherwise.
- **`friendlyContractError`-equivalent mapping for Oracle's own error
  codes** (`NotAuthorizedNode`, `UnknownCommodity`, `InvalidPrice`,
  `DuplicateSubmission`, ...) was not added — out of scope for this
  consolidation, which only reuses the two generic lifecycle primitives.
  An operator today still sees a generic `OracleError` message for these
  (unchanged from before this step).
- **No new decentralization or reliability claim**: this step changes
  only where the sign/submit/poll logic lives and how one failure mode is
  classified/logged; it does not change how many nodes exist, how often
  the relayer runs, or add any new retry/backoff behavior beyond what
  already existed (still no immediate retry; still only the next
  scheduled cycle).
