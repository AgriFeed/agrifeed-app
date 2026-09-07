"use client";

import { useState } from "react";
import { WalletConnect } from "@/components/WalletConnect";
import { DemoFlow } from "@/components/DemoFlow";

export default function DemoPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink-primary">AgriPriceFloor demo</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Connect a Freighter wallet on testnet and walk through a real AgriPriceFloor contract:
        initialize, fund, and settle. Every action below submits an actual signed transaction,
        there is no simulated or mocked step.
      </p>

      <div className="mt-8">
        <WalletConnect onConnect={setPublicKey} />
      </div>

      {publicKey && (
        <div className="mt-8">
          <DemoFlow publicKey={publicKey} />
        </div>
      )}
    </main>
  );
}
