"use client";

import { useState } from "react";
import { WalletConnect } from "@/components/WalletConnect";
import { DemoFlow } from "@/components/DemoFlow";

export default function PriceProtectionPage() {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-ink-primary">Price Protection</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        A minimum-price agreement between a farmer and a buyer, settled against the
        AgriFeedOracle on Stellar Testnet. This is the real AgriPriceFloor contract — every action
        below submits an actual signed transaction, not a simulated or mocked step.
      </p>

      <ol className="mt-6 flex flex-col gap-1.5 border-l border-border pl-4 text-sm text-ink-muted">
        <li>1. Farmer and buyer agree on a minimum protected price for a commodity.</li>
        <li>2. A new AgriPriceFloor contract instance is deployed for this specific deal.</li>
        <li>3. Both parties independently authorize the agreement&apos;s terms.</li>
        <li>4. The buyer funds the agreement.</li>
        <li>5. At maturity, settlement (or, under the contract&apos;s rules, cancellation) follows.</li>
      </ol>

      <p className="mt-6 max-w-2xl text-sm text-ink-muted">
        This does not eliminate counterparty risk or guarantee an outcome for either party — it
        replaces a brokerage relationship with a contract both parties can independently verify.
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
