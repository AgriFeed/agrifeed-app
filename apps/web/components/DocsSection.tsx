export function DocsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="font-display text-2xl text-ink-primary">{title}</h2>
      <div className="mt-3 flex flex-col gap-4 text-sm leading-relaxed text-ink-muted [&_strong]:text-ink-primary">
        {children}
      </div>
    </section>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="card overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink-primary">
      <code>{children}</code>
    </pre>
  );
}
