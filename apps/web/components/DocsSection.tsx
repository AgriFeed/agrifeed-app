"use client";

import { useState } from "react";

/**
 * One documentation section (Phase 3 Step 8 — Developers & Docs). `id` is
 * the anchor target `DocsNav` links to, so every section that should be
 * reachable from the sidebar must set one. `eyebrow` is a short kicker
 * label above the heading (e.g. a step number in the integration guide);
 * most sections omit it.
 */
export function DocsSection({
  id,
  title,
  eyebrow,
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-14 scroll-mt-20 first:mt-0">
      {eyebrow && <p className="font-mono text-xs uppercase tracking-wide text-ink-muted">{eyebrow}</p>}
      <h2 className="font-display text-2xl text-ink-primary">{title}</h2>
      <div className="mt-3 flex flex-col gap-4 text-sm leading-relaxed text-ink-muted [&_strong]:text-ink-primary">
        {children}
      </div>
    </section>
  );
}

/** A labeled subsection within a `DocsSection`, for grouping (e.g. one
 * function, one endpoint, one contract method) without a full h2. */
export function DocsSubsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 border-l border-border pl-4">
      <h3 className="font-mono text-sm text-ink-primary">{title}</h3>
      <div className="mt-2 flex flex-col gap-3 text-sm leading-relaxed text-ink-muted [&_strong]:text-ink-primary">
        {children}
      </div>
    </div>
  );
}

/**
 * A code/command/JSON block with a copy affordance, matching the copy
 * pattern established by `IdentifierDisplay`. `overflow-x-auto` on the
 * `<pre>` itself keeps a long line (a contract ID, a long URL) scrolling
 * within the block rather than widening the page (Phase 3 Step 19).
 */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, non-secure context); the
      // text is still fully visible and selectable in the block itself.
    }
  }

  return (
    <div className="card relative">
      {label && (
        <div className="border-b border-border px-4 py-1.5 font-mono text-[11px] text-ink-muted">{label}</div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink-primary">
        <code>{children}</code>
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-3 top-3 border border-border bg-void px-2 py-0.5 font-mono text-[11px] text-ink-muted transition-colors hover:text-accent"
        aria-label="Copy code block"
      >
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}

/** A response/parameter table, horizontally scrollable within its own
 * container so a wide table never widens the page (Phase 3 Step 19). */
export function DocsTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            {headers.map((h) => (
              <th key={h} className="py-2 pr-4 font-mono text-xs uppercase tracking-wide text-ink-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/60">
              {row.map((cell, j) => (
                <td key={j} className="py-2 pr-4 align-top text-ink-primary">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
