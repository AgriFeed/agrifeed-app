# Phase 4 Step 6: My Deals + Persistent Deal Recovery

Builds the frontend on top of Step 5's `/api/deals`: a "My Deals" list
keyed on the connected Stellar address, and a `/deals/:contractId`
recovery route that works from contract id alone, independent of any
browser session. No backend changes, per this step's own constraint (the
existing `/api/deals` surface already supported everything needed).

## Core principle, made concrete

The browser is no longer the source of truth for whether a deal exists.
Every deal shown anywhere in this step traces back to exactly one call
chain: `loadMyDeals()` → `getDealsByFarmer()`/`getDealsByBuyer()` →
`GET /api/deals?farmer=`/`?buyer=`, or `getDeal()` → `GET
/api/deals/:contractId`. Nothing in that chain reads `localStorage`,
`sessionStorage`, or any other client-local store — confirmed by code
(no such call exists anywhere in `lib/deals.ts` or the new pages) and by
a dedicated test that seeds fabricated data under plausible localStorage
keys and asserts it never appears in the result (`deals.test.ts`).

## Routes and components added

- `apps/web/app/deals/page.tsx` — My Deals list. Client component (needs
  the connected wallet); reuses `WalletConnect` unchanged for connection,
  exactly as `/demo` already does.
- `apps/web/app/deals/[contractId]/page.tsx` — deal recovery route.
  **Server component**, deliberately: it has no client state to lose on
  refresh, so recovery is structural, not merely tested-to-work. Every
  load is a fresh `getDeal()` call.
- `apps/web/components/DealCard.tsx` — one deal in the list; card title is
  a real `<Link>` (keyboard-accessible, native tab+Enter), not a `<div>`
  with a click handler wrapping the whole card — `IdentifierDisplay`
  inside it renders its own interactive `<details>`/copy `<button>`, and
  nesting those inside an `<a>` is invalid HTML and breaks keyboard
  navigation, the same reason `Freshness` already offers a non-interactive
  mode.
- `apps/web/components/DealDetailView.tsx` — full deal detail plus
  status-specific `RecoveryGuidance` (see below).
- `apps/web/components/IndexedDealStatusBadge.tsx` — renders the
  *indexed* registry status (registered/initialized/funded/settled/
  cancelled), deliberately a separate component from the pre-existing
  `DealStateBadge` (which renders the browser-local signing-session state
  machine, a different vocabulary that only exists for an in-progress
  tab). Never conflates the two.
- `apps/web/components/DealFieldRow.tsx` — extracted from `NewDealFlow.tsx`'s
  previously-inline `DealSummary` row helper, so the deal card/detail view
  and the existing pre-signing summary render terms through one shared
  component rather than two similar-looking ones. `NewDealFlow.tsx` now
  imports it; its own rendered output is unchanged (pure extraction).
- `apps/web/lib/deals.ts` — pure logic, no React: `mergeDealsByRole`
  (dedupe + role-tag farmer/buyer/both results), `loadMyDeals` (the one
  function that fetches and merges), `commoditySymbol` (decodes the
  indexed `commodity` field's real shape).
- `apps/web/lib/api.ts` — added `Deal` (alias of the existing
  `PriceFloorInstance`), `getDealsByFarmer`/`getDealsByBuyer`/`getDeal`,
  hitting `/api/deals*`, never `/pricefloor-instances*`. `getDeal` returns
  a tagged result (`found`/`not-found`/`invalid`/`unavailable`) rather
  than collapsing three different "can't show it" cases into one.

Nav: `SiteNavLinks.tsx` gained one entry, `My Deals` → `/deals`, using the
same `aria-current="page"` mechanism every other link already has —
nothing else about navigation changed.

## What was deliberately left alone

Per this step's explicit constraints: Markets, Commodity Detail, Reporting
Network, and the Price Protection flow's own mechanics are unmodified.
`GET /pricefloor-instances*` (Step 2/3's route) is untouched and still
backs `NewDealFlow.tsx`'s registration call — My Deals is built entirely
on the newer `/api/deals*` surface instead, so neither route's behavior
depends on the other changing.

Two small, deliberate touches to existing components tie this step back
into the flow that creates deals, both text/prop-only, no mechanism
changes:

- `DealPersistenceNotice.tsx`: its copy was accurate but incomplete before
  this step — "save the contract ID or lose your place" was true only
  because nothing made a registered deal discoverable again. Now it says
  both things: the *signing session* is still never persisted and is
  lost for good on reload (unchanged, and still true), but the
  *registered contract* is now discoverable afterward via My Deals, with
  a link there.
- `DemoFlow.tsx`/`demo/page.tsx`: added optional `initialContractId`/
  `initialStep` props, read from `?contractId=&step=` query params (via a
  `Suspense`-wrapped child, required by Next.js for `useSearchParams()`).
  This is what the deal detail page's "Continue to fund"/"Continue to
  settle or cancel" links use — a shortcut into the exact same
  same-session Fund/Settle/Cancel forms any visitor already has by typing
  a contract id in by hand (there was no such manual-entry path before,
  the legacy-instance button was the only preset), never a new signing
  capability. Omitting the query params reproduces the exact prior
  behavior (defaults unchanged).

## Recovery behavior, precisely

`RecoveryGuidance` in `DealDetailView.tsx` branches on the indexed
`status` and says, per state, exactly what is and isn't recoverable:

| Status | What's shown |
|---|---|
| `registered` | Explicitly states the signing session (draft terms, any collected signatures) is gone for good if that's what happened — recovering this record does not restore it. Only path forward: start over, or re-initialize the same contract id with a fresh two-party session. |
| `initialized` | Funding still needed; deep-links to `/demo?contractId=&step=fund`. |
| `funded` | Settle/cancel still available once eligible; deep-links to `/demo?contractId=&step=settle-cancel`. |
| `settled` | Terminal, no action. Explicitly notes the indexed record has no payout/market-price field — those live only in the real on-chain `Settled` event, never fabricated here. |
| `cancelled` | Terminal, no action. States plainly that this status is event-only, never inferred from missing funding/settlement, and that live cancellation itself remains unverified in this environment (Step 4) — this page does not claim otherwise. |

Every deal detail page also carries an explicit provenance note ("this is
the indexer's last-recorded state... not a live RPC call made just now")
so indexed vs. on-chain state is never ambiguous, and a link to the REST
API docs for exactly what backs each field.

## State handling

My Deals distinguishes six states, matching the requirement list exactly:
disconnected (prompt to connect), connected-but-no-deals (`EmptyState`,
worded to say the indexer answered successfully and found nothing —
distinct from failure), loading (`aria-live="polite"` status text),
API failure (`SourceUnavailable`, `role="alert"`, never silently rendered
as an empty list), and populated (the card list). The deal detail route
separately distinguishes `not-found` (a real 404 — honest "no such deal")
from `invalid` (a malformed contract id — no lookup was even attempted)
from `unavailable` (indexer unreachable) — three different facts Step 5's
`getDeal()` tags explicitly rather than collapsing into null/error.

## Accessibility

- Heading hierarchy: My Deals is `h1` → each `DealCard`'s `h2`; deal
  detail is `h1` → `h2` per section (`Terms`, `Lifecycle timestamps`). No
  skipped levels anywhere new.
- Keyboard-accessible deal selection: each card's title is a real
  `<Link>`; browser default tab+Enter, no custom key handling needed, no
  nested interactive elements (see `DealCard.tsx`'s doc comment on why the
  whole card isn't one `<a>`).
- `aria-current="page"` on the new My Deals nav entry, via the existing
  `SiteNavLinks` mechanism — no new code needed.
- Loading and error states are announced (`aria-live="polite"` for
  loading; `SourceUnavailable`'s existing `role="alert"` for failure,
  without a redundant nested live region).
- Focus states: unchanged, inherited from the existing global
  `:focus-visible` rule (`globals.css`) — nothing here overrides it.

## Responsive behavior

Built entirely from patterns already shipped and visually verified
elsewhere in this app: `DealFieldRow`'s `flex-col` → `sm:flex-row` label/
value stacking (identical to the pre-existing `DealSummary` rows it was
extracted from), `DealCard`'s `grid-cols-2` → `sm:grid-cols-4` term grid,
and `IdentifierDisplay`'s existing `break-all`/`<details>` disclosure for
contract ids and addresses (unchanged, reused as-is — no raw untruncated
id sits in fixed-width layout anywhere new). No new fixed-width tables
were introduced; deals render as cards specifically so nothing needs
horizontal scroll to begin with.

**Disclosed limitation**: this session's browser automation tooling could
not actually resize the viewport (`resize_window` reported success but
`window.innerWidth` never changed), so the responsive behavior above is
verified by code review against already-shipped, already-visually-
verified patterns, not by a fresh narrow-viewport screenshot this step.

## Test evidence

19 new tests, pure-logic style (this project has no component-rendering
harness — no React Testing Library/jsdom is installed, confirmed by
checking `apps/web/package.json`; every existing frontend test, before
and after this step, tests `lib/*.ts` functions directly with a mocked
`fetch`, and this step follows that exact convention):

- `lib/api.test.ts` (+8): `getDealsByFarmer`/`getDealsByBuyer` hit
  `/api/deals`, not `/pricefloor-instances`; real settled/cancelled deal
  data passes through unmodified; an unreachable indexer throws
  `IndexerUnavailableError` rather than resolving empty. `getDeal`:
  `found`/`not-found` (404)/`invalid` (400)/`unavailable` (network
  failure), each asserted distinctly.
- `lib/deals.test.ts` (+11): `mergeDealsByRole` — farmer-only, buyer-only,
  present-in-both tagged `both` exactly once, ordering, empty case.
  `loadMyDeals` — real merge across both queries, empty portfolio, a
  propagated API failure, and the dedicated **no-localStorage-based-fake-
  discovery** regression test (seeds a fabricated deal under plausible
  localStorage keys, asserts it never appears — only what the mocked
  `/api/deals` response returned does). `commoditySymbol` — the real
  `["Other","COCOA"]` indexed shape, `null` for the pre-initialize case,
  `null` (never a guess) for any unrecognized shape.

Full suite after this step: **123 tests** (27 SDK + 43 web, up from 24
before this step's 19 additions + 53 indexer, indexer unchanged this
step). `pnpm typecheck`, `pnpm lint`, and `pnpm build` all pass across
every workspace.

**"Wallet loading/populated" states are not independently unit-tested**:
the hooks that drive them (`useState`/`useEffect` glue in `app/deals/page.tsx`)
are thin wrappers over `loadMyDeals`, which is tested; this matches the
project's own existing convention (`useCommodities`/`useOracleDecimals` in
`NewDealFlow.tsx` are equally untested at the hook level, for the same
reason — no component harness exists to test them directly).

## Real Testnet/browser evidence

Live-verified in a real browser against the real indexer and Step 4's
real settled instance (`CCE7VE63HC7NDKE4VNNGUTEQJZVNSMJ2NQY2TECERD42OF2QG26KX272`):

- `/deals/CCE7VE...6KX272` rendered the real settled deal correctly:
  status "settled", correct farmer/buyer addresses, commodity "COCOA",
  **floor price 4,082.0949368 and notional 0.0000100** — independently
  hand-computed from the real raw indexed values (`40820949368`/`100`)
  against COCOA's real decimals (7, from `/commodities`) and confirmed to
  match exactly — proving the commodity-decimals enrichment lookup is
  correct, not just present. Lifecycle timestamps section showed all
  four real observed transitions (registered/initialized/funded/settled)
  with the real ledger number, and "Cancelled: not yet observed."
- `/deals/<real oracle contract id, never registered as a deal>` →
  `not-found`, live.
- `/deals/not-a-real-contract-id` → `invalid`, live, no RPC/DB call made.
- `/deals` while disconnected → the connect-wallet prompt, live.
- **API-failure state, live**: the real indexer process was deliberately
  stopped mid-session and `/deals/CCE7VE...6KX272` reloaded — rendered
  `SourceUnavailable` ("source unavailable... shown honestly rather than
  substituted with a fabricated value"), not a 404 and not an empty
  state, confirming requirement 14 end to end, not just in a unit test.
  The indexer was restarted immediately after and reconfirmed healthy
  (`GET /health` → `200`) before continuing.
- One real, unrelated environment issue found and fixed along the way:
  this repo's own `.env.local` declares `DATABASE_URL=...localhost:5432/agrifeed`,
  but port 5432 on this host is actually an unrelated project's Postgres
  container (`backend_postgres_1`); the real, working `agrifeed` dev
  database has been reachable at `localhost:5433/agrifeed` all session
  (the same Postgres server the `agrifeed_test` database already lives
  on, per every other step's test config). `.env.local` is gitignored and
  local-only — not corrected here, out of scope for this step, but worth
  noting for whoever next restarts the indexer locally.

**Not verified live this step**: a wallet-connected, populated My Deals
list, and the `/demo?contractId=&step=` deep link's actual "recovered
from My Deals" badge, both because no Freighter extension was available
in this session's automated browser (confirmed: clicking "Connect
Freighter" produced no error text and no state change, consistent with
the extension being absent, not a code fault — the only browser console
error present was an unrelated hydration warning from a third-party
wallet extension injecting DOM attributes). This is disclosed, not
glossed over: the underlying data flow for both is covered by the unit
tests above, and the query-param threading was confirmed live to reach
the page (URL preserved, no console errors, no React error boundary
triggered) up to the point Freighter's absence stopped the flow.

## Remaining limitations

- No live-connected-wallet browser QA of the populated My Deals list or
  the recovered-instance deep link this step (Freighter unavailable in
  this session's browser, see above).
- Responsive behavior verified by code review, not a resized-viewport
  screenshot, per the tooling limitation above.
- `cancel()` remains unverified live end to end (Step 4's finding,
  unchanged and explicitly not claimed otherwise anywhere in this step's
  UI copy, per this step's own constraint).
- Settled deals show only the indexed timestamp, never a payout amount
  or market price — those fields do not exist in `pricefloor_instances`
  (only in the raw `Settled` event's own JSON, not exposed via
  `/api/deals`); stated honestly on the detail page rather than papered
  over.
- No pagination on My Deals' list itself (it calls `getDealsByFarmer`/
  `getDealsByBuyer` with `/api/deals`'s own default 50-item limit, no
  `?limit=`/`?offset=` passed through) — reasonable for now given no
  address in this project has anywhere near 50 deals; a real limitation
  if that ever changes, not solved here.

## Files changed

```
apps/web/app/deals/page.tsx                    | new
apps/web/app/deals/[contractId]/page.tsx        | new
apps/web/app/demo/page.tsx                      | +20 -2
apps/web/app/docs/page.tsx                      | +65 -3
apps/web/components/DealCard.tsx                | new
apps/web/components/DealDetailView.tsx          | new
apps/web/components/DealFieldRow.tsx            | new
apps/web/components/DealPersistenceNotice.tsx   | +30 -11
apps/web/components/DemoFlow.tsx                | +30 -7
apps/web/components/DocsNav.tsx                 | +1
apps/web/components/IndexedDealStatusBadge.tsx  | new
apps/web/components/NewDealFlow.tsx             | +25 -14
apps/web/components/SiteNavLinks.tsx            | +1
apps/web/lib/api.ts                             | +51
apps/web/lib/api.test.ts                        | +109
apps/web/lib/deals.ts                           | new
apps/web/lib/deals.test.ts                      | new
```
