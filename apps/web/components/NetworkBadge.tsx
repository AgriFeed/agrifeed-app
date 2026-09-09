import { networkLabel, stellarNetwork } from "@/lib/stellar";

/**
 * Global network indicator (Phase 3 Step 4). Always renders full text, never
 * a color-only dot, and is placed in the persistent site header so it is
 * visible on every screen, including mobile — see SiteNav.tsx. The violet
 * "testnet" tone is reserved for this indicator alone so it can never read
 * as a status color (success/error/warning/pending), which all live in a
 * different hue family (see tailwind.config.ts's status.* tokens).
 */
export function NetworkBadge() {
  const network = stellarNetwork();
  const isProduction = network === "mainnet";
  return (
    <span
      className={`status-badge border-status-testnet text-status-testnet ${
        isProduction ? "border-status-success text-status-success" : ""
      }`}
      title={isProduction ? "Connected to Stellar's public production network" : "Not production — no real funds are at risk"}
    >
      <span aria-hidden="true">●</span>
      {networkLabel()}
    </span>
  );
}
