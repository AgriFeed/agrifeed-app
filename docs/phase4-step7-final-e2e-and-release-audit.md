# Phase 4 Step 7: Final End-to-End Validation and Release Audit

**Baseline**: `origin/main` at `6727368` ("feat(web): add persistent
pricefloor deals", Step 6). This step makes no product changes of its
own except a local-environment configuration fix (§E) — no application
code, contract, schema, or route was modified.

Reads first, as instructed:
[phase4-pricefloor-deal-registry.md](./phase4-pricefloor-deal-registry.md) (Step 1),
[phase4-step4-lifecycle-and-decision.md](./phase4-step4-lifecycle-and-decision.md),
[phase4-step5-deals-api.md](./phase4-step5-deals-api.md),
[phase4-step6-my-deals.md](./phase4-step6-my-deals.md).

## Automated verification

All run against `6727368` with no code changes in between.

| Check | Result |
|---|---|
| `pnpm typecheck` (4 workspaces) | Pass |
| `pnpm lint` (apps/web; no lint script elsewhere) | Pass, no warnings |
| `pnpm test` | **123 passed** (27 SDK + 43 web + 53 indexer), 0 failed |
| `pnpm build` (4 workspaces) | Pass |
| `migrate()` against the real dev database | Ran clean, idempotent (see §E for which database this actually is) |
| `db/schema.test.ts` (part of the 53 indexer tests) | Covers migrate-twice safety and the F-07 stale-constraint self-heal regression |

No test file was added or modified this step; these are the same 123
tests Step 6 already established, re-run here as this step's own
confirmation they still hold on the exact baseline being audited.

## The complete chain, validated with real Testnet evidence

Rather than mint new Testnet transactions for facts already proven live
in earlier steps (deployment, registration, initialize, fund, settle —
all demonstrated end-to-end in Step 4 with real tx hashes, see that
report), this step **independently re-verifies those same real,
still-live instances right now**, at this baseline, through every layer:
a fresh direct RPC read (bypassing the indexer entirely), a fresh
indexer/API read, and a fresh frontend render — confirming the whole
chain still agrees today, not just in a historical log. This is stronger
evidence for a release audit than repeating already-proven transactions
would be: it proves the *system*, as currently deployed, still correctly
reconstructs reality, not just that a past run once succeeded.

### Four real, independently existing PriceFloor instances, covering every non-cancelled lifecycle state

| # | Contract id | Real farmer | Real buyer | Commodity | On-chain `Funded`/`Settled` (fresh RPC read) | Indexer `status` (fresh API read) | Agreement |
|---|---|---|---|---|---|---|---|
| 1 | `CD2AX7NTIDGLWBYOY4Y4EYFLPTNCPACXDDCO3XSN7BAEB74UWVE7JCQN` | `GCPM65...IIFR62` | `GC2ZGB...MACTO3` | COCOA | `true`/`false` | `funded` | ✅ match |
| 2 | `CC4YDCQJL4PYXJGC3QSPW3WXNQMEVL6QDJEHH3E556EOEEPUN4RVC6P7` | `GDWU5Y...MNTW7T` | `GABZIO...Q25AES` | COFFEE | `false`/`false` | `initialized` | ✅ match |
| 3 | `CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272` | `GCPM65...IIFR62` | `GC2ZGB...MACTO3` | COCOA | `true`/`true` | `settled` | ✅ match |
| 4 | `CDPHWHKMFHW3GB6ATZZ6LOCXDK5IXCYEHXWOV4CR44KTCMKQPRPZSAZL` | — (never initialized) | — | — | n/a (no storage yet) | `registered` | ✅ match |

Instance 1's and 2's on-chain flags were read directly this step via a
throwaway script calling `getContractInstance()` against
`https://soroban-testnet.stellar.org` (the same primitive
`instances.ts`'s `enrichInstanceStorage` uses), decoding the same
`DataKey` shapes confirmed in Step 2. Instance 3 is Step 4's real settled
instance; instance 4 is the real instance Step 3's live browser E2E
deployed and registered, never initialized since. **Every field in every
row above was independently re-derived from the live network and the
live indexer during this step, not copied from an earlier report.**

Floor price/notional also cross-checked through the frontend's decimal
formatting: instance 1 rendered `6,188.0000000` / `1.0000000` (raw
`61880000000`/`10000000` ÷ 10^7), instance 2 rendered `4,895.0000000` /
`0.5000000` (raw `48950000000`/`5000000` ÷ 10^7) — both hand-verified
against the raw on-chain values, both correct.

### 1–6: deployment → registration → initialization → funding → maturity → settlement

Covered by instances 1–4 above (deployment/registration: all four;
initialization: 1–3; funding: 1, 3; maturity + settlement: 3, whose
maturity has passed and which is `settled`). Re-verified this step, not
re-performed, per the reasoning above. Real tx hashes for the
originating transactions are recorded in the Step 2 and Step 4 reports
and were not re-collected here since the on-chain state itself, not the
historical transaction log, is what this step independently confirmed.

### 7: indexer lifecycle reconstruction

Confirmed exactly (table above): the indexer's `status` and every stored
term for all four instances matches a same-moment direct RPC read,
field-for-field, with no drift.

### 8–9: `/api/deals` and farmer/buyer filtering

Live `curl` against the real running indexer (not the test database):

```
GET /api/deals/<instance 1-4 id>        → each returns exactly that instance's real terms
GET /api/deals?farmer=<instance 1&3's shared farmer>
                                         → ["CCE7VE...6KX272", "CD2AX7...E7JCQN"], nothing else
GET /api/deals?buyer=<instance 1&3's shared buyer>
                                         → the same two, nothing else
GET /api/deals?farmer=<instance 2's farmer>
                                         → ["CC4YDCQJ...UN4RVC6P7"], nothing else
GET /api/deals?buyer=<instance 2's buyer>
                                         → the same one, nothing else
```

Instances 1 and 3 deliberately share the same real farmer and buyer
addresses (both were created by the same test identities across Step 2
and Step 4) — this is a stronger isolation test than two unrelated
addresses would be: it proves isolation holds **by contract id**, not
merely by address, even when one address has multiple deals.

### 10–12: `/deals`, `/deals/:contractId`, refresh/revisit recovery

Live browser checks (Chrome via this session's browser automation),
against the real indexer, at this baseline:

- `/deals` while disconnected → connect-wallet prompt, correct.
- `/deals/<instance 1 id>` → renders `funded — awaiting settlement`,
  correct terms, correct lifecycle timestamps, a live "Continue to
  settle or cancel" deep link.
- `/deals/<instance 2 id>` → renders `initialized — not yet funded`,
  correct terms, correct "Continue to fund this deal" deep link.
- `/deals/<instance 3 id>` → renders `settled`, no fabricated
  payout/market-price (confirmed absent from the raw API response too,
  see below).
- `/deals/<instance 4 id>` → renders `registered — not yet initialized`,
  every unestablished term shown as literal `unavailable`/`—`, never
  guessed, with the exact "signing session is gone for good, the
  persisted contract id is not" recovery copy Step 6 wrote.
- **Refresh/revisit recovery, proven, not assumed**: instance 2's page
  was closed and re-navigated to fresh (a new top-level request, the
  same thing a browser restart produces for a server component with no
  client state) — byte-for-byte identical content both times.
- **API failure ≠ empty portfolio, proven live**: the real indexer
  process was deliberately stopped mid-audit; `/deals/<instance 1 id>`
  reloaded and rendered `✕ source unavailable — This deal could not be
  read from the indexer. This is shown honestly rather than substituted
  with a fabricated value.` — not a 404, not an empty state. The indexer
  was restarted immediately after (see §E for the exact fix that made
  the clean restart possible) and reconfirmed serving the same correct
  data as before the outage.
- **Invalid ≠ unknown, proven live**: `/deals/not-a-real-contract-id` →
  `"not-a-real-contract-id" is not shaped like a real Soroban contract
  id, so no lookup was made` (no RPC/DB call attempted); a real but
  never-registered contract id (the oracle's own) → `No deal is
  registered under this contract id. This is a real, successful answer
  from the indexer...` — two different, correctly-labeled facts, live.

### Settled state is not fabricated

```
GET /api/deals/CCE7VE...6KX272 → keys: buyer, cancelledAt, commodity,
contractId, farmer, floorPrice, fundedAt, initializedAt, maturityTs,
notional, oracleContractId, registeredAt, registeredAtLedger, settledAt,
settlementToken, status
```

No `payout` or `marketPrice`/`market_price` key exists anywhere in the
response (confirmed live, not just by reading the schema) — the frontend
detail view says so explicitly rather than omitting the point silently.

### Cancelled status remains event-derived

Unchanged since Step 4/5/6, re-confirmed by reading the current code,
not assumed: `services/indexer/src/poll.ts`'s `case "cancelled"` is the
**only** place any row's `status` column is ever set to `'cancelled'`,
and it fires only from a real observed `Cancelled` event. No code path
in `services/indexer/src/api/deals.ts`, `apps/web/lib/deals.ts`, or
anywhere in `apps/web/components/DealDetailView.tsx` infers cancellation
from missing funding, missing settlement, or any other snapshot —
confirmed by reading each file, not merely trusting prior reports.

### Frontend never uses localStorage/sessionStorage for deal discovery

```
$ grep -rn "localStorage\|sessionStorage" apps/web --include="*.ts" --include="*.tsx" | grep -v ".test."
lib/deals.ts:9:  * localStorage/sessionStorage or any other client-local store...
lib/deals.ts:50: * sitting in localStorage under some app-chosen key would see none of it
```

The only two matches in the entire non-test source tree are doc comments
*explaining* that no such storage is used — zero actual reads or writes
of either API anywhere in `apps/web`. Combined with Step 6's dedicated
regression test (seeds a fabricated deal under plausible localStorage
keys, asserts it never appears in `loadMyDeals`'s output), this is
verified both statically and behaviorally.

## Two-instance isolation, explicitly

Required minimum of two; this step used four (table above), including
the deliberately-adversarial case of two instances (1 and 3) sharing the
exact same real farmer and buyer addresses. In every layer checked —
direct RPC, indexer database, `/api/deals` (unfiltered, farmer-filtered,
buyer-filtered), and the frontend detail pages — every instance's terms,
status, and timestamps were distinct and correct, with no
cross-contamination in either direction.

## Known limitations, audited

### A. `cancel()` — remains unverified live, honestly

Not accelerated, not faked. Re-confirmed by reading
`agripricefloor`'s `cancel()` again this step (unchanged since Step 4):
`UNFUNDED_CANCEL_GRACE` and `SETTLE_FAILURE_GRACE` are each real
`48 * 60 * 60` second constants with no test-mode override, no
environment-variable escape hatch, nothing in this codebase that could
shorten them. This step made no attempt to wait them out or simulate
them. Every UI surface that could imply otherwise (`DealDetailView`'s
`cancelled` case, `docs/page.tsx`'s "My Deals & recovery" section, the
Testing section) still says plainly that cancellation is unverified —
confirmed by reading their current text, not assumed. **Status:
unchanged, correctly unverified, correctly disclosed everywhere.**

### B. Freighter/browser wallet compatibility — current state, exact evidence

**No Freighter extension is present in this session's browser
environment**, confirmed directly: `window.freighterApi` is `undefined`
and no `freighter`-named key exists anywhere on `window` on a live page
load of `/demo`. Clicking "Connect Freighter" produces no visible error
text and the button returns to its idle state (not "Connecting…"),
which this audit could not fully attribute to a specific code path
without deeper devtools access than this browser automation tooling
provides — recorded honestly as an inconclusive observation rather than
guessed at. This is a different situation from Phase 3 Step 7's
previously-documented finding (an *installed* Freighter version that
could not parse `SOROBAN_CREDENTIALS_ADDRESS_V2` auth entries): that
finding could not be re-verified this step, because no Freighter is
installed here at all to test it against. **No workaround, downgrade, or
authorization-error bypass was attempted or introduced** — this section
is a record of current environment state, not a fix.

### C. Multi-session signing — confirmed still deferred, not implied

Read `DemoFlow.tsx`, `NewDealFlow.tsx`, and `DealDetailView.tsx` again
this step specifically looking for any claim otherwise: none exists. The
recovery experience's own `RecoveryGuidance` component explicitly says,
for a `registered`-but-never-initialized deal, that "that session's
draft terms and any signatures collected so far are gone for good...
initialize this same contract id again with a **fresh** two-party
signing session" — the opposite of implying resumption. The `?contractId=`
deep link into `/demo` (Step 6) only presets which contract id
Fund/Settle/Cancel act on; it does not carry, restore, or imply any
signing state, and both parties must still independently connect and
sign in that same browser tab, same as before Step 6 existed. **Status:
unchanged, correctly deferred, correctly not implied as supported.**

### D. Responsive/accessibility — what could and could not be checked live

**Could check live, and did**:
- Heading hierarchy on `/deals/:contractId`: `document.querySelectorAll('main h1,h2,h3')`
  returned exactly `["H1:Deal detail", "H2:Terms", "H2:Lifecycle timestamps"]`
  — no skipped levels, confirmed by direct DOM query, not visual inspection.
- Responsive classes present in the actually-served HTML: a direct DOM
  query found 13 real `DealFieldRow` elements on the page, every one
  carrying `flex flex-col ... sm:flex-row sm:items-baseline
  sm:justify-between` — confirmed present in the live-rendered markup,
  not merely in source.
- The global `:focus-visible` outline rule remains defined once, in
  `app/globals.css`, unchanged; no new component introduced by Step 6
  or checked in this step sets `outline: none` or disables it anywhere
  (confirmed by grep across the new files).
- localStorage/sessionStorage absence (above) is itself an accessibility-
  adjacent guarantee: no state that could desync from what a screen
  reader or keyboard user's session actually reflects.

**Could not check live, disclosed rather than assumed**: this session's
`resize_window` tool reports success but does not change the actual
rendered viewport (`window.innerWidth` stayed `1992` after requesting
`390×844` — confirmed twice, in Step 6 and again this step, so this is a
reproducible tooling limitation, not a one-off). A real narrow-viewport
screenshot and a real keyboard-only tab-order walkthrough (an attempted
`Tab` keypress left `document.activeElement` on `<body>`, another
environment limitation with this automation setup, not a page defect —
inconclusive rather than a finding) were **not** obtained this step.
This is stated plainly rather than claimed. What stands in their place:
static DOM/class verification (above) plus code review confirming every
new component reuses the same responsive/focus patterns already shipped
and visually verified in Phase 3 (Step 6's own report makes the same
disclosure for the same reason).

### E. Local environment — `.env.local` `DATABASE_URL`, found and fixed

**Root cause, confirmed this step**: this machine's Docker has an
*unrelated* project's Postgres container (`backend_postgres_1`) bound to
host port 5432. This repo's own `docker-compose.yml` also declares port
5432 for its Postgres service, so that service (`agrifeed-app_postgres_1`)
never actually started — `docker ps -a` shows it stuck in `Created`,
never `Up`. The real, working `agrifeed` dev database has been reachable
at **port 5433** the entire time (the same Postgres server the
`agrifeed_test` database already lives on, per every test file's own
`TEST_DATABASE_URL` default). `.env.local` still said `5432`.

**Effect on current operation, confirmed**: `services/indexer` reads
`DATABASE_URL` directly from `process.env` (`env.ts`) with no `dotenv`
loading of its own, so `.env.local`'s wrong value only actually mattered
whenever someone started the indexer in a way that sourced it (or
manually exported the same wrong value, as this session did more than
once before catching it). `apps/web`'s Next.js dev/build process *does*
auto-load `.env.local` (visible in every build log's `- Environments:
.env.local` line) — but `apps/web` never reads `DATABASE_URL` at all
(only `services/indexer` does), so this particular stale value never
actually broke the frontend; it only broke a naive indexer restart.

**Fix applied**: `.env.local`'s `DATABASE_URL` line corrected to port
`5433`, with an explanatory comment recording exactly why (see the file
itself). `.env.local` is gitignored (verified: `git check-ignore -v
.env.local` → matches `.gitignore:9`) — this fix touches no tracked
file and commits no secret; `git status` after the edit showed no
change. `.env.example` (tracked, port `5432`) was deliberately **left
unchanged** — that is the correct general-case default for a machine
where this repo's own compose file isn't fighting an unrelated
container for the same port, so changing it would make the documented
default wrong for everyone else.

**Fix verified working**: killed every stray indexer process, then ran
`set -a; source .env.local; set +a; pnpm dev:indexer` — the indexer
started clean, reported healthy (`GET /health` → `200`), and served the
real, correct data for all four instances above with no manual
overrides needed.

**Explicitly not fixed, and why this stops here rather than expanding
Step 7**: `services/indexer` still has no `dotenv`-style auto-loading of
`.env.local` of its own — only `apps/web` gets that for free from
Next.js. So the corrected value only helps a developer who explicitly
sources `.env.local` (as verified above) or exports the same value by
hand; it does not, by itself, make a bare `pnpm dev:indexer` "just work"
without either. Adding `dotenv`/`tsx --env-file` loading to
`services/indexer` would fix that gap for good, but it is a real,
substantive code change to how the indexer starts — exactly the kind of
change this step's own instructions say to stop and report separately
rather than fold into an audit step. **Reported here, not implemented.**
Along the way, three duplicate stray `tsx watch` process trees left over
from this session's own earlier restarts (none from before this step)
were found and cleaned up as routine hygiene, not a code change.

## Release recommendation

**Recommend proceeding**, with the limitations above carried forward
exactly as stated, not resolved by this step:

- The persistent registry → API → frontend chain is real, correctly
  isolated per contract id, correctly distinguishes every "can't show
  it" case from every other, and correctly refuses to fabricate state
  anywhere this audit checked — including under a deliberately-induced
  live outage.
- `cancel()` stays honestly unproven; nothing in the product claims
  otherwise.
- Freighter availability in any given environment remains outside this
  project's control; this step adds one more honestly-recorded data
  point (extension absent here) rather than resolving the underlying
  compatibility question from Phase 3 Step 7.
- Multi-session signing remains correctly out of scope and is not
  implied anywhere in the recovery experience.
- One real local-environment footgun was found and fixed at the
  configuration level; the small remaining gap (indexer doesn't
  auto-load `.env.local`) is flagged for a future step, not silently
  patched here.

Nothing found this step blocks release on its own terms: every gap is
already known, already disclosed in the product's own UI/docs, and
none of them regressed.

## Phase 4 verdict

**PASS.**

Every step's acceptance criteria (1 through 6, and this step's own)
hold on the current `main` baseline, re-verified independently rather
than assumed from prior reports: real multi-instance deployment,
registration, lifecycle indexing, a documented and validated REST API,
and a frontend that discovers and recovers deals exclusively through
that API — with isolation, honesty about failure states, and disclosed
(not hidden) limitations intact throughout.

## Files changed this step

```
.env.local (gitignored, not committed) | DATABASE_URL port corrected, comment added
docs/phase4-step7-final-e2e-and-release-audit.md | new (this file)
```

No application code, test, schema, or route was modified.
