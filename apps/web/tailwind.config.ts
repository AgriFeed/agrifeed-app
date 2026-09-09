import type { Config } from "tailwindcss";

// Tokens mirror DESIGN.md exactly. Do not add colors or radii here without
// extending DESIGN.md first.
//
// Phase 3 visual system: a commodities-desk / financial-press aesthetic
// (think a market ledger or exchange bulletin, not a dark trading terminal
// and not a green farm-tech template). Warm, restrained, paper-toned
// surfaces; ink-dark text; a single grain/ochre accent used sparingly.
// Token *names* are kept stable from the previous (dark) palette so every
// existing page's className references keep resolving correctly without
// being touched in this step — only the values and the additive semantic
// tokens are new.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Surfaces
        void: "#f6f3ec", // page background: warm parchment, not white, not black
        card: "#fffdf8", // content surface: a shade lighter than the page, bordered not shadowed
        border: "#a89a7a", // all dividers and card/control borders, 1px only; ~2.5:1 against void, deliberately visible enough to read as structure rather than a hairline

        // Brand accent: a roasted-grain ochre, used sparingly, never as a fill
        accent: "#9a5a1a",

        // Price direction (reserved for price deltas only, per DESIGN.md)
        "price-up": "#1f7a4d",
        "price-down": "#ac2c22",

        // Text
        ink: {
          primary: "#211d17",
          muted: "#756b58",
        },

        // Semantic status tokens (additive). Each pairs with a text/icon
        // label in the components that use it — color is never the only
        // signal. Deliberately distinct hue families so none can be
        // mistaken for another at a glance:
        //   success/positive -> price-up family (confirmed, funded, signed)
        //   error/negative   -> price-down family (failed, rejected, mismatch)
        //   warning          -> amber, distinct from the brand accent
        //   info             -> slate blue, cool contrast to the warm palette
        //   pending          -> muted gold, visually "in progress" not "done"
        //   testnet          -> violet, a hue used nowhere else in the
        //                       system, so the network badge can never be
        //                       confused with a status color
        status: {
          success: "#1f7a4d",
          error: "#ac2c22",
          warning: "#8a5c0e",
          info: "#3c5a74",
          pending: "#8a6a1f",
          testnet: "#5b4b8a",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        sans: ["var(--font-sans)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      boxShadow: {
        none: "none",
      },
    },
  },
  plugins: [],
};

export default config;
