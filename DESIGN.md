# AgriFeed Design System

## 1. Overview

Creative north star: a commodities-desk market ledger — a bulletin a grain
trader or a price-protection buyer would actually read — not a farming app
and not a crypto trading terminal. Phase 3 moved the palette from a dark,
near-black "trading terminal" surface to a warm, restrained, paper-toned
light surface, specifically because a dark monospace-heavy screen reads as
generic Web3-dashboard aesthetics, which the product direction explicitly
rules out. Everything else about the original discipline is kept: no leaf
iconography, no green gradient hero sections, no farm photography, no
rounded bubbly SaaS cards, no drop shadows.

## 2. Colors

| Token | Value | Use |
|---|---|---|
| bg-void | #f6f3ec | page background (warm parchment; token name is a legacy carryover from the original dark palette, kept stable so existing className references don't need touching) |
| bg-card | #fffdf8 | content surfaces, a shade lighter than the page |
| border | #a89a7a | all dividers and card/control borders, 1px only |
| accent | #9a5a1a | primary accent (roasted-grain ochre), used sparingly, never as a background fill |
| price-up | #1f7a4d | price deltas only |
| price-down | #ac2c22 | price deltas only |
| ink-primary | #211d17 | body text |
| ink-muted | #756b58 | labels, timestamps, secondary text |
| status-success | #1f7a4d | confirmed/funded/signed — same hue as price-up, different semantic name so redesign work doesn't conflate "price went up" with "this succeeded" |
| status-error | #ac2c22 | failed/rejected/mismatch |
| status-warning | #8a5c0e | stale data, non-blocking cautions |
| status-info | #3c5a74 | informational, cool contrast to the warm palette |
| status-pending | #8a6a1f | in-progress, deliberately distinct from both warning and accent |
| status-testnet | #5b4b8a | the network indicator only — reserved for this one purpose so it can never be mistaken for a status color |

Color still carries meaning, never decoration. Every status/semantic token is
required to pair with a text label or glyph wherever it's used (see
StatusBadge, NetworkBadge) — nothing in this system communicates state by
color alone.

Contrast: ink-primary/void ≈ 15:1, ink-muted/void ≈ 4.7:1, all status.*
tokens against void ≥ 4.5:1 (WCAG AA for normal text), border/void ≈ 2.5:1
(sufficient to read as structure without competing with content).

## 3. Typography

- Display / headers: a serif display face (Playfair Display), evokes a
  financial-press masthead, not a rounded tech sans-serif.
- Body and UI controls: Inter.
- All numbers, prices, timestamps, contract addresses, node identifiers,
  transaction hashes: a monospace face (JetBrains Mono), no exceptions.

Unchanged from the original system — this pairing already did what Phase 3
needs; no font changes were made.

## 4. Data presentation primitives (Phase 3)

Shared components now exist so every screen renders these the same way
instead of reinventing the treatment per page:

- `PriceDisplay` — a price, always monospace, always with its unit.
- `PriceChange` — direction arrow + sr-only text label, never color alone.
- `Freshness` — relative age, with the absolute timestamp reachable via a
  native `<details>` disclosure, plus an explicit stale state when a
  caller supplies a staleness threshold.
- `NodeCount` — reporting-node **count** only.
- `ContributorList` — contributing-node **identities** for one
  finalization. Never combined with NodeCount in the same element.
- `ProvenanceTag` — distinguishes a finalized price from a raw submission.
- `IdentifierDisplay` — Stellar address / contract ID / transaction hash,
  each explicitly labeled by kind, truncated with the full value reachable
  via disclosure, with a copy affordance.
- `StatusBadge` — the one generic semantic-status primitive (six tones);
  every pending/confirmed/failed/error/warning/info state in the app
  should render through this rather than a bespoke badge.
- `NetworkBadge` — the permanent, always-visible Testnet indicator.
- `DealStateBadge` / `FundedBadge` — the Price Protection lifecycle
  vocabulary, mirroring `dealState.ts`'s real `DealStatus` union exactly.
  "Signed" and "confirmed" are always two different badges, never one.
- `ParticipantAuthStatus` — one participant's (farmer's or buyer's)
  expected-vs-connected wallet comparison and signing state.
- `DealPersistenceNotice` — the mandatory, non-dismissible reminder that a
  deal in progress exists only in the current browser tab.
- `EmptyState` / `StaleBanner` / `SourceUnavailable` — the three
  non-error-but-not-fully-fresh states, kept visually distinct from each
  other and from a hard error.

The ticker row component (`.ticker-row`) is unchanged in shape and remains
the signature pattern:

`[SYMBOL] [PRICE in mono] [colored delta arrow] [N/M nodes reporting] [last updated timestamp]`

## 5. Elevation

No drop shadows anywhere. Depth comes from border color transitions only.
On hover, a *clickable* card's border brightens to the accent color (see
`.ticker-row`); a non-clickable `.card` container no longer has a hover
effect, since implying interactivity where none exists is its own kind of
misleading affordance.

## 6. Do and don't

Do:
- Format every price in monospace with the commodity's unit shown
  explicitly (for example `6,188.00 USD/MT`).
- Show the data source and last-updated timestamp next to every price,
  through `Freshness`, not a bare relative-time string.
- Show exactly which nodes contributed to a finalized price on the
  `/commodity/[symbol]` page, through `ContributorList`, never a count
  standing in for identity.
- Use skeleton loading states, never spinners, to avoid layout shift.
- Say "Testnet," "indexed," "finalized," explicitly — see the copy
  principles in the Phase 3 Step 2 specification.

Don't:
- Use any leaf, plant, or farm photography or icon set.
- Use a green gradient anywhere as a decorative background.
- Use rounded bubbly cards or floating shadows.
- Animate anything other than the card border, the ticker row's price
  flash on update, and `prefers-reduced-motion`-respecting skeletons.
- Show a price anywhere without its source and freshness attached.
- Call anything "live," "decentralized," "real-time," or "production-grade"
  without the qualification the Phase 3 Step 1 audit requires.
