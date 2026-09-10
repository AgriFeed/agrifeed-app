"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Matches the Phase 3 Step 2 information architecture: Markets, Price
// Protection, Reporting Network, Developers, Docs. Developers and Docs
// remain one route (/docs) for now — splitting them into two real
// destinations is deferred, since creating a second nav entry with no
// distinct content yet would be its own kind of overclaiming.
const LINKS = [
  { href: "/", label: "Markets" },
  { href: "/demo", label: "Price Protection" },
  { href: "/nodes", label: "Reporting Network" },
  { href: "/docs", label: "Developers & Docs" },
];

/**
 * The primary nav link list, split out from `SiteNav` (Phase 3 Step 9)
 * purely to mark which page is current: `aria-current="page"` plus a
 * visible underline, never color alone. This is the only client-rendered
 * piece of the site header; `usePathname()` needs it, everything else in
 * `SiteNav` stays server-rendered.
 */
export function SiteNavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {LINKS.map((link) => {
        const current = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={`border-b text-sm transition-colors ${
              current
                ? "border-accent text-ink-primary"
                : "border-transparent text-ink-muted hover:text-ink-primary"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
