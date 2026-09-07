export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
        <span>AgriFeed is an open-source oracle. Every price shown here is read live from Soroban.</span>
        <a
          href="https://github.com/AgriFeed/agrifeed-app"
          className="font-mono transition-colors hover:text-ink-primary"
        >
          github.com/AgriFeed/agrifeed-app
        </a>
      </div>
    </footer>
  );
}
