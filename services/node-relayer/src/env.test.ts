import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadEnv, parseSubmitIntervalSeconds, TRACKED_COMMODITIES } from "./env.js";

// A syntactically fake secret, never a real Stellar seed: 56 chars,
// starts with "S" like a real one, but is not derived from any real
// keypair. Used only to exercise loadEnv's malformed-secret error path.
const FAKE_SECRET = "S" + "A".repeat(55);
// A genuinely freshly-generated, throwaway keypair -- not a real secret
// in the sense the instructions warn against (an actual production or
// user credential): it is generated fresh in-process, funds nothing, is
// reused nowhere, and this is the exact same pattern packages/sdk's own
// tests already use (`Keypair.random()`) to exercise real Keypair code
// without a committed or reused secret.
const THROWAWAY_KEYPAIR = Keypair.random();
const REAL_SHAPED_ORACLE_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";

describe("parseSubmitIntervalSeconds", () => {
  it("defaults to 3600 when unset", () => {
    expect(parseSubmitIntervalSeconds(undefined)).toBe(3600);
  });

  it("accepts a real positive integer", () => {
    expect(parseSubmitIntervalSeconds("60")).toBe(60);
  });

  it(
    "rejects a non-numeric value rather than silently becoming NaN " +
      "(regression test: NaN previously reached setInterval unvalidated, " +
      "which fires almost immediately and repeatedly in Node.js instead " +
      "of throwing -- a real runaway-submission risk for an unattended " +
      "process, found during Phase 5 Step 7's audit)",
    () => {
      expect(() => parseSubmitIntervalSeconds("not-a-number")).toThrow(/positive number of seconds/);
      expect(() => parseSubmitIntervalSeconds("")).toThrow(/positive number of seconds/);
    },
  );

  it("rejects zero and negative values", () => {
    expect(() => parseSubmitIntervalSeconds("0")).toThrow();
    expect(() => parseSubmitIntervalSeconds("-60")).toThrow();
  });

  it("rejects non-finite values (Infinity)", () => {
    expect(() => parseSubmitIntervalSeconds("Infinity")).toThrow();
  });

  it("names the actual invalid value in the error, for a useful operator-facing diagnostic", () => {
    expect(() => parseSubmitIntervalSeconds("garbage")).toThrow(/"garbage"/);
  });
});

describe("loadEnv", () => {
  afterEach(() => {
    delete process.env.NODE_RELAYER_SECRET_KEY;
    delete process.env.ORACLE_CONTRACT_ID;
    delete process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS;
    delete process.env.SOROBAN_RPC_URL;
  });

  it("refuses to start without NODE_RELAYER_SECRET_KEY, rather than running against nothing", () => {
    delete process.env.NODE_RELAYER_SECRET_KEY;
    process.env.ORACLE_CONTRACT_ID = REAL_SHAPED_ORACLE_ID;
    expect(() => loadEnv()).toThrow(/NODE_RELAYER_SECRET_KEY is required/);
  });

  it("refuses to start without ORACLE_CONTRACT_ID", () => {
    process.env.NODE_RELAYER_SECRET_KEY = FAKE_SECRET;
    delete process.env.ORACLE_CONTRACT_ID;
    expect(() => loadEnv()).toThrow(/ORACLE_CONTRACT_ID is required/);
  });

  it("rejects a malformed secret key without ever echoing it back in the error", () => {
    process.env.NODE_RELAYER_SECRET_KEY = FAKE_SECRET;
    process.env.ORACLE_CONTRACT_ID = REAL_SHAPED_ORACLE_ID;
    let thrown: unknown;
    try {
      loadEnv();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(FAKE_SECRET);
  });

  it("propagates a malformed interval as its own clear startup failure, not masked by an unrelated error", () => {
    process.env.NODE_RELAYER_SECRET_KEY = THROWAWAY_KEYPAIR.secret();
    process.env.ORACLE_CONTRACT_ID = REAL_SHAPED_ORACLE_ID;
    process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS = "not-a-number";
    expect(() => loadEnv()).toThrow(/positive number of seconds/);
  });

  it("loads successfully end to end with real-shaped, non-secret config: correct keypair, oracle id, interval, and RPC default", () => {
    process.env.NODE_RELAYER_SECRET_KEY = THROWAWAY_KEYPAIR.secret();
    process.env.ORACLE_CONTRACT_ID = REAL_SHAPED_ORACLE_ID;
    process.env.NODE_RELAYER_SUBMIT_INTERVAL_SECONDS = "120";
    delete process.env.SOROBAN_RPC_URL;

    const env = loadEnv();

    expect(env.nodeKeypair.publicKey()).toBe(THROWAWAY_KEYPAIR.publicKey());
    expect(env.oracleContractId).toBe(REAL_SHAPED_ORACLE_ID);
    expect(env.submitIntervalSeconds).toBe(120);
    expect(env.rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });
});

describe("TRACKED_COMMODITIES", () => {
  it("lists exactly the 8 commodities this project's own docs/research claim to track", () => {
    expect(TRACKED_COMMODITIES).toEqual(["COCOA", "COFFEE", "WHEAT", "MAIZE", "RICE", "SOYBEAN", "SUGAR", "COTTON"]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(TRACKED_COMMODITIES).size).toBe(TRACKED_COMMODITIES.length);
  });
});
