"use client";

import { useState } from "react";
import { connectFreighter, isFreighterInstalled } from "@agrifeed/sdk/wallet";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";

export function WalletConnect({ onConnect }: { onConnect: (publicKey: string) => void }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const installed = await isFreighterInstalled();
      if (!installed) {
        setError("Freighter extension not detected. Install it to run this demo.");
        return;
      }
      const connection = await connectFreighter();
      setPublicKey(connection.publicKey);
      onConnect(connection.publicKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "connection failed");
    } finally {
      setConnecting(false);
    }
  }

  if (publicKey) {
    return (
      <div className="ticker-row">
        <span className="text-sm text-ink-muted">Connected</span>
        <IdentifierDisplay kind="address" value={publicKey} />
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="border border-accent bg-transparent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Connect Freighter"}
      </button>
      {error && <p className="mt-2 text-sm text-status-error">{error}</p>}
    </div>
  );
}
