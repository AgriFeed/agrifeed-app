# Phase 5 Step 5: Documentation Currency Pass

**Baseline**: `origin/main` at `c982155` (Phase 5 Step 4, tx_too_late
resilience fix). This step is documentation-only — no application,
contract, indexer, API, or wallet/SDK code was modified. No feature
behavior was changed, intentionally or otherwise.

## Documents audited

- `README.md`
- `PRODUCT.md`
- `DESIGN.md`
- `apps/web/app/docs/page.tsx` (the public Developers & Docs content —
  the largest and most stale of the four, since it describes the
  system's actual mechanics in the most detail)
- `CONTRIBUTING.md` (read for staleness; no corrections needed, see
  below)

Cross-referenced against: `docs/phase5-readiness-and-scope.md` (Step 1's
own findings F3/O1, the starting point for this pass),
`docs/phase4-step7-final-e2e-and-release-audit.md`,
`docs/phase4-step6-my-deals.md`, `docs/phase4-step5-deals-api.md`,
`docs/phase4-step4-lifecycle-and-decision.md`,
`docs/phase5-step3-freighter-verification.md`, and the current source
(`services/indexer/src/api/server.ts`'s actual route table, specifically
checked rather than assumed, to confirm exactly which HTTP methods each
path supports before writing anything about it).

## Stale statements found, and exact corrections made

### `apps/web/app/docs/page.tsx`

1. **`getState` doc comment claimed "arbitrary instances are not
   indexed"** (SDK section, `pricefloor.*`). False since Phase 4:
   registered instances are indexed and readable via `GET
   /api/deals/:contractId`. **Correction**: reworded to say the gap is in
   this one stub function specifically (`getState` doesn't call the
   indexer at all — confirmed by reading `pricefloor.ts`'s actual
   implementation, `void config; return {};`), not in indexing coverage
   generally, with a link to REST API / My Deals & recovery.
   **Evidence**: `services/indexer/src/api/server.ts` line 329 (`GET
   /api/deals/:contractId`); `docs/phase4-step5-deals-api.md`.

2. **"it is the only PriceFloor instance the indexer currently watches"**
   (Testnet deployment section, describing the legacy fallback instance).
   False since Phase 4 Step 2. **Correction**: reworded to state plainly
   that any instance registered via `POST /pricefloor-instances` is
   watched alongside it, readable through `GET /api/deals*`.
   **Evidence**: confirmed the exact route by reading
   `services/indexer/src/api/server.ts` directly (`app.post(
   "/pricefloor-instances", ...)` is the only registration route; there
   is no `POST /api/deals` — an error in my own first draft of this
   correction, caught and fixed before finalizing by checking the route
   table rather than assuming).

3. **The Architecture section's "current gap" callout** stated "The
   indexer only watches the Oracle and one fixed, legacy PriceFloor
   instance... Multi-instance PriceFloor indexing is not implemented."
   This is the single most stale statement found in this pass — it
   describes the pre-Phase-4 architecture almost verbatim, and matches
   exactly the stale-claim pattern this step's own instructions named as
   an example ("single fixed PriceFloor," "not indexed"). **Correction**:
   replaced the callout; added a second diagram (the PriceFloor *read*
   path: registry → indexer → `/api/deals` → My Deals) alongside the
   existing write-path diagram, which itself was updated to show the
   `POST /pricefloor-instances` registration step it previously omitted.
   The new callout states plainly that multi-instance indexing is
   implemented and real, cites the Phase 4 Step 7 audit for independently
   re-verified isolation evidence, and narrows the *actually* open gap to
   what it really is: `cancel()` and the browser/Freighter path, not
   multi-instance indexing.

4. **The PriceFloor section's "current limitation" note** said only "a
   deal in progress that isn't finished before the tab closes is lost,"
   with no mention that this refers to the *signing session* specifically
   and that the *registered contract* is a separate, recoverable fact
   since Phase 4 Step 6. **Correction**: added the distinction, matching
   the same correction already made to `DealPersistenceNotice.tsx` in
   Phase 4 Step 6 — this is the same class of stale claim in a different
   document, brought into alignment with it.

5. **The "environment note" about Freighter's `SOROBAN_CREDENTIALS_ADDRESS_V2`
   incompatibility** was accurate as a historical record but had no
   follow-up reflecting Phase 5 Step 3's attempt to re-verify it.
   **Correction**: added a new, explicitly-labeled "unverified" note
   stating that Step 3 found no Freighter extension installed at all, so
   the original finding could be "neither reconfirmed nor refuted," and
   that Freighter compatibility for this flow is therefore accurately
   `unverified` — not proven working, not confirmed broken. This is
   exactly the distinction this step's own instructions required
   (§4: "current Step 3 result is UNVERIFIED... do not describe Freighter
   compatibility as proven or broken"). **Evidence**:
   `docs/phase5-step3-freighter-verification.md`'s verdict and exact
   findings.

6. **The Integration guide was missing a workflow entirely.** It was
   headed "Six practical workflows" and covered read/deploy/prepare/sign/
   submit, but never mentioned discovering or recovering an already-
   registered deal over REST — a real, live, Phase-4-shipped capability
   with no entry anywhere in this developer-facing guide. **Correction**:
   added workflow **G, "Discover and recover a registered deal (REST,
   Testnet)"**, and corrected the heading to "Seven." This is filling a
   real gap in documenting an *existing* capability, not adding a new
   one — no code changed, only the description of what already exists.

### `README.md`

7. **The Routes table omitted `/deals` and `/deals/:contractId`
   entirely** (Step 1 finding F3). **Correction**: added both rows,
   worded to match the table's existing style, plus a one-line addition
   to `/docs`'s own description noting it now also covers the deal
   registry. **Evidence**: `apps/web/app/deals/page.tsx` and
   `apps/web/app/deals/[contractId]/page.tsx` exist and are real, live
   routes (confirmed present in the build output's own route table,
   `pnpm build`'s "Route (app)" listing, both this step and every prior
   step since Phase 4 Step 6).

8. **The Quickstart section never mentioned
   `NEXT_PUBLIC_PRICEFLOOR_WASM_HASH`/`PRICEFLOOR_WASM_HASH`** (Step 1
   finding O1) — a newcomer following only the README would get a
   working oracle/ticker but a silently broken deal-registration flow,
   with no explanation why. **Correction**: added one paragraph
   explaining what these two variables are for and what breaks without
   them, pointing to `.env.example` for the full list rather than
   duplicating it.

### `PRODUCT.md`

9. **"Who this is for" never mentioned persistent deal discovery or
   `/api/deals`** at all, describing Price Protection as if it ended at
   `/demo`. **Correction**: added, to the existing farmer/buyer bullet,
   that a registered deal stays discoverable on `/deals` independent of
   the browser tab it was created in, with the same signing-session
   caveat as everywhere else (never overclaiming recoverability); added,
   to the existing developers bullet, that `/api/deals` exists alongside
   the oracle's own read API. No new bullet added, no restructuring — the
   existing three-audience structure was preserved exactly.

### `DESIGN.md`

10. **The component inventory (§4) described `DealPersistenceNotice` by
    its pre-Phase-4-Step-6 copy** ("a deal in progress exists only in the
    current browser tab" — the exact wording that component had *before*
    Step 6 updated it to also explain registry-based recovery) and never
    listed the four components Phase 4 actually added (`DealCard`,
    `DealDetailView`, `DealFieldRow`, `IndexedDealStatusBadge`).
    **Correction**: updated `DealPersistenceNotice`'s description to
    match its current, real copy; added entries for all four missing
    components, each phrased to state what it's for and, where relevant,
    why it's deliberately a separate component from an existing one
    (`IndexedDealStatusBadge` vs. `DealStateBadge` — indexed-registry
    state vs. browser-session state, the same distinction the components'
    own source comments already make). Also relabeled `DealStateBadge`/
    `FundedBadge`'s entry to say explicitly "browser signing session"
    lifecycle, so the contrast with the new indexed-registry badge is
    unambiguous on first read rather than only inferable.

### `CONTRIBUTING.md`

No stale statements found. Grepped for the same pattern set (`not
indexed`, `not queryable`, `single.*fixed`, `settlement not`,
`disappears`) with zero matches; its testing/setup instructions are
generic enough (`pnpm typecheck`/`lint`/`build`, `migrate` against a
clean database) that nothing in Phase 4/5 made them inaccurate. Left
unchanged.

## tx_too_late (§5 of this step's instructions)

Checked explicitly: no public-facing document (`README.md`, `PRODUCT.md`,
`DESIGN.md`, or the Developers & Docs page) ever mentioned the 60-second
transaction-validity window, `tx_too_late`, or any equivalent
implementation detail — grepped for `timeout`, `too_late`, `too late`,
`validity window`, `setTimeout` across all four with zero matches. There
was therefore no stale statement to correct here, and per this step's own
instruction ("do not expose unnecessary implementation detail in
product-facing docs"), none was added either: the fix from Phase 5 Step 4
is internal SDK behavior with no public-facing claim that needed
correcting or that would benefit from new exposure.

## Statements intentionally left unchanged

- The Contract reference table's `cancel()` row (grace-period conditions)
  — already accurate, matches the real contract source, unchanged since
  Phase 4 Step 4's findings.
- The Testing section's scope note — already correctly states `settle()`
  has been exercised live and `cancel()` has not, with the real 48-96
  hour grace-period reasoning (fixed in Phase 4 Step 6, re-verified
  accurate this step by reading it fresh rather than trusting the prior
  fix).
- The My Deals & recovery section — already correct on every point this
  step was asked to check (persistent discovery, refresh/browser-restart
  recovery, non-recoverable signing sessions, no multi-device signing,
  event-only cancellation), written in Phase 4 Step 6 and re-verified in
  Phase 4 Step 7; nothing here had drifted.
- `PRODUCT.md`'s "The problem" and "What AgriFeed is" sections — accurate
  descriptions of the oracle and PriceFloor concepts themselves, not
  implementation-detail claims that Phase 4/5 could have made stale.
- `README.md`'s opening paragraph and "Why `indexer` and `node-relayer`
  live here" section — architectural reasoning, unaffected by any
  Phase 4/5 capability change.
- `DESIGN.md`'s color/typography/elevation sections (§§2-3, 5) and "Do
  and don't" (§6) — pure visual-system rules, no feature claims to go
  stale.
- The REST API section's `/api/deals` documentation (field-source table,
  `cancelled` event-only note, pagination behavior) — written in Phase 4
  Step 5, re-verified this step against the real route implementation and
  found still exactly accurate; no changes needed.

## No feature behavior was intentionally changed

Confirmed by the diffstat itself: only `README.md`, `PRODUCT.md`,
`DESIGN.md`, and `apps/web/app/docs/page.tsx` changed. No file under
`services/indexer`, `packages/sdk`, `apps/web/components`,
`apps/web/app/deals`, `apps/web/app/demo`, or any contract path was
touched. `pnpm build`'s route table is identical before and after this
step's changes (same eight routes, same static/dynamic split), confirming
the one `.tsx` file touched is prose-only and produces no behavioral
diff.

## Validation performed

Because this step is documentation-only, no new tests were written and
none needed to be: there is no new logic to cover. What was actually run,
per this step's own instruction to report real validation rather than
fabricate a need for it:

| Check | Result |
|---|---|
| `pnpm typecheck` (all 4 workspaces) | Pass |
| `pnpm lint` (`apps/web`; no lint script elsewhere) | Pass, no warnings |
| `pnpm test` (full suite) | **137 passed** (41 SDK + 43 web + 53 indexer), unchanged from Phase 5 Step 4 — expected, since no test-relevant code changed |
| `pnpm build` (all 4 workspaces) | Pass; route table unchanged (`/`, `/commodity/[symbol]`, `/deals`, `/deals/[contractId]`, `/demo`, `/docs`, `/nodes`, plus `/_not-found`) |
| Live render check | `/docs#architecture` loaded in a real browser after the changes; every new paragraph, both new diagrams, the new "unverified" callout, and the new workflow G rendered correctly and read coherently in context (not just checked for valid JSX) |

`pnpm test` was run to confirm the touched `.tsx` file introduced no
regression, per this step's own instruction to run the full suite "if the
repository workflow requires it for any touched code/config" — `apps/web`
is a workspace with its own test suite and build step, so this was the
correct, non-fabricated validation to perform, not an unnecessary one.

## Remaining documented limitations (carried forward, not resolved by this step)

Exactly as before, now accurately reflected rather than under- or
over-stated:

- `cancel()` remains explicitly unverified live end to end (real 48-96
  hour grace periods, no way to fast-forward on Testnet).
- Freighter browser compatibility remains explicitly `unverified` — not
  proven working, not confirmed broken — pending a real re-test against
  a currently-installed extension.
- Multi-session/multi-device signing remains explicitly deferred, stated
  plainly in three places (`PriceFloor`, `Wallet & signing`, `My Deals &
  recovery` sections) with no contradiction between them.
- The `Cancelled` storage-flag gap (Phase 4 Step 4's finding) is
  referenced from the REST API and My Deals sections, unchanged, no new
  claim made about it.
- This project remains explicitly positioned as a Testnet reference
  implementation throughout every document touched; no production-
  readiness claim was introduced or implied anywhere in this pass.

## Files changed

```
DESIGN.md                    | +23 -5
PRODUCT.md                   | +8 -2
README.md                    | +8 -1
apps/web/app/docs/page.tsx   | +75 -22
docs/phase5-step5-documentation-currency.md | new (this file)
```

No application, contract, indexer, API, or wallet/SDK code was modified.
