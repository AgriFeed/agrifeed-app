import Link from "next/link";

const LINKS = [
  { href: "/", label: "Ticker" },
  { href: "/nodes", label: "Nodes" },
  { href: "/demo", label: "Demo" },
  { href: "/docs", label: "Docs" },
];

export function SiteNav() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-display text-2xl tracking-tight text-ink-primary">
          AgriFeed
        </Link>
        <nav className="flex items-center gap-6">
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
    </header>
  );
}
