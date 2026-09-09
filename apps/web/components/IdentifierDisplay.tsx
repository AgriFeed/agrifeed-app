"use client";

import { useState } from "react";
import { truncateAddress } from "@/lib/address";

const KIND_LABEL = {
  address: "Address",
  contract: "Contract",
  tx: "Tx",
} as const;

export type IdentifierKind = keyof typeof KIND_LABEL;

/**
 * Shared identifier display (Phase 3 Step 8): Stellar accounts, contract
 * IDs, and transaction hashes. Every use in the app should render through
 * this component rather than an ad hoc truncateAddress() call, so the kind
 * label, truncation, full-value disclosure, and copy affordance stay
 * consistent everywhere. `kind` is required and always rendered, since an
 * address and a transaction hash look identical once truncated and must
 * never be shown without that distinction.
 *
 * Does not change any underlying value — purely presentational.
 */
export function IdentifierDisplay({ kind, value, className = "" }: { kind: IdentifierKind; value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, non-secure context); the
      // full value is still available via <details> below, so this is a
      // silent no-op rather than an error state worth surfacing.
    }
  }

  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 font-mono text-xs ${className}`}>
      <span className="text-ink-muted">{KIND_LABEL[kind]}</span>
      <details className="min-w-0">
        <summary className="inline cursor-pointer list-none text-ink-primary" title={value}>
          {truncateAddress(value)}
        </summary>
        <div className="mt-1 break-all text-ink-primary">{value}</div>
      </details>
      <button
        type="button"
        onClick={handleCopy}
        className="text-ink-muted transition-colors hover:text-accent"
        aria-label={`Copy ${KIND_LABEL[kind].toLowerCase()} ${value}`}
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}
