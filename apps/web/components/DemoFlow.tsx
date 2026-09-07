"use client";

import { useState, type FormEvent } from "react";
import { parseAmountToRaw, pricefloor } from "@agrifeed/sdk";
import { freighterSignAndSend } from "@agrifeed/sdk/wallet";
import { networkPassphrase, pricefloorContractId, rpcUrl, oracleContractId } from "@/lib/stellar";

type Step = "initialize" | "fund" | "settle" | "cancel";

const STEPS: { id: Step; label: string }[] = [
  { id: "initialize", label: "1. Initialize" },
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
  const [step, setStep] = useState<Step>("initialize");
  const contractId = pricefloorContractId();

  if (!contractId) {
    return (
      <div className="card p-6">
        <p className="font-mono text-sm text-ink-muted">source unavailable</p>
        <p className="mt-2 text-sm text-ink-muted">
          NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID is not set, so there is no AgriPriceFloor contract
          to walk through yet. Deploy agrifeed-contract and fill in the env var to run this demo
          for real.
        </p>
      </div>
    );
  }

  const config = { contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() };
  const signAndSend = freighterSignAndSend(config.networkPassphrase);

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
        {step === "initialize" && <InitializeForm publicKey={publicKey} config={config} signAndSend={signAndSend} />}
        {step === "fund" && <FundForm publicKey={publicKey} config={config} signAndSend={signAndSend} />}
        {step === "settle" && <SettleForm publicKey={publicKey} config={config} signAndSend={signAndSend} />}
        {step === "cancel" && <CancelForm publicKey={publicKey} config={config} signAndSend={signAndSend} />}
      </div>
    </div>
  );
}

interface StepProps {
  publicKey: string;
  config: { contractId: string; rpcUrl: string; networkPassphrase: string };
  signAndSend: ReturnType<typeof freighterSignAndSend>;
}

function InitializeForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, run } = useAction();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const commodity = String(data.get("commodity") ?? "COCOA");
    const decimals = Number(data.get("decimals") ?? 2);

    void run(() =>
      pricefloor.initialize(
        config,
        {
          farmer: String(data.get("farmer")),
          buyer: String(data.get("buyer")),
          commodity: { tag: "Other", values: [commodity] },
          floorPrice: BigInt(parseAmountToRaw(String(data.get("floorPrice")), decimals)),
          notional: BigInt(parseAmountToRaw(String(data.get("notional")), decimals)),
          settlementToken: String(data.get("settlementToken")),
          maturityTs: BigInt(Math.floor(new Date(String(data.get("maturity"))).getTime() / 1000)),
          oracle: String(data.get("oracle")),
        },
        publicKey,
        signAndSend,
      ),
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {field("Farmer address", <input name="farmer" defaultValue={publicKey} required className={inputClass} />)}
      {field("Buyer address", <input name="buyer" defaultValue={publicKey} required className={inputClass} />)}
      {field(
        "Commodity",
        <select name="commodity" className={inputClass}>
          {["COCOA", "COFFEE", "WHEAT", "MAIZE", "RICE", "SOYBEAN", "SUGAR", "COTTON"].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>,
      )}
      {field("Oracle decimals", <input name="decimals" type="number" defaultValue={2} className={inputClass} />)}
      {field("Floor price", <input name="floorPrice" placeholder="6188.00" required className={inputClass} />)}
      {field("Notional", <input name="notional" placeholder="1000.00" required className={inputClass} />)}
      {field(
        "Settlement token contract",
        <input name="settlementToken" placeholder="C..." required className={inputClass} />,
      )}
      {field("Maturity", <input name="maturity" type="datetime-local" required className={inputClass} />)}
      {field(
        "Oracle contract",
        <input name="oracle" defaultValue={oracleContractId() ?? ""} required className={inputClass} />,
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Initialize"}
        </button>
        <ActionFeedback pending={pending} result={result} error={error} />
      </div>
    </form>
  );
}

function FundForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, run } = useAction();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const decimals = Number(data.get("decimals") ?? 2);
    void run(() =>
      pricefloor.fund(config, publicKey, BigInt(parseAmountToRaw(String(data.get("amount")), decimals)), signAndSend),
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {field("Buyer (connected wallet)", <input value={publicKey} disabled className={inputClass} />)}
      {field("Amount", <input name="amount" placeholder="1000.00" required className={inputClass} />)}
      {field("Settlement token decimals", <input name="decimals" type="number" defaultValue={2} className={inputClass} />)}
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
      <p className="text-sm text-ink-muted">Cancels the contract before maturity.</p>
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
