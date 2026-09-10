"use client";

import { useState, type FormEvent } from "react";
import { parseAmountToRaw, pricefloor } from "@agrifeed/sdk";
import { freighterSignAndSend } from "@agrifeed/sdk/wallet";
import { networkPassphrase, pricefloorContractId, rpcUrl } from "@/lib/stellar";
import { withCapturedTxHash } from "@/lib/txHash";
import { NewDealFlow } from "@/components/NewDealFlow";
import { StatusBadge } from "@/components/StatusBadge";
import { FundedBadge } from "@/components/DealStateBadge";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";

type Step = "new-deal" | "fund" | "settle-cancel";

const STEPS: { id: Step; label: string }[] = [
  { id: "new-deal", label: "1. Create deal" },
  { id: "fund", label: "2. Fund" },
  { id: "settle-cancel", label: "3. Settle or cancel" },
];

function useAction() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function run(fn: (onHash: (h: string) => void) => Promise<void>) {
    setPending(true);
    setResult(null);
    setError(null);
    setTxHash(null);
    try {
      await fn(setTxHash);
      setResult("Transaction confirmed on-chain.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "transaction failed");
    } finally {
      setPending(false);
    }
  }

  return { pending, result, error, txHash, run };
}

function ActionFeedback({
  pending,
  result,
  error,
  txHash,
}: {
  pending: boolean;
  result: string | null;
  error: string | null;
  txHash: string | null;
}) {
  if (pending) return <p className="mt-3 text-sm text-ink-muted">Waiting for Freighter and confirmation…</p>;
  if (result) {
    return (
      <div className="mt-3">
        <StatusBadge tone="success">{result}</StatusBadge>
        {txHash && (
          <div className="mt-1 text-xs text-ink-muted">
            <IdentifierDisplay kind="tx" value={txHash} />
          </div>
        )}
      </div>
    );
  }
  if (error) return <p className="mt-3 text-sm text-status-error">{error}</p>;
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
  const [funded, setFunded] = useState(false);
  const isLegacyInstance = activeContractId !== null && activeContractId === pricefloorContractId();

  const config = activeContractId
    ? { contractId: activeContractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() }
    : null;
  const signAndSend = freighterSignAndSend(networkPassphrase());

  return (
    <div>
      <div className="flex flex-wrap gap-2">
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

      {activeContractId && (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-ink-muted">Active instance:</span>
          <IdentifierDisplay kind="contract" value={activeContractId} />
          {isLegacyInstance ? (
            <StatusBadge tone="neutral">legacy configured instance, not a deal you created</StatusBadge>
          ) : (
            <StatusBadge tone="info">deal instance created this session</StatusBadge>
          )}
          <FundedBadge funded={funded} />
        </div>
      )}

      <div className="mt-6 card p-6">
        {step === "new-deal" && (
          <NewDealFlow
            onDealConfirmed={(contractId) => {
              setActiveContractId(contractId);
              setFunded(false);
              setStep("fund");
            }}
          />
        )}
        {step === "fund" &&
          (config ? (
            <FundForm publicKey={publicKey} config={config} signAndSend={signAndSend} onFunded={() => setFunded(true)} />
          ) : (
            <NoActiveDeal />
          ))}
        {step === "settle-cancel" &&
          (config ? (
            <div className="flex flex-col gap-8">
              <SettleForm publicKey={publicKey} config={config} signAndSend={signAndSend} />
              <div className="border-t border-border pt-8">
                <CancelForm publicKey={publicKey} config={config} signAndSend={signAndSend} />
              </div>
            </div>
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
      <StatusBadge tone="neutral">no active deal</StatusBadge>
      <p className="mt-2 text-sm text-ink-muted">
        No AgriPriceFloor instance is active yet. Either complete &quot;1. Create deal&quot;
        above, or set NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID to an already-initialized instance.
      </p>
    </div>
  );
}

interface StepProps {
  publicKey: string;
  config: { contractId: string; rpcUrl: string; networkPassphrase: string };
  signAndSend: ReturnType<typeof freighterSignAndSend>;
}

function FundForm({ publicKey, config, signAndSend, onFunded }: StepProps & { onFunded: () => void }) {
  const { pending, result, error, txHash, run } = useAction();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const decimals = Number(data.get("decimals") ?? 7);
    void run(async (onHash) => {
      const amount = BigInt(parseAmountToRaw(String(data.get("amount")), decimals));
      await pricefloor.fund(config, publicKey, amount, withCapturedTxHash(signAndSend, onHash, config.networkPassphrase));
      onFunded();
    });
  }

  return (
    <div>
      <p className="text-sm text-ink-muted">
        The buyer deposits collateral into the contract. This is a separate, later step from
        initialization — a deal being initialized does not fund it.
      </p>
      <form onSubmit={onSubmit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {field(
          "Buyer (connected wallet)",
          <span className="flex items-center">
            <IdentifierDisplay kind="address" value={publicKey} />
          </span>,
        )}
        {field("Amount", <input name="amount" placeholder="1000.00" required className={inputClass} />)}
        {field(
          "Settlement token decimals",
          <input name="decimals" type="number" defaultValue={7} className={inputClass} />,
        )}
        <p className="text-sm text-ink-muted sm:col-span-2">
          Native XLM (this deal&apos;s settlement token in the demo path) uses 7 decimals.
        </p>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
          >
            {pending ? "Submitting…" : "Fund as buyer"}
          </button>
          <ActionFeedback pending={pending} result={result} error={error} txHash={txHash} />
        </div>
      </form>
    </div>
  );
}

function LiveExecutionDisclosure() {
  return (
    <p className="border border-status-warning p-3 text-xs text-ink-muted">
      <span className="text-status-warning">Not yet demonstrated:</span> this action has real
      SDK/contract support and passing tests, but has not yet been executed live on Testnet in
      this environment. If the contract&apos;s current state doesn&apos;t allow it (for example,
      before maturity, or before the required grace period has elapsed), the transaction will
      fail with the contract&apos;s own error rather than something being broken.
    </p>
  );
}

function SettleForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, txHash, run } = useAction();
  return (
    <div>
      <h3 className="text-sm font-medium text-ink-primary">Settle</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Anyone may call settle once the agreement has matured and the oracle has a finalized
        price for the configured commodity. It pays the buyer&apos;s collateral out: to the
        farmer, topped up to the floor price if the market price is below it; otherwise the
        difference is refunded to the buyer.
      </p>
      <div className="mt-3">
        <LiveExecutionDisclosure />
      </div>
      <button
        onClick={() =>
          void run((onHash) => pricefloor.settle(config, publicKey, withCapturedTxHash(signAndSend, onHash, config.networkPassphrase)))
        }
        disabled={pending}
        className="mt-4 border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Settle"}
      </button>
      <ActionFeedback pending={pending} result={result} error={error} txHash={txHash} />
    </div>
  );
}

function CancelForm({ publicKey, config, signAndSend }: StepProps) {
  const { pending, result, error, txHash, run } = useAction();
  return (
    <div>
      <h3 className="text-sm font-medium text-ink-primary">Cancel</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Only the stored farmer or buyer may cancel, and only once the contract&apos;s grace-period
        rules allow it (an unfunded agreement past maturity, or a funded one whose settlement
        attempt has failed and stayed failed past a further grace period).
      </p>
      <div className="mt-3">
        <LiveExecutionDisclosure />
      </div>
      <button
        onClick={() =>
          void run((onHash) => pricefloor.cancel(config, publicKey, withCapturedTxHash(signAndSend, onHash, config.networkPassphrase)))
        }
        disabled={pending}
        className="mt-4 border border-border px-4 py-2 text-sm text-ink-muted transition-colors hover:border-status-error hover:text-status-error disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Cancel"}
      </button>
      <ActionFeedback pending={pending} result={result} error={error} txHash={txHash} />
    </div>
  );
}
