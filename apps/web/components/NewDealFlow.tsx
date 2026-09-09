"use client";

import { useEffect, useReducer, useState, type FormEvent } from "react";
import { deploy, multiparty, oracle, parseAmountToRaw, pricefloor } from "@agrifeed/sdk";
import type { PendingAuthEntry } from "@agrifeed/sdk";
import { connectFreighter, freighterSignAndSend, signAuthEntryAsExpectedParty } from "@agrifeed/sdk/wallet";
import { networkPassphrase, oracleContractId, pricefloorContractId, pricefloorWasmHash, rpcUrl } from "@/lib/stellar";
import { truncateAddress } from "@/lib/address";
import {
  canDeploy,
  canPrepareInitialize,
  canSubmitInitialize,
  canUseExistingContract,
  dealReducer,
  initialDealState,
  type DealAction,
  type DealState,
} from "@/lib/dealState";

const inputClass =
  "border border-border bg-void px-3 py-2 font-mono text-sm text-ink-primary outline-none focus:border-accent";

function field(label: string, children: React.ReactNode) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function useOracleDecimals() {
  const [decimals, setDecimals] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const contractId = oracleContractId();
    if (!contractId) {
      setError("NEXT_PUBLIC_ORACLE_CONTRACT_ID is not set");
      return;
    }
    let cancelled = false;
    oracle
      .decimals({ contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() })
      .then((d) => {
        if (!cancelled) setDecimals(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to load the oracle's decimals");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { decimals, error };
}

function useCommodities() {
  const [commodities, setCommodities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const contractId = oracleContractId();
    if (!contractId) {
      setLoading(false);
      setError("NEXT_PUBLIC_ORACLE_CONTRACT_ID is not set");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    oracle
      .assets({ contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() })
      .then((assets) => {
        if (cancelled) return;
        setCommodities(assets.filter((a) => a.tag === "Other").map((a) => a.values[0]));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load commodities from the oracle");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { commodities, loading, error };
}

function StatusPill({ label, tone }: { label: string; tone: "muted" | "accent" | "good" | "bad" }) {
  const color =
    tone === "good"
      ? "text-price-up border-price-up"
      : tone === "bad"
        ? "text-price-down border-price-down"
        : tone === "accent"
          ? "text-accent border-accent"
          : "text-ink-muted border-border";
  return <span className={`border px-2 py-0.5 font-mono text-xs ${color}`}>{label}</span>;
}

/**
 * Walks through a real, honest two-party AgriPriceFloor deal creation:
 * deploy a fresh instance, collect the farmer's and the buyer's own
 * independent Soroban authorization, then submit. Built entirely on
 * @agrifeed/sdk's multiparty.ts primitives, never a single signature
 * standing in for both parties.
 *
 * DEVELOPMENT/PROTOTYPE BOUNDARY: both participants must complete their
 * step in this same browser session/tab, one after another, switching
 * which account is active in Freighter between steps. There is no
 * persistence or link-sharing here, closing this tab or reloading loses
 * an in-progress deal before it reaches "confirmed". A production flow
 * would hand the buyer's pending authorization to them out of band
 * (a link, a backend relay); that hand-off is intentionally out of scope
 * for this step, see the project's Phase 2 Step 4 report.
 */
export function NewDealFlow({ onDealConfirmed }: { onDealConfirmed: (contractId: string) => void }) {
  const [state, dispatch] = useReducer(dealReducer, initialDealState);
  const { commodities, loading: commoditiesLoading, error: commoditiesError } = useCommodities();
  const { decimals: oracleDecimals, error: decimalsError } = useOracleDecimals();

  useEffect(() => {
    if (state.status === "confirmed" && state.contractId) {
      onDealConfirmed(state.contractId);
    }
    // Only re-run when the deal actually reaches confirmed with a
    // contract id, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.contractId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-muted">Status:</span>
        <StatusPill label={state.status} tone={statusTone(state.status)} />
        {state.contractId && (
          <span className="font-mono text-ink-muted">instance {truncateAddress(state.contractId)}</span>
        )}
      </div>

      <p className="border border-border bg-card p-3 text-xs text-ink-muted">
        Prototype boundary: both the farmer and the buyer must complete their step below in this
        same browser tab, switching the active account in Freighter between steps. Reloading or
        closing this tab loses an in-progress deal before it reaches &quot;confirmed&quot;.
      </p>

      {state.status === "draft" && (
        <DraftForm
          dispatch={dispatch}
          commodities={commodities}
          commoditiesLoading={commoditiesLoading}
          commoditiesError={commoditiesError}
          oracleDecimals={oracleDecimals}
          decimalsError={decimalsError}
        />
      )}

      {state.status === "draft" && state.draft && (
        <InstanceChoice state={state} dispatch={dispatch} />
      )}

      {state.status === "deployment_pending" && (
        <p className="text-sm text-ink-muted">Deploying a new AgriPriceFloor instance…</p>
      )}

      {state.status === "deployed" && <PrepareStep state={state} dispatch={dispatch} />}

      {(state.status === "waiting_for_farmer" || state.status === "waiting_for_buyer") && (
        <SigningStep state={state} dispatch={dispatch} />
      )}

      {state.status === "ready_to_submit" && <SubmitStep state={state} dispatch={dispatch} />}

      {state.status === "submitted" && <p className="text-sm text-ink-muted">Submitting and waiting for confirmation…</p>}

      {state.status === "confirmed" && (
        <div className="border border-price-up p-3">
          <p className="text-sm text-price-up">
            Deal confirmed on instance <span className="font-mono">{state.contractId}</span>.
          </p>
          {state.txHash && <p className="mt-1 font-mono text-xs text-ink-muted">tx {state.txHash}</p>}
          <p className="mt-2 text-xs text-ink-muted">
            Use the Fund/Settle/Cancel tabs above against this instance.
          </p>
        </div>
      )}

      {state.status === "failed" && (
        <div className="border border-price-down p-3">
          <p className="text-sm text-price-down">{state.error}</p>
          {state.failedFrom && (
            <p className="mt-1 text-xs text-ink-muted">Failed while: {state.failedFrom}</p>
          )}
          <button
            onClick={() => dispatch({ type: "RESET" })}
            className="mt-3 border border-border px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-primary"
          >
            Start over
          </button>
        </div>
      )}
    </div>
  );
}

function statusTone(status: DealState["status"]): "muted" | "accent" | "good" | "bad" {
  if (status === "confirmed") return "good";
  if (status === "failed") return "bad";
  if (status === "draft") return "muted";
  return "accent";
}

interface DraftFormProps {
  dispatch: React.Dispatch<{ type: "SET_DRAFT"; draft: pricefloor.InitializePriceFloorParams }>;
  commodities: string[];
  commoditiesLoading: boolean;
  commoditiesError: string | null;
  oracleDecimals: number | null;
  decimalsError: string | null;
}

function DraftForm({ dispatch, commodities, commoditiesLoading, commoditiesError, oracleDecimals, decimalsError }: DraftFormProps) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const commodity = String(data.get("commodity") ?? "COCOA");
    const decimals = Number(data.get("decimals") ?? oracleDecimals ?? 7);
    const farmer = String(data.get("farmer") ?? "").trim();
    const buyer = String(data.get("buyer") ?? "").trim();

    dispatch({
      type: "SET_DRAFT",
      draft: {
        farmer,
        buyer,
        commodity: { tag: "Other", values: [commodity] },
        floorPrice: BigInt(parseAmountToRaw(String(data.get("floorPrice")), decimals)),
        notional: BigInt(parseAmountToRaw(String(data.get("notional")), decimals)),
        settlementToken: String(data.get("settlementToken")),
        maturityTs: BigInt(Math.floor(new Date(String(data.get("maturity"))).getTime() / 1000)),
        oracle: String(data.get("oracle")),
      },
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {/* No defaultValue tying these to the connected wallet: farmer and
          buyer must be typed in explicitly, never silently assumed to be
          whoever happens to be connected right now. */}
      {field("Farmer address", <input name="farmer" placeholder="G..." required className={inputClass} />)}
      {field("Buyer address", <input name="buyer" placeholder="G..." required className={inputClass} />)}
      {field(
        "Commodity",
        <select name="commodity" className={inputClass} required disabled={commoditiesLoading || commodities.length === 0}>
          {commoditiesLoading && <option value="">Loading from oracle…</option>}
          {!commoditiesLoading && commodities.length === 0 && (
            <option value="">No commodities tracked by the oracle yet</option>
          )}
          {commodities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>,
      )}
      {commoditiesError && (
        <p className="text-sm text-price-down sm:col-span-2">Could not load commodities from the oracle: {commoditiesError}</p>
      )}
      {field(
        "Oracle decimals",
        <input key={oracleDecimals ?? "loading"} name="decimals" type="number" defaultValue={oracleDecimals ?? 7} className={inputClass} />,
      )}
      {decimalsError && (
        <p className="text-sm text-price-down sm:col-span-2">Could not load decimals from the oracle, defaulting to 7: {decimalsError}</p>
      )}
      {field("Floor price", <input name="floorPrice" placeholder="6188.00" required className={inputClass} />)}
      {field("Notional", <input name="notional" placeholder="1000.00" required className={inputClass} />)}
      {field("Settlement token contract", <input name="settlementToken" placeholder="C..." required className={inputClass} />)}
      {field("Maturity", <input name="maturity" type="datetime-local" required className={inputClass} />)}
      {field("Oracle contract", <input name="oracle" defaultValue={oracleContractId() ?? ""} required className={inputClass} />)}
      <div className="sm:col-span-2">
        <button
          type="submit"
          className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void"
        >
          Set deal terms
        </button>
      </div>
    </form>
  );
}

function InstanceChoice({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasmHash = pricefloorWasmHash();
  const existingId = pricefloorContractId();

  async function handleDeploy() {
    if (!canDeploy(state) || !wasmHash) return;
    setPending(true);
    setError(null);
    try {
      const connection = await connectFreighter();
      dispatch({ type: "DEPLOY_START" });
      const contractId = await deploy.deployInstance(
        { wasmHash, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() },
        connection.publicKey,
        freighterSignAndSend(networkPassphrase()),
      );
      dispatch({ type: "DEPLOY_SUCCESS", contractId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "deployment failed";
      dispatch({ type: "DEPLOY_FAILURE", error: message });
      setError(message);
    } finally {
      setPending(false);
    }
  }

  function handleUseExisting() {
    if (!canUseExistingContract(state) || !existingId) return;
    dispatch({ type: "USE_EXISTING_CONTRACT", contractId: existingId });
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="text-sm text-ink-muted">
        AgriPriceFloor is one instance per deal. Deploy a fresh instance for these terms, or, for
        a quick fund/settle/cancel walkthrough against an already-initialized instance, use the
        configured fallback below (this skips the two-party initialize flow entirely).
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => void handleDeploy()}
          disabled={pending || !wasmHash}
          className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
        >
          {pending ? "Deploying…" : "Deploy new instance"}
        </button>
        <button
          onClick={handleUseExisting}
          disabled={!existingId}
          className="border border-border px-4 py-2 text-sm text-ink-muted transition-colors hover:text-ink-primary disabled:opacity-50"
        >
          Use existing configured instance
        </button>
      </div>
      {!wasmHash && (
        <p className="font-mono text-xs text-ink-muted">
          source unavailable: NEXT_PUBLIC_PRICEFLOOR_WASM_HASH is not set, deploying a new instance
          is disabled.
        </p>
      )}
      {!existingId && (
        <p className="font-mono text-xs text-ink-muted">
          source unavailable: NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID is not set, no existing instance to
          fall back to.
        </p>
      )}
      {error && <p className="text-sm text-price-down">{error}</p>}
    </div>
  );
}

function PrepareStep({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePrepare() {
    if (!canPrepareInitialize(state) || !state.draft || !state.contractId) return;
    setPending(true);
    setError(null);
    try {
      const connection = await connectFreighter();
      const prepared = await multiparty.prepareMultiPartyInvocation(
        { contractId: state.contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() },
        "initialize",
        pricefloor.initializeArgs(state.draft),
        connection.publicKey,
      );
      dispatch({ type: "PREPARE_SUCCESS", prepared });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to prepare the transaction";
      dispatch({ type: "PREPARE_FAILURE", error: message });
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="text-sm text-ink-muted">
        Connect the wallet that will pay this transaction&apos;s fee (the &quot;source
        account&quot;, any funded testnet account, it does not have to be the farmer or the
        buyer) and simulate the initialize call to find out which signatures it actually needs.
      </p>
      <button
        onClick={() => void handlePrepare()}
        disabled={pending}
        className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Preparing…" : "Connect and prepare"}
      </button>
      {error && <p className="text-sm text-price-down">{error}</p>}
    </div>
  );
}

function SigningStep({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state.draft || !state.prepared) return null;

  const role = state.status === "waiting_for_farmer" ? "farmer" : "buyer";
  const expectedAddress = role === "farmer" ? state.draft.farmer : state.draft.buyer;
  const pendingEntry = state.prepared.pendingAuthEntries.find((e) => e.address === expectedAddress);

  if (!pendingEntry) {
    // This party's requirement is satisfied implicitly by the transaction
    // source account's own envelope signature (see multiparty.ts), so
    // there is nothing separate for them to sign here. Record a
    // placeholder so the reducer's bookkeeping still advances.
    return (
      <div className="card p-4">
        <p className="text-sm text-ink-muted">
          The {role} ({truncateAddress(expectedAddress)}) is this transaction&apos;s source
          account, their authorization is already covered by the envelope signature at submit
          time, no separate signature is needed here.
        </p>
        <button
          onClick={() => dispatch({ type: "PARTY_SIGNED", entry: { address: expectedAddress, entryXdr: "" } })}
          className="mt-3 border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void"
        >
          Continue
        </button>
      </div>
    );
  }

  async function handleSign() {
    if (!pendingEntry) return;
    setPending(true);
    setError(null);
    try {
      await connectFreighter();
      const signed: PendingAuthEntry = await signAuthEntryAsExpectedParty(pendingEntry, role, networkPassphrase());
      dispatch({ type: "PARTY_SIGNED", entry: signed });
    } catch (err) {
      const message = err instanceof Error ? err.message : `${role} signing failed`;
      dispatch({ type: "SIGN_FAILURE", error: message });
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="text-sm text-ink-muted">
        Waiting for the <strong className="text-ink-primary">{role}</strong>, expected wallet{" "}
        <span className="font-mono">{truncateAddress(expectedAddress)}</span>. Switch Freighter to
        that account, then connect and sign.
      </p>
      <button
        onClick={() => void handleSign()}
        disabled={pending}
        className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Waiting for Freighter…" : `Connect and sign as ${role}`}
      </button>
      {error && <p className="text-sm text-price-down">{error}</p>}
    </div>
  );
}

function SubmitStep({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!canSubmitInitialize(state) || !state.prepared || !state.contractId) return;
    setPending(true);
    setError(null);
    dispatch({ type: "SUBMIT_START" });
    try {
      // Connecting here (even though the returned address isn't used
      // directly) ensures Freighter has prompted for the source account
      // before signAndSend is invoked below.
      await connectFreighter();
      const signedEntryXdrs = state.prepared.pendingAuthEntries.map(
        (e) => state.signedEntries[e.address]?.entryXdr ?? "",
      );
      await multiparty.submitMultiPartyInvocation(
        { contractId: state.contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() },
        state.prepared.transactionXdr,
        signedEntryXdrs,
        state.prepared.sourceAccountAuthEntryXdrs,
        freighterSignAndSend(networkPassphrase()),
      );
      dispatch({ type: "SUBMIT_SUCCESS" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "submission failed";
      dispatch({ type: "SUBMIT_FAILURE", error: message });
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="text-sm text-ink-muted">
        Both required authorizations are collected. Connect the source account (the one that
        prepared this transaction) to sign the envelope and submit.
      </p>
      <button
        onClick={() => void handleSubmit()}
        disabled={pending}
        className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Connect and submit"}
      </button>
      {error && <p className="text-sm text-price-down">{error}</p>}
    </div>
  );
}
