import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";

// Matches the Phase 3 Step 2 information architecture: Markets, Price
// Protection, Reporting Network, Developers, Docs. Developers and Docs
// remain one route (/docs) for now — splitting them into two real
// destinations is deferred to the Developers/Docs redesign step, since
// creating a second nav entry with no distinct content yet would be its
// own kind of overclaiming.
const LINKS = [
  { href: "/", label: "Markets" },
  { href: "/demo", label: "Price Protection" },
  { href: "/nodes", label: "Reporting Network" },
  { href: "/docs", label: "Developers & Docs" },
];

/**
 * Global application shell header (Phase 3 Step 3). Server-rendered, no
 * client JS: the network indicator (Step 4) is always present and never
 * collapsed behind a menu, and nav links wrap onto a second line on narrow
 * viewports rather than hiding behind a hamburger — nothing here disappears
 * on mobile. Wallet connection is deliberately NOT rendered globally here:
 * per the Phase 3 spec, it's contextual to the screens that actually need
 * it (Price Protection), so Markets/Reporting Network/Docs stay fully
 * browsable with no wallet involved at all.
 */
export function SiteNav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/" className="font-display text-2xl tracking-tight text-ink-primary">
            AgriFeed
          </Link>
          <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-ink-muted transition-colors hover:text-ink-primary"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <NetworkBadge />
      </div>
    </header>
  );
}
