import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { SiteNavLinks } from "@/components/SiteNavLinks";

/**
 * Global application shell header (Phase 3 Step 3). Server-rendered except
 * for `SiteNavLinks` (Phase 3 Step 9's current-page indicator, which needs
 * `usePathname()`): the network indicator (Step 4) is always present and
 * never collapsed behind a menu, and nav links wrap onto a second line on
 * narrow viewports rather than hiding behind a hamburger — nothing here
 * disappears on mobile. Wallet connection is deliberately NOT rendered
 * globally here: per the Phase 3 spec, it's contextual to the screens that
 * actually need it (Price Protection), so Markets/Reporting Network/Docs
 * stay fully browsable with no wallet involved at all.
 */
export function SiteNav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/" className="font-display text-2xl tracking-tight text-ink-primary">
            AgriFeed
          </Link>
          <SiteNavLinks />
        </div>
        <NetworkBadge />
      </div>
    </header>
  );
}
