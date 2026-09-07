# AgriFeed Design System

## 1. Overview

Creative north star: a commodity exchange ticker board, not a farming app.
This project deliberately avoids the visual cliches of agricultural technology
products: no leaf iconography, no green gradient hero sections, no farm
photography, no rounded bubbly SaaS cards. The audience is developers and
reviewers deciding whether to trust a price feed, treat the interface like a
trading floor display, not a consumer app.

## 2. Colors

| Token | Value | Use |
|---|---|---|
| bg-void | #0a0a0b | page background |
| bg-card | #131417 | card surfaces |
| border | #24262b | all dividers and card borders, 1px only |
| accent | #e0a72b | primary accent, used sparingly, never as a background fill |
| price-up | #22c55e | price deltas only |
| price-down | #ef4444 | price deltas only |
| ink-primary | #f4f4f5 | body text |
| ink-muted | #71717a | labels, timestamps, secondary text |

Color carries meaning here. Green and red are reserved for price direction,
never used decoratively elsewhere in the interface.

## 3. Typography

- Display / headers: a serif display face, evokes financial press mastheads,
  not a rounded tech sans-serif
- Body and UI controls: Inter
- All numbers, prices, timestamps, contract addresses, node identifiers:
  a monospace face (IBM Plex Mono or JetBrains Mono), no exceptions

## 4. The ticker row component

The signature component of this project. Every price shown anywhere in the
app uses this pattern:

`[SYMBOL] [PRICE in mono] [colored delta arrow] [N/M nodes reporting] [last updated timestamp]`

This is not decorative, it is the actual trust mechanism made visible. A
price without its node count and timestamp next to it is not shown anywhere
in this app.

## 5. Elevation

No drop shadows anywhere. Depth comes from border color transitions only.
On hover, a card's border brightens to the accent color, the card itself
does not lift, scale, or gain a shadow.

## 6. Do and don't

Do:
- Format every price in monospace with the commodity's unit shown explicitly
  (for example `6,188.00 USD/MT`)
- Show the data source and last-updated timestamp next to every price
- Show exactly which nodes contributed to a finalized price on the
  `/commodity/[symbol]` page, never hide this
- Use skeleton loading states, never spinners, to avoid layout shift

Don't:
- Use any leaf, plant, or farm photography or icon set
- Use a green gradient anywhere as a decorative background
- Use rounded bubbly cards or floating shadows
- Animate anything other than the card border and the ticker row's price
  flash on update
- Show a price anywhere without its source and freshness attached
