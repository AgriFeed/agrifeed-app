const SECTIONS = [
  { href: "#introduction", label: "Introduction" },
  { href: "#oracle", label: "Oracle" },
  { href: "#pricefloor", label: "PriceFloor" },
  { href: "#rest-api", label: "REST API" },
  { href: "#sdk", label: "SDK" },
  { href: "#contract-reference", label: "Contract reference" },
  { href: "#integration-guide", label: "Integration guide" },
  { href: "#wallet-signing", label: "Wallet & signing" },
  { href: "#my-deals", label: "My Deals & recovery" },
  { href: "#testing", label: "Testing" },
  { href: "#testnet-deployment", label: "Testnet deployment" },
  { href: "#architecture", label: "Architecture" },
  { href: "#methodology", label: "Methodology" },
  { href: "#contributing", label: "Contributing" },
];

/**
 * Section navigation for `/docs` (Phase 3 Step 8). Plain anchor links, no
 * client JS, so it works with keyboard/screen reader navigation and even
 * with JS disabled — matching `SiteNav`'s own "nothing hides behind a
 * hamburger" approach. On narrow viewports it wraps into a horizontal list
 * above the content instead of collapsing into a menu (Phase 3 Step 19); on
 * wide viewports it becomes a sticky left column.
 */
export function DocsNav() {
  return (
    <nav aria-label="Documentation sections" className="lg:sticky lg:top-6 lg:self-start">
      <p className="font-mono text-xs uppercase tracking-wide text-ink-muted">On this page</p>
      <ul className="mt-2 flex flex-row flex-wrap gap-x-4 gap-y-1 text-sm lg:flex-col lg:gap-y-1.5">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <a href={s.href} className="text-ink-muted transition-colors hover:text-accent">
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
