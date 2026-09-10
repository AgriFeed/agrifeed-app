# Phase 5 Step 3: Freighter Compatibility Re-verification

**Baseline**: `origin/main` at `c99ee1d` (Phase 5 Step 2, CI restored and
live-verified). No code changes required by this step (see verdict) — no
commits made beyond this report.

## Verdict: **UNVERIFIED**

Freighter is genuinely unavailable in this session's browser environment.
Per this step's own instructions ("If Freighter is unavailable in this
environment: do not claim pass or fail of the wallet flow... leave the
limitation explicitly open"), this is not reported as PASS or FAIL. Every
non-browser verification legitimately possible was performed instead (see
below), and none of it found a reason to believe the underlying Phase 3
Step 7 finding has changed, resolved, or worsened — it remains exactly
where it was, genuinely unknown either way without a real installed
Freighter extension to test against.

## Browser/environment details

- Chrome, `Mozilla/5.0 (X11; Linux x86_64) ... Chrome/150.0.0.0 Safari/537.36`.
- `mcp__claude-in-chrome__list_connected_browsers` → exactly one connected
  browser (`"Browser 1"`, Linux, local) — no alternate browser with a
  different extension set was available to switch to.
- A different wallet extension **is** present and actively injecting into
  every page load — console showed `bybit:page provider inject code`
  (from `chrome-extension://pdliaogehgdbhbnmkklieghmmjkpigpa/...`) on
  every navigation to `/demo`. This confirms the browser profile is
  capable of running extensions generally; specifically no Freighter
  extension is among them.

## Detected Freighter version/state

**Not installed.** Directly checked, twice, at different points in this
step:

```js
{
  hasFreighterApiGlobal: typeof window.freighterApi !== "undefined", // false
  freighterKeys: Object.keys(window).filter(k => /freighter/i.test(k)), // []
}
```

`window.freighterApi` is the object `@stellar/freighter-api`'s functions
communicate through; its complete absence (not merely `isConnected()`
returning false) means no Freighter extension of any version is present
in this profile, consistent with the identical finding in Phase 4 Steps 6
and 7. This step adds one new data point beyond those: `isFreighterInstalled()`
was exercised through the real UI (clicking "Connect Freighter" on
`/demo`), not just checked via `window.freighterApi`'s absence — see
"Exact wallet flow exercised" below.

## SDK/protocol versions

| | Value | Notes |
|---|---|---|
| `@stellar/stellar-sdk` (installed, both `packages/sdk` and `apps/web`) | `17.0.1` | Matches `npm view @stellar/stellar-sdk version` — already the latest published version; nothing newer to upgrade to. |
| `@stellar/freighter-api` (installed) | `6.0.1` | Matches `npm view @stellar/freighter-api version` — already latest. |
| Soroban RPC protocol version (`getLatestLedger` against `https://soroban-testnet.stellar.org`, checked live this step) | `28` | Unchanged from Phase 3 Step 7's finding — Testnet has not upgraded protocol version since then, so the specific condition that finding described (protocol 28 defaulting to `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries) still applies to every real simulation this app performs. |

`packages/sdk/src/multiparty.ts` and `packages/sdk/src/wallet.ts` (the
two files that construct and sign multi-party Soroban authorization) are
**byte-identical** to their state at `1a64e6f`, the commit where Phase 3
Step 7's finding was recorded (`git diff 1a64e6f..HEAD -- packages/sdk/src/multiparty.ts packages/sdk/src/wallet.ts`
returns empty). Nothing on the application or SDK side has changed since
that finding; nothing that would predict a different result either way.

## Exact wallet flow exercised

1. Navigated to `/demo` (fresh page load, console cleared first).
2. Located and clicked the real "Connect Freighter" button (`WalletConnect.tsx`,
   unmodified) via its actual DOM element, not a simulated event.
3. Waited 2 seconds, then inspected: page text (`get_page_text`), console
   messages, and `document.activeElement`/button state.

**Result**: the button returned to its idle "Connect Freighter" label
(never showed "Connecting…", meaning `handleConnect()`'s `finally` block
already ran). No error paragraph rendered. No console error, warning, or
log from this app's own code appeared — only the unrelated `bybit`
extension's own injection log, which fires on every page load regardless
of any click. This matches `isFreighterInstalled()`'s actual implementation
(`packages/sdk/src/wallet.ts`): it calls `@stellar/freighter-api`'s
`isConnected()` and returns `false` if `result.error` is set. With no
Freighter extension present to answer the postMessage `isConnected()`
sends, this session could not determine with certainty whether that call
resolved with an error (taking the `!installed` branch, which calls
`setError(...)`) or never resolved at all — but in either case, **no
Testnet transaction, no signature request, and no authorization entry
was ever attempted**, because the flow never got past this first gate.
This is consistent with, not contradictory to, "Freighter is absent":
the flow stopped at step 1 of 9 (connect), never reaching deploy,
initialize, farmer signing, or buyer signing.

Steps 6-9 of this task's own numbered verification list (deploy a fresh
instance; exercise farmer signing; exercise buyer signing; observe
Freighter's exact auth-entry behavior) were **not reachable** — none of
them can be exercised without first successfully connecting a wallet, and
that did not happen. This is reported plainly rather than working around
it: fabricating a signature or bypassing the connect gate to reach later
steps would violate this task's own constraints (11-14).

## Testnet transaction/contract evidence

None produced by this step's browser attempt (none was reachable, see
above). This does not mean Price Protection's other real transaction
evidence is invalid — Phase 4 Steps 2 and 4's real deploy/register/
initialize/fund/settle transactions (via CLI/SDK signing with locally-held
keys, explicitly distinct from the browser path) remain real, on-chain,
and independently re-verified as recently as Phase 4 Step 7. This step
did not need to and did not re-produce those; it specifically targeted
the one link in the chain that has never been proven via a real browser
wallet.

## Root-cause classification

**(f) Environment/setup.** Not (a) application construction, not (b) SDK
serialization, not (c) authorization-entry construction, not (e) network/
protocol mismatch — none of those layers were ever reached, because the
browser never had a Freighter extension to connect to in the first place.
**(d) Freighter API compatibility** — the actual subject of Phase 3 Step
7's original finding — remains **neither confirmed nor refuted** by this
step: it requires a real installed Freighter extension actually parsing a
real simulated auth entry to test, and none was available. This is the
one open question this step could not close either way.

## Was a code fix required?

**No.** No failure was produced by this repository's own code — the
gate that stopped the flow is Freighter's absence, external to this
codebase. Making a code change here would have no effect on that and
would risk exactly what this task's instructions rule out: "Only
implement a compatibility fix if the evidence demonstrates that a
repository-side fix is actually required" — the evidence does not.

## Full test results (this step)

| Check | Result |
|---|---|
| `packages/sdk` test suite (includes `wallet.test.ts`, `multiparty.test.ts`) | **27/27 passed**, re-run this step |
| Full monorepo suite (`pnpm test`) | **123/123 passed** (27 SDK + 43 web + 53 indexer), unchanged from Phase 5 Step 2 |
| `pnpm typecheck` | Pass, all 4 workspaces |
| `pnpm lint` | Pass, no warnings |
| `pnpm build` | Pass, all 4 workspaces |

`wallet.test.ts` specifically (re-read this step, not just re-run) is a
legitimate, pre-existing unit test of this repo's own error-surfacing
logic — it mocks `@stellar/freighter-api` at the module boundary to
assert `connectFreighter`/`freighterSignAndSend`/`signAuthEntryWithFreighter`
correctly extract Freighter's real error message rather than stringifying
the whole error object. This is not, and was never claimed to be, a
substitute for the live browser verification this step targeted — it
exists to cover this repository's own logic, which is a different thing
from whether a real Freighter extension can parse a real auth entry. No
new test was added or needed this step: nothing in this repository's own
code was found to be wrong, so there is nothing here for a regression
test to pin down.

No test was skipped, mocked, or replaced to work around Freighter's
absence for the *browser* portion of this verification — the browser
flow was attempted for real, stopped where it genuinely stopped, and
that stopping point is reported as-is rather than routed around.

## Wallet/recovery UX claims re-verified

Re-checked directly against the current file contents this step (not
assumed from the Phase 4 Step 6/7 reports, though nothing has changed
since — `git log c99ee1d..HEAD` on these files is empty):

- **Signing sessions are not claimed recoverable.** `DealPersistenceNotice.tsx`:
  "This browser tab's signing progress is not saved anywhere... loses any
  signatures collected so far, for good." `DealDetailView.tsx`'s
  `RecoveryGuidance` (the `registered`-status case): "that session's
  draft terms and any signatures collected so far are gone for good...
  they were never persisted anywhere, on this indexer or otherwise."
- **Multi-device signing is not claimed to exist.** No occurrence of
  "another device," "different device," or any equivalent phrase found
  in either file, or anywhere in `apps/web/components/NewDealFlow.tsx`
  (grep-checked). The one cross-page link Phase 4 Step 6 added
  (`/demo?contractId=&step=`) only presets which contract id the existing
  same-session Fund/Settle/Cancel forms act on; it carries no signing
  state and both parties must still independently connect and sign in
  that same browser tab.
- **Cancellation is not claimed live-proven.** `DealDetailView.tsx`'s
  `cancelled` case: "Live cancellation itself remains unverified end to
  end in this environment... this page does not present cancellation as
  a live-proven action, only reports what the indexer actually recorded."

No drift found in any of the three areas this step was specifically asked
to re-check.

## Remaining limitation(s)

**Freighter/browser wallet compatibility for the multi-party PriceFloor
`initialize` flow remains an open, unresolved question**, exactly as it
was after Phase 3 Step 7 and every subsequent step that touched it. What
this step adds: confirmation that nothing on the application, SDK, or
network-protocol side has changed in the meantime that would predict a
different outcome (same SDK versions, already latest; same Soroban
protocol version, 28; byte-identical `multiparty.ts`/`wallet.ts`) — so
the original finding's premises still hold, even though this step could
not re-run the actual test that produced it. Resolving this requires a
test environment with a real, currently-published Freighter extension
actually installed; this session's environment does not have one, and no
alternate connected browser that does was available either.

## Files changed this step

```
docs/phase5-step3-freighter-verification.md | new (this file)
```

No application code, test, contract, or CI config was modified.
