"use client";

import { useEffect, useReducer, useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { deploy, formatPrice, multiparty, oracle, parseAmountToRaw, pricefloor } from "@agrifeed/sdk";
import type { PendingAuthEntry } from "@agrifeed/sdk";
import { connectFreighter, freighterSignAndSend, getConnectedAddress, signAuthEntryAsExpectedParty } from "@agrifeed/sdk/wallet";
import { networkPassphrase, oracleContractId, pricefloorContractId, pricefloorWasmHash, rpcUrl } from "@/lib/stellar";
import { withCapturedTxHash } from "@/lib/txHash";
import { registerPriceFloorInstance } from "@/lib/api";
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
import { DealStateBadge } from "@/components/DealStateBadge";
import { DealFieldRow } from "@/components/DealFieldRow";
import { DealPersistenceNotice } from "@/components/DealPersistenceNotice";
import { ParticipantAuthStatus, type ParticipantAuthState } from "@/components/ParticipantAuthStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";

const inputClass =
  "border border-border bg-void px-3 py-2 font-mono text-sm text-ink-primary outline-none focus:border-accent";

function field(label: string, children: React.ReactNode, hint?: string) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
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

/**
 * A real, honest two-party AgriPriceFloor deal creation: deploy a fresh
 * instance, collect the farmer's and the buyer's own independent Soroban
 * authorization, then submit. Built entirely on @agrifeed/sdk's
 * multiparty.ts primitives, never a single signature standing in for both
 * parties.
 *
 * SAME-SESSION LIMITATION: both participants must complete their signing
 * step in this same browser tab, one after another, switching which
 * account is active in Freighter between steps — see the SameSessionNotice
 * this component renders. There is no persistence or link-sharing here;
 * closing this tab or reloading loses an in-progress deal before it
 * reaches "confirmed". Multi-session handoff (farmer signs today, buyer
 * signs tomorrow, from their own device) is a real future capability this
 * step does not build — see the project's Phase 3 Step 2 specification.
 */
export function NewDealFlow({ onDealConfirmed }: { onDealConfirmed: (contractId: string) => void }) {
  const [state, dispatch] = useReducer(dealReducer, initialDealState);
  const { commodities, loading: commoditiesLoading, error: commoditiesError } = useCommodities();
  const { decimals: oracleDecimals, error: decimalsError } = useOracleDecimals();
  const [registration, setRegistration] = useState<RegistrationStatus>("idle");
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "confirmed" && state.contractId) {
      onDealConfirmed(state.contractId);
    }
    // Only re-run when the deal actually reaches confirmed with a
    // contract id, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.contractId]);

  // Registration (Phase 4) lives here, in the parent, not in InstanceChoice
  // (where the deploy button itself lives): InstanceChoice unmounts the
  // moment `state.status` moves past "draft", which happens immediately
  // on a successful deploy, before this async call has any chance to
  // resolve — confirmed live, the status note was simply never rendered
  // when it lived there. Guarded by `state.contractId` alone (not status),
  // so it fires exactly once per newly deployed contract id and keeps
  // running, and its result stays visible, across every later step.
  useEffect(() => {
    if (!state.contractId || state.status === "draft") return;
    let cancelled = false;
    setRegistration("pending");
    setRegistrationError(null);
    registerPriceFloorInstance(state.contractId)
      .then(() => {
        if (!cancelled) setRegistration("registered");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRegistration("failed");
        setRegistrationError(err instanceof Error ? err.message : "registration failed");
      });
    return () => {
      cancelled = true;
    };
    // Only re-run for a genuinely new contract id, not on every status
    // change within the same deal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.contractId]);

  const showSigning = state.status === "waiting_for_farmer" || state.status === "waiting_for_buyer" || state.status === "ready_to_submit";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <DealStateBadge status={state.status} />
        {state.contractId && (
          <span className="font-mono text-xs text-ink-muted">
            instance <IdentifierDisplay kind="contract" value={state.contractId} />
          </span>
        )}
        {registration === "pending" && <StatusBadge tone="pending">registering for discovery…</StatusBadge>}
        {registration === "registered" && <StatusBadge tone="success">registered for discovery</StatusBadge>}
        {registration === "failed" && <StatusBadge tone="warning">not registered for discovery</StatusBadge>}
      </div>

      {registration === "failed" && (
        <p className="text-xs text-ink-muted">
          {registrationError}. The deal itself is real and on-chain regardless, this only means it will
          not be automatically discoverable later, save the contract ID above if you need it again.
        </p>
      )}

      {state.contractId && state.status !== "confirmed" && (
        <DealPersistenceNotice contractId={state.contractId} />
      )}

      {state.status === "draft" && !state.draft && (
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
        <>
          <DealSummary draft={state.draft} decimals={oracleDecimals ?? 7} onEdit={() => dispatch({ type: "RESET" })} />
          <InstanceChoice state={state} dispatch={dispatch} />
        </>
      )}

      {state.status === "deployment_pending" && (
        <div className="card p-4">
          <p className="text-sm text-ink-muted">Deploying a new AgriPriceFloor instance for this deal…</p>
        </div>
      )}

      {state.status === "deployed" && state.draft && (
        <>
          <DealSummary draft={state.draft} decimals={oracleDecimals ?? 7} />
          <PrepareStep state={state} dispatch={dispatch} />
        </>
      )}

      {showSigning && state.draft && state.prepared && (
        <SigningPanel state={state} dispatch={dispatch} />
      )}

      {state.status === "submitted" && (
        <div className="card p-4">
          <p className="text-sm text-ink-muted">
            Both authorizations are collected. Waiting for the network to confirm the transaction…
          </p>
        </div>
      )}

      {state.status === "confirmed" && (
        <div className="card border-status-success p-4">
          <StatusBadge tone="success">confirmed on-chain</StatusBadge>
          <div className="mt-2 text-sm text-ink-primary">
            This deal is initialized on instance{" "}
            {state.contractId && <IdentifierDisplay kind="contract" value={state.contractId} />}.
          </div>
          {state.txHash && (
            <div className="mt-1 text-sm text-ink-muted">
              <IdentifierDisplay kind="tx" value={state.txHash} />
            </div>
          )}
          <p className="mt-3 text-xs text-ink-muted">
            Use the Fund/Settle/Cancel tabs above against this instance. Save the contract ID —
            this is the only place it is currently shown.
          </p>
        </div>
      )}

      {state.status === "failed" && (
        <div className="card border-status-error p-4">
          <StatusBadge tone="error">failed</StatusBadge>
          <p className="mt-2 text-sm text-ink-primary">{state.error}</p>
          {state.failedFrom && <p className="mt-1 text-xs text-ink-muted">Failed while: {state.failedFrom}</p>}
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

function validateDraft(data: FormData, decimals: number): { value: pricefloor.InitializePriceFloorParams } | { error: string } {
  const farmer = String(data.get("farmer") ?? "").trim();
  const buyer = String(data.get("buyer") ?? "").trim();
  const settlementToken = String(data.get("settlementToken") ?? "").trim();
  const oracleId = String(data.get("oracle") ?? "").trim();
  const commodity = String(data.get("commodity") ?? "").trim();
  const maturityInput = String(data.get("maturity") ?? "");

  if (!StrKey.isValidEd25519PublicKey(farmer)) return { error: "Farmer address is not a valid Stellar account address." };
  if (!StrKey.isValidEd25519PublicKey(buyer)) return { error: "Buyer address is not a valid Stellar account address." };
  if (farmer === buyer) return { error: "Farmer and buyer must be two distinct accounts." };
  if (!commodity) return { error: "Choose a commodity tracked by the oracle." };
  if (!StrKey.isValidContract(settlementToken)) return { error: "Settlement token must be a valid Soroban contract address." };
  if (!StrKey.isValidContract(oracleId)) return { error: "Oracle must be a valid Soroban contract address." };

  const maturityMs = new Date(maturityInput).getTime();
  if (!maturityInput || Number.isNaN(maturityMs)) return { error: "Choose a valid maturity date and time." };
  if (maturityMs <= Date.now()) return { error: "Maturity must be in the future." };

  let floorPrice: bigint;
  let notional: bigint;
  try {
    floorPrice = BigInt(parseAmountToRaw(String(data.get("floorPrice") ?? ""), decimals));
  } catch {
    return { error: "Floor price must be a plain decimal number, e.g. 6188.00." };
  }
  try {
    notional = BigInt(parseAmountToRaw(String(data.get("notional") ?? ""), decimals));
  } catch {
    return { error: "Notional must be a plain decimal number, e.g. 1000.00." };
  }
  if (floorPrice <= 0n) return { error: "Floor price must be positive." };
  if (notional <= 0n) return { error: "Notional must be positive." };

  return {
    value: {
      farmer,
      buyer,
      commodity: { tag: "Other", values: [commodity] },
      floorPrice,
      notional,
      settlementToken,
      maturityTs: BigInt(Math.floor(maturityMs / 1000)),
      oracle: oracleId,
    },
  };
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
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const decimals = Number(data.get("decimals") ?? oracleDecimals ?? 7);
    const result = validateDraft(data, decimals);
    if ("error" in result) {
      setFormError(result.error);
      return;
    }
    setFormError(null);
    dispatch({ type: "SET_DRAFT", draft: result.value });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-ink-muted">
        A price protection agreement is between two distinct accounts — a farmer and a buyer.
        Enter both addresses explicitly; they are never assumed to be whichever wallet happens to
        be connected.
      </p>
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          "Only commodities the configured AgriFeedOracle currently tracks.",
        )}
        {commoditiesError && (
          <p className="text-sm text-status-error sm:col-span-2">Could not load commodities from the oracle: {commoditiesError}</p>
        )}
        {field(
          "Oracle decimals",
          <input key={oracleDecimals ?? "loading"} name="decimals" type="number" defaultValue={oracleDecimals ?? 7} className={inputClass} />,
        )}
        {decimalsError && (
          <p className="text-sm text-status-error sm:col-span-2">Could not load decimals from the oracle, defaulting to 7: {decimalsError}</p>
        )}
        {field("Floor price", <input name="floorPrice" placeholder="6188.00" required className={inputClass} />)}
        {field("Notional", <input name="notional" placeholder="1000.00" required className={inputClass} />)}
        {field(
          "Settlement token contract",
          <input name="settlementToken" placeholder="C..." required className={inputClass} />,
          "Fixed at initialization — this cannot be changed or independently re-read from the contract afterward, so confirm it now.",
        )}
        {field("Maturity", <input name="maturity" type="datetime-local" required className={inputClass} />)}
        {field(
          "Oracle contract",
          <input name="oracle" defaultValue={oracleContractId() ?? ""} required className={inputClass} />,
          "The AgriFeedOracle this deal will settle against.",
        )}
        {formError && <p className="text-sm text-status-error sm:col-span-2">{formError}</p>}
        <div className="sm:col-span-2">
          <button
            type="submit"
            className="border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void"
          >
            Review deal terms
          </button>
        </div>
      </form>
    </div>
  );
}

function DealSummary({
  draft,
  decimals,
  onEdit,
}: {
  draft: pricefloor.InitializePriceFloorParams;
  decimals: number;
  onEdit?: () => void;
}) {
  const symbol = draft.commodity.values[0] ?? "";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink-primary">Deal summary — verify before signing</p>
        {onEdit && (
          <button onClick={onEdit} className="text-xs text-ink-muted transition-colors hover:text-ink-primary">
            edit terms
          </button>
        )}
      </div>
      <div className="mt-2">
        <DealFieldRow label="Farmer">
          <IdentifierDisplay kind="address" value={draft.farmer} />
        </DealFieldRow>
        <DealFieldRow label="Buyer">
          <IdentifierDisplay kind="address" value={draft.buyer} />
        </DealFieldRow>
        <DealFieldRow label="Commodity">
          <span className="font-mono">{symbol}</span>
        </DealFieldRow>
        <DealFieldRow label="Floor price">
          <span className="font-mono">{formatPrice(draft.floorPrice, decimals).formatted}</span>
        </DealFieldRow>
        <DealFieldRow label="Notional">
          <span className="font-mono">{formatPrice(draft.notional, decimals).formatted}</span>
        </DealFieldRow>
        <DealFieldRow label="Maturity">
          <span className="font-mono">{new Date(Number(draft.maturityTs) * 1000).toUTCString()}</span>
        </DealFieldRow>
        <DealFieldRow label="Settlement token">
          <IdentifierDisplay kind="contract" value={draft.settlementToken} />
        </DealFieldRow>
        <DealFieldRow label="Oracle">
          <IdentifierDisplay kind="contract" value={draft.oracle} />
        </DealFieldRow>
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Settlement will be evaluated against this oracle&apos;s price for {symbol || "the chosen commodity"} at
        maturity. The settlement token above cannot be changed after initialization.
      </p>
    </div>
  );
}

type RegistrationStatus = "idle" | "pending" | "registered" | "failed";

function InstanceChoice({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployTxHash, setDeployTxHash] = useState<string | null>(null);
  const wasmHash = pricefloorWasmHash();
  const existingId = pricefloorContractId();

  async function handleDeploy() {
    if (!canDeploy(state) || !wasmHash) return;
    setPending(true);
    setError(null);
    try {
      const connection = await connectFreighter();
      dispatch({ type: "DEPLOY_START" });
      const signAndSend = withCapturedTxHash(freighterSignAndSend(networkPassphrase()), setDeployTxHash, networkPassphrase());
      const contractId = await deploy.deployInstance(
        { wasmHash, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() },
        connection.publicKey,
        signAndSend,
      );
      // Registration for discovery (Phase 4) is handled by NewDealFlow's
      // own effect on state.contractId, not here: this component unmounts
      // the moment state.status moves past "draft" (which DEPLOY_SUCCESS
      // triggers immediately below), before an async call started here
      // could ever resolve or have its result seen -- confirmed live, see
      // NewDealFlow's own comment on that effect.
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
      <div>
        <p className="text-sm font-medium text-ink-primary">Deploy a contract for this deal</p>
        <p className="mt-1 text-sm text-ink-muted">
          AgriPriceFloor is one contract instance per deal. Deploying creates a brand new instance
          for these exact terms — this is a real on-chain transaction, distinct from the
          initialization step that follows it.
        </p>
      </div>

      {!wasmHash ? (
        <div className="border border-status-warning p-3">
          <StatusBadge tone="warning">deployment unavailable</StatusBadge>
          <p className="mt-2 text-xs text-ink-muted">
            NEXT_PUBLIC_PRICEFLOOR_WASM_HASH is not configured in this environment, so a new
            instance cannot be deployed right now. This is a configuration gap, not a hidden or
            secret value.
          </p>
        </div>
      ) : (
        <button
          onClick={() => void handleDeploy()}
          disabled={pending}
          className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
        >
          {pending ? "Deploying…" : "Deploy new instance"}
        </button>
      )}

      {deployTxHash && (
        <div className="text-xs text-ink-muted">
          <IdentifierDisplay kind="tx" value={deployTxHash} />
        </div>
      )}

      <div className="border-t border-border pt-3">
        <p className="text-xs text-ink-muted">
          For a quick fund/settle/cancel walkthrough against an already-initialized instance
          instead of creating a new deal, use the configured legacy fallback instance. This skips
          the two-party initialize flow entirely and is not the deal you just described above.
        </p>
        <button
          onClick={handleUseExisting}
          disabled={!existingId}
          className="mt-2 border border-border px-4 py-2 text-sm text-ink-muted transition-colors hover:text-ink-primary disabled:opacity-50"
        >
          Use legacy configured instance
        </button>
        {!existingId && (
          <p className="mt-1 font-mono text-xs text-ink-muted">
            source unavailable: NEXT_PUBLIC_PRICEFLOOR_CONTRACT_ID is not set.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-status-error">{error}</p>}
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
      // A party who is also this transaction's source account has their
      // requirement satisfied implicitly by the envelope signature at
      // submit time (see multiparty.ts) — there is nothing for them to
      // separately decide or sign, so that is recorded immediately here
      // rather than asking for a pointless confirmation click.
      for (const address of [state.draft.farmer, state.draft.buyer]) {
        const hasPendingEntry = prepared.pendingAuthEntries.some((e) => e.address === address);
        if (!hasPendingEntry) {
          dispatch({ type: "PARTY_SIGNED", entry: { address, entryXdr: "" } });
        }
      }
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
      <div>
        <p className="text-sm font-medium text-ink-primary">Prepare the agreement</p>
        <p className="mt-1 text-sm text-ink-muted">
          Connect the wallet that will pay this transaction&apos;s network fee (the &quot;source
          account&quot; — any funded Testnet account; it does not have to be the farmer or the
          buyer) to find out exactly which signatures the agreement still needs.
        </p>
      </div>
      <button
        onClick={() => void handlePrepare()}
        disabled={pending}
        className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Preparing…" : "Connect and prepare"}
      </button>
      {error && <p className="text-sm text-status-error">{error}</p>}
    </div>
  );
}

/**
 * A passive `getAddress()` check can come back empty after switching the
 * active account in Freighter, if that account has never itself been
 * granted access to this origin (each account's permission grant is
 * independent). When that happens, falling back to an active
 * `connectFreighter()` (which issues a real `requestAccess()`) is the only
 * way to recover — a purely passive re-check would otherwise loop forever
 * reporting "not connected" with no way out.
 */
function useConnectedAddress(): [string | null, () => void] {
  const [address, setAddress] = useState<string | null>(null);
  async function recheck() {
    const passive = await getConnectedAddress();
    if (passive) {
      setAddress(passive);
      return;
    }
    try {
      const active = await connectFreighter();
      setAddress(active.publicKey);
    } catch {
      setAddress(null);
    }
  }
  useEffect(() => {
    void recheck();
  }, []);
  return [address, () => void recheck()];
}

/**
 * Shows BOTH participants at once (Phase 3 Step 8) — never collapses the
 * two independent authorization steps into a single "Sign transaction"
 * control, and never gates one party's turn on the other's: the reducer
 * (see dealState.ts's nextSigningStatus) already allows either to sign in
 * either order, so the UI reflects that instead of inventing a stricter
 * sequence.
 */
function SigningPanel({ state, dispatch }: { state: DealState; dispatch: React.Dispatch<DealAction> }) {
  const [connectedAddress, recheckConnected] = useConnectedAddress();
  const [signingRole, setSigningRole] = useState<"farmer" | "buyer" | null>(null);
  const [rejectedRole, setRejectedRole] = useState<"farmer" | "buyer" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!state.draft || !state.prepared) return null;
  const draft = state.draft;
  const prepared = state.prepared;

  async function handleSign(role: "farmer" | "buyer") {
    const expectedAddress = role === "farmer" ? draft.farmer : draft.buyer;
    const pendingEntry = prepared.pendingAuthEntries.find((e) => e.address === expectedAddress);
    if (!pendingEntry) return;
    setSigningRole(role);
    setRejectedRole(null);
    setError(null);
    try {
      await connectFreighter();
      recheckConnected();
      const signed: PendingAuthEntry = await signAuthEntryAsExpectedParty(pendingEntry, role, networkPassphrase());
      dispatch({ type: "PARTY_SIGNED", entry: signed });
    } catch (err) {
      const message = err instanceof Error ? err.message : `${role} signing failed`;
      setRejectedRole(role);
      setError(message);
    } finally {
      setSigningRole(null);
      recheckConnected();
    }
  }

  function stateFor(role: "farmer" | "buyer"): ParticipantAuthState {
    const expectedAddress = role === "farmer" ? draft.farmer : draft.buyer;
    if (state.signedEntries[expectedAddress]) return "signed";
    if (signingRole === role) return "signing";
    if (rejectedRole === role) return "rejected";
    if (!connectedAddress) return "disconnected";
    if (connectedAddress !== expectedAddress) return "wrong-wallet";
    return "ready-to-sign";
  }

  const farmerState = stateFor("farmer");
  const buyerState = stateFor("buyer");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-ink-primary">Two-party authorization</p>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Both the farmer and the buyer must independently authorize this exact agreement. Switch
          the connected Freighter account to each party in turn, in either order, and sign from
          that account.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ParticipantCard
          role="farmer"
          expectedAddress={draft.farmer}
          connectedAddress={connectedAddress}
          authState={farmerState}
          onSign={() => void handleSign("farmer")}
          onRecheck={recheckConnected}
        />
        <ParticipantCard
          role="buyer"
          expectedAddress={draft.buyer}
          connectedAddress={connectedAddress}
          authState={buyerState}
          onSign={() => void handleSign("buyer")}
          onRecheck={recheckConnected}
        />
      </div>

      {error && <p className="text-sm text-status-error">{error}</p>}

      {state.status === "ready_to_submit" && <SubmitStep state={state} dispatch={dispatch} />}
    </div>
  );
}

function ParticipantCard({
  role,
  expectedAddress,
  connectedAddress,
  authState,
  onSign,
  onRecheck,
}: {
  role: "farmer" | "buyer";
  expectedAddress: string;
  connectedAddress: string | null;
  authState: ParticipantAuthState;
  onSign: () => void;
  onRecheck: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ParticipantAuthStatus role={role} expectedAddress={expectedAddress} connectedAddress={connectedAddress} state={authState} />
      {(authState === "ready-to-sign" || authState === "signing") && (
        <button
          onClick={onSign}
          disabled={authState === "signing"}
          className="self-start border border-accent px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
        >
          {authState === "signing" ? "Waiting for Freighter…" : `Sign as ${role}`}
        </button>
      )}
      {authState === "rejected" && (
        <button
          onClick={onSign}
          className="self-start border border-border px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-primary"
        >
          Try again
        </button>
      )}
      {(authState === "wrong-wallet" || authState === "disconnected") && (
        <button
          onClick={onRecheck}
          className="self-start border border-border px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink-primary"
        >
          Recheck connected wallet
        </button>
      )}
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
      let txHash: string | undefined;
      const signAndSend = withCapturedTxHash(freighterSignAndSend(networkPassphrase()), (h) => (txHash = h), networkPassphrase());
      await multiparty.submitMultiPartyInvocation(
        { contractId: state.contractId, rpcUrl: rpcUrl(), networkPassphrase: networkPassphrase() },
        state.prepared.transactionXdr,
        signedEntryXdrs,
        state.prepared.sourceAccountAuthEntryXdrs,
        signAndSend,
      );
      dispatch({ type: "SUBMIT_SUCCESS", txHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : "submission failed";
      dispatch({ type: "SUBMIT_FAILURE", error: message });
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3 border-status-info p-4">
      <div>
        <StatusBadge tone="info">both parties signed — ready to submit</StatusBadge>
        <p className="mt-2 text-sm text-ink-muted">
          Both required authorizations are collected, but nothing has been submitted to the
          network yet. Connect the source account (the one that prepared this transaction) to
          sign the outer transaction envelope and submit.
        </p>
      </div>
      <button
        onClick={() => void handleSubmit()}
        disabled={pending}
        className="self-start border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent hover:text-void disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Connect and submit"}
      </button>
      {error && <p className="text-sm text-status-error">{error}</p>}
    </div>
  );
}
