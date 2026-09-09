"use client";

import { useState, type FormEvent } from "react";
import { parseAmountToRaw, pricefloor } from "@agrifeed/sdk";
import { freighterSignAndSend } from "@agrifeed/sdk/wallet";
import { networkPassphrase, pricefloorContractId, rpcUrl } from "@/lib/stellar";
import { NewDealFlow } from "@/components/NewDealFlow";

type Step = "new-deal" | "fund" | "settle" | "cancel";

const STEPS: { id: Step; label: string }[] = [
  { id: "new-deal", label: "1. New deal" },
  { id: "fund", label: "2. Fund" },
  { id: "settle", label: "3. Settle" },
  { id: "cancel", label: "Cancel" },
];

function useAction() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setPending(true);
    setResult(null);
    setError(null);
    try {
      await fn();
      setResult("Transaction confirmed on-chain.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "transaction failed");
    } finally {
      setPending(false);
    }
  }

  return { pending, result, error, run };
}

function ActionFeedback({ pending, result, error }: { pending: boolean; result: string | null; error: string | null }) {
  if (pending) return <p className="mt-3 text-sm text-ink-muted">Waiting for Freighter and confirmation…</p>;
  if (result) return <p className="mt-3 font-mono text-sm text-price-up">{result}</p>;
  if (error) return <p className="mt-3 text-sm text-price-down">{error}</p>;
  return null;
}

function field(label: string, children: React.ReactNode) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "border border-border bg-void px-3 py-2 font-mono text-sm text-ink-primary outline-none focus:border-accent";

export function DemoFlow({ publicKey }: { publicKey: string }) {
  const [step, setStep] = useState<Step>("new-deal");
  // Starts at the legacy/demo fallback instance if one is configured, so
  // fund/settle/cancel keep working against it exactly as before; a deal
  // confirmed via NewDealFlow below replaces it with the freshly deployed
  // instance for the rest of this session.
  const [activeContractId, setActiveContractId] = useState<string | null>(pricefloorContractId() ?? null);

  const config = activeContractId
    ? { contractId: activeContractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() }
    : null;
  const signAndSend = freighterSignAndSend(networkPassphrase());

  return (
    <div>
      <div className="flex gap-2">
        {STEPS.map((s) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`border px-3 py-1.5 text-sm transition-colors ${
              step === s.id
                ? "border-accent text-accent"
                : "border-border text-ink-muted hover:text-ink-primary"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-6 card p-6">
        {step === "new-deal" && (
          <NewDealFlow
            onDealConfirmed={(contractId) => {
              setActiveContractId(contractId);
              setStep("fund");
            }}
          />
        )}
        {step === "fund" &&
          (config ? (
            <FundForm publicKey={publicKey} config={config} signAndSend={signAndSend} />
          ) : (
            <NoActiveDeal />
          ))}
        {step === "settle" &&
          (config ? (
            <SettleForm publicKey={publicKey} config={config} signAndSend={signAndSend} />
          ) : (
            <NoActiveDeal />
          ))}
        {step === "cancel" &&
          (config ? (
            <CancelForm publicKey={publicKey} config={config} signAndSend={signAndSend} />
          ) : (
            <NoActiveDeal />
          ))}
      </div>
    </div>
  );
}

function NoActiveDeal() {
  return (
    <div>
      <p className="font-mono text-sm text-ink-muted">source unavailable</p>
      <p className="mt-2 text-sm text-ink-muted">
        No active AgriPriceFloor instance yet. Either complete &quot;1. New deal&quot; above, or
        set NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID to an already-initialized instance.
      </p>
    </div>
  );
}

interface StepProps {
  publicKey: string;
  config: { contractId: string; rpcUrl: string; networkPassphrase: string };
  signAndSend: ReturnType<typeof freighterSignAndSend>;
}

function FundForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, run } = useAction();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const decimals = Number(data.get("decimals") ?? 7);
    void run(() =>
      pricefloor.fund(config, publicKey, BigInt(parseAmountToRaw(String(data.get("amount")), decimals)), signAndSend),
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {field("Buyer (connected wallet)", <input value={publicKey} disabled className={inputClass} />)}
      {field("Amount", <input name="amount" placeholder="1000.00" required className={inputClass} />)}
      {field(
        "Settlement token decimals",
        <input name="decimals" type="number" defaultValue={7} className={inputClass} />,
      )}
      <p className="text-sm text-ink-muted sm:col-span-2">Native XLM (this demo&apos;s settlement token) uses 7 decimals.</p>
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Fund"}
        </button>
        <ActionFeedback pending={pending} result={result} error={error} />
      </div>
    </form>
  );
}

function SettleForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, run } = useAction();
  return (
    <div>
      <p className="text-sm text-ink-muted">
        Settles the contract against the oracle&apos;s current lastprice() for the configured
        commodity, paying out to farmer or buyer depending on whether price is below or above
        the floor.
      </p>
      <button
        onClick={() => void run(() => pricefloor.settle(config, publicKey, signAndSend))}
        disabled={pending}
        className="mt-4 border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Settle"}
      </button>
      <ActionFeedback pending={pending} result={result} error={error} />
    </div>
  );
}

function CancelForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, run } = useAction();
  return (
    <div>
      <p className="text-sm text-ink-muted">
        Cancels the contract once it has stalled (see the contract&apos;s grace-period rules).
        Requires the connected wallet to be the stored farmer or buyer.
      </p>
      <button
        onClick={() => void run(() => pricefloor.cancel(config, publicKey, signAndSend))}
        disabled={pending}
        className="mt-4 border border-border px-4 py-2 text-sm text-ink-muted transition-colors hover:border-price-down hover:text-price-down disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Cancel"}
      </button>
      <ActionFeedback pending={pending} result={result} error={error} />
    </div>
  );
}
