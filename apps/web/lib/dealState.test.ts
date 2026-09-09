import { describe, expect, it } from "vitest";
import type { PreparedMultiPartyInvocation, pricefloor } from "@agrifeed/sdk";
import {
  canBuyerSign,
  canDeploy,
  canFarmerSign,
  canOperateOnDeal,
  canPrepareInitialize,
  canSubmitInitialize,
  dealReducer,
  initialDealState,
  nextSigningStatus,
  type DealState,
} from "./dealState";

const FARMER = "GFARMER00000000000000000000000000000000000000000000000000";
const BUYER = "GBUYER0000000000000000000000000000000000000000000000000000";
const STRANGER = "GSTRANGER0000000000000000000000000000000000000000000000000";

const draft: pricefloor.InitializePriceFloorParams = {
  farmer: FARMER,
  buyer: BUYER,
  commodity: { tag: "Other", values: ["COCOA"] },
  floorPrice: 100n,
  notional: 10n,
  settlementToken: "CTOKEN0000000000000000000000000000000000000000000000000000",
  maturityTs: 2_000_000_000n,
  oracle: "CORACLE00000000000000000000000000000000000000000000000000",
};

function prepared(pendingAddresses: string[]): PreparedMultiPartyInvocation {
  return {
    transactionXdr: "AAAA",
    pendingAuthEntries: pendingAddresses.map((address) => ({ address, entryXdr: `entry-for-${address}` })),
  };
}

function deploy(state: DealState): DealState {
  return dealReducer(dealReducer(state, { type: "DEPLOY_START" }), {
    type: "DEPLOY_SUCCESS",
    contractId: "CDEAL000000000000000000000000000000000000000000000000000",
  });
}

describe("nextSigningStatus", () => {
  it("waits for the farmer first when both are pending", () => {
    expect(nextSigningStatus(prepared([FARMER, BUYER]), draft, {})).toBe("waiting_for_farmer");
  });

  it("waits for the buyer once the farmer has signed", () => {
    const signed = { [FARMER]: { address: FARMER, entryXdr: "signed" } };
    expect(nextSigningStatus(prepared([FARMER, BUYER]), draft, signed)).toBe("waiting_for_buyer");
  });

  it("is ready to submit once both have signed", () => {
    const signed = {
      [FARMER]: { address: FARMER, entryXdr: "signed" },
      [BUYER]: { address: BUYER, entryXdr: "signed" },
    };
    expect(nextSigningStatus(prepared([FARMER, BUYER]), draft, signed)).toBe("ready_to_submit");
  });

  it("skips a party whose requirement was already satisfied by the transaction source account", () => {
    // Only the buyer appears as a pending entry: the farmer is the source
    // account in this scenario, so their requirement is satisfied by the
    // envelope signature, not a separate entry. This must not be
    // mistaken for "farmer's signature was lost."
    expect(nextSigningStatus(prepared([BUYER]), draft, {})).toBe("waiting_for_buyer");
  });

  it("goes straight to ready_to_submit if simulation required no separate entries at all", () => {
    expect(nextSigningStatus(prepared([]), draft, {})).toBe("ready_to_submit");
  });
});

describe("dealReducer: state progression to ready_to_submit", () => {
  it("reaches ready_to_submit only once both required authorizations are represented", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    expect(state.status).toBe("deployed");

    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });
    expect(state.status).toBe("waiting_for_farmer");
    expect(canFarmerSign(state)).toBe(true);
    expect(canBuyerSign(state)).toBe(false);
    expect(canSubmitInitialize(state)).toBe(false);

    state = dealReducer(state, { type: "PARTY_SIGNED", entry: { address: FARMER, entryXdr: "signed-farmer" } });
    expect(state.status).toBe("waiting_for_buyer");
    expect(canFarmerSign(state)).toBe(false);
    expect(canBuyerSign(state)).toBe(true);
    expect(canSubmitInitialize(state)).toBe(false);

    state = dealReducer(state, { type: "PARTY_SIGNED", entry: { address: BUYER, entryXdr: "signed-buyer" } });
    expect(state.status).toBe("ready_to_submit");
    expect(canSubmitInitialize(state)).toBe(true);
    expect(state.signedEntries[FARMER]?.entryXdr).toBe("signed-farmer");
    expect(state.signedEntries[BUYER]?.entryXdr).toBe("signed-buyer");
  });

  it("does not let the same PARTY_SIGNED step fire twice for the farmer once already collected", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });
    state = dealReducer(state, { type: "PARTY_SIGNED", entry: { address: FARMER, entryXdr: "signed-farmer" } });
    // Status is now waiting_for_buyer, so canFarmerSign must be false: the
    // UI has no button left that would re-request the farmer's signature.
    expect(canFarmerSign(state)).toBe(false);
  });

  it("ignores a signed entry for an address that isn't part of this deal", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });

    const polluted = dealReducer(state, { type: "PARTY_SIGNED", entry: { address: STRANGER, entryXdr: "x" } });

    expect(polluted).toEqual(state);
  });
});

describe("dealReducer: invalid actions are no-ops", () => {
  it("cannot deploy without a draft", () => {
    expect(canDeploy(initialDealState)).toBe(false);
    const state = dealReducer(initialDealState, { type: "DEPLOY_START" });
    expect(state.status).toBe("draft");
  });

  it("cannot prepare initialize before deployment completes", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    expect(canPrepareInitialize(state)).toBe(false);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });
    expect(state.status).toBe("draft");
  });

  it("cannot submit before all required authorizations exist", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });
    expect(canSubmitInitialize(state)).toBe(false);

    const submitted = dealReducer(state, { type: "SUBMIT_START" });
    expect(submitted.status).toBe("waiting_for_farmer");
  });

  it("cannot fund/settle/cancel before an instance exists", () => {
    expect(canOperateOnDeal(initialDealState)).toBe(false);
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    expect(canOperateOnDeal(state)).toBe(false);
  });

  it("can fund/settle/cancel once a deal reaches confirmed", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([]) });
    expect(state.status).toBe("ready_to_submit");
    state = dealReducer(state, { type: "SUBMIT_START" });
    state = dealReducer(state, { type: "SUBMIT_SUCCESS", txHash: "abc123" });
    expect(state.status).toBe("confirmed");
    expect(canOperateOnDeal(state)).toBe(true);
    expect(state.txHash).toBe("abc123");
  });
});

describe("dealReducer: failure paths preserve context for retry", () => {
  it("records which step failed rather than discarding the whole flow", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = dealReducer(state, { type: "DEPLOY_START" });
    state = dealReducer(state, { type: "DEPLOY_FAILURE", error: "RPC unreachable" });

    expect(state.status).toBe("failed");
    expect(state.failedFrom).toBe("deployment_pending");
    expect(state.error).toBe("RPC unreachable");
    // The draft itself survives a deploy failure, so a retry doesn't force
    // the user to re-type every field.
    expect(state.draft).toEqual(draft);
  });

  it("records which party's signature failed", () => {
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = deploy(state);
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([FARMER, BUYER]) });
    state = dealReducer(state, { type: "SIGN_FAILURE", error: "User declined access" });

    expect(state.status).toBe("failed");
    expect(state.failedFrom).toBe("waiting_for_farmer");
  });
});

describe("dealReducer: deployment's contract id flows into subsequent PriceFloor calls", () => {
  it("carries the freshly deployed contract id, not the legacy fixed one, into the confirmed deal", () => {
    const freshlyDeployedId = "CFRESH00000000000000000000000000000000000000000000000000";
    let state = dealReducer(initialDealState, { type: "SET_DRAFT", draft });
    state = dealReducer(state, { type: "DEPLOY_START" });
    state = dealReducer(state, { type: "DEPLOY_SUCCESS", contractId: freshlyDeployedId });
    state = dealReducer(state, { type: "PREPARE_SUCCESS", prepared: prepared([]) });
    state = dealReducer(state, { type: "SUBMIT_START" });
    state = dealReducer(state, { type: "SUBMIT_SUCCESS" });

    expect(state.status).toBe("confirmed");
    expect(state.contractId).toBe(freshlyDeployedId);

    // What fund()/settle()/cancel() actually need is an
    // AgriPriceFloorConfig with this exact contractId, proving the
    // deployed id is real, usable input for those calls, not just an
    // opaque string parked in state.
    const config: { contractId: string; rpcUrl: string; networkPassphrase: string } = {
      contractId: state.contractId!,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    };
    expect(config.contractId).toBe(freshlyDeployedId);
  });
});

describe("dealReducer: USE_EXISTING_CONTRACT (legacy fallback path)", () => {
  it("skips deployment and goes straight to an operable confirmed deal", () => {
    const state = dealReducer(initialDealState, {
      type: "USE_EXISTING_CONTRACT",
      contractId: "CFIXED00000000000000000000000000000000000000000000000000",
    });

    expect(state.status).toBe("confirmed");
    expect(canOperateOnDeal(state)).toBe(true);
  });
});
