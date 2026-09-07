import type { Config } from "tailwindcss";

// Tokens mirror DESIGN.md exactly. Do not add colors or radii here without
// extending DESIGN.md first, in its own commit.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        void: "#0a0a0b",
        card: "#131417",
        border: "#24262b",
        accent: "#e0a72b",
        "price-up": "#22c55e",
        "price-down": "#ef4444",
        ink: {
          primary: "#f4f4f5",
          muted: "#71717a",
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
