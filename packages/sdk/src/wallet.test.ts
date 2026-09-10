import { describe, expect, it, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  requestAccess: vi.fn(),
  signAuthEntry: vi.fn(),
  signTransaction: vi.fn(),
  signMessage: vi.fn(),
  isConnected: vi.fn(),
  getAddress: vi.fn(),
}));

import { requestAccess, signAuthEntry, signTransaction } from "@stellar/freighter-api";
import { connectFreighter, freighterSignAndSend, signAuthEntryWithFreighter } from "./wallet.js";

const FREIGHTER_ERROR = { code: -4, message: "The user rejected this request." };

describe("connectFreighter error messages", () => {
  it("surfaces Freighter's real error message, not the stringified error object", async () => {
    vi.mocked(requestAccess).mockResolvedValue({ address: "", error: FREIGHTER_ERROR });
    await expect(connectFreighter()).rejects.toThrow(
      "Freighter access denied: The user rejected this request.",
    );
  });
});

describe("freighterSignAndSend error messages", () => {
  it("surfaces Freighter's real error message, not the stringified error object", async () => {
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: "",
      signerAddress: "",
      error: FREIGHTER_ERROR,
    });
    const signAndSend = freighterSignAndSend("Test SDF Network ; September 2015");
    await expect(signAndSend("AAAA")).rejects.toThrow(
      "Freighter signing failed: The user rejected this request.",
    );
  });
});

describe("signAuthEntryWithFreighter error messages", () => {
  const pending = { address: "GAH3EHJXOKFM6O55X2TD6NBJKEXIXALQ3YCGCJIH7XLAIXSIC3XICXFY", entryXdr: "AAAA" };

  it("surfaces Freighter's real error message when signing fails, not [object Object]", async () => {
    vi.mocked(signAuthEntry).mockResolvedValue({
      signedAuthEntry: null,
      signerAddress: "",
      error: FREIGHTER_ERROR,
    });
    await expect(signAuthEntryWithFreighter(pending, "Test SDF Network ; September 2015")).rejects.toThrow(
      `Freighter auth entry signing failed for ${pending.address}: The user rejected this request.`,
    );
  });

  it("falls back to a readable message when Freighter returns no entry and no error", async () => {
    vi.mocked(signAuthEntry).mockResolvedValue({ signedAuthEntry: null, signerAddress: "" });
    await expect(signAuthEntryWithFreighter(pending, "Test SDF Network ; September 2015")).rejects.toThrow(
      `Freighter auth entry signing failed for ${pending.address}: no signed entry was returned`,
    );
  });
});
