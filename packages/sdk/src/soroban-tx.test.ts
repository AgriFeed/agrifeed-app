import { describe, expect, it } from "vitest";
import { Account, Address, Contract, Keypair, Networks, Operation, rpc as StellarRpc, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { isTxTooLate, refreshTimeBounds, SIGNING_VALIDITY_SECONDS, submitAndConfirm } from "./soroban-tx.js";
import { OracleError, TxTooLateError } from "./types.js";

// A real, valid-checksum contract strkey (this project's own deployed
// oracle address, already public) -- only its validity as a strkey
// matters here, not which contract it actually names, same convention
// multiparty.test.ts already uses.
const CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";

/** A real (offline, unsigned) single-operation Transaction, same shape
 * every write path in this SDK builds, with a timeout computed from now
 * (the "just built, not yet stale" case). */
function buildRealTx(timeoutSeconds = 60): Transaction {
  const contract = new Contract(CONTRACT_ID);
  const source = new Account(Keypair.random().publicKey(), "0");
  const built = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call("settle"))
    .setTimeout(timeoutSeconds)
    .build();
  if (!(built instanceof Transaction)) throw new Error("expected a Transaction");
  return built;
}

/** A real Transaction whose maxTime has already elapsed -- the exact
 * "prepared minutes ago, about to be signed now" shape this step's fix
 * targets, built deterministically (an explicit past timestamp) rather
 * than by waiting for real time to pass. */
function buildStaleTx(secondsAgo = 3600): Transaction {
  const contract = new Contract(CONTRACT_ID);
  const source = new Account(Keypair.random().publicKey(), "0");
  const pastMaxTime = Math.floor(Date.now() / 1000) - secondsAgo;
  const built = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: pastMaxTime },
  })
    .addOperation(contract.call("settle"))
    .build();
  if (!(built instanceof Transaction)) throw new Error("expected a Transaction");
  return built;
}

/** A real xdr.TransactionResult decoding to the exact shape a genuine
 * tx_too_late rejection produces -- confirmed against a real captured
 * error during Phase 4 Step 4
 * (`{"fee_charged":"31213","result":"tx_too_late","ext":"v0"}`), not
 * hand-typed from documentation alone. */
function txResultWith(result: xdr.TransactionResultResult): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("31213"),
    result,
    ext: xdr.TransactionResultExt.fromXDR(new Uint8Array([0, 0, 0, 0])),
  });
}

describe("isTxTooLate", () => {
  it("recognizes a real txTooLate TransactionResult", () => {
    expect(isTxTooLate(txResultWith(xdr.TransactionResultResult.txTooLate()))).toBe(true);
  });

  it("returns false for a different real rejection reason (bad auth), never conflating the two", () => {
    expect(isTxTooLate(txResultWith(xdr.TransactionResultResult.txBadAuth()))).toBe(false);
  });

  it("returns false for a real success result, never a false positive", () => {
    expect(isTxTooLate(txResultWith(xdr.TransactionResultResult.txSuccess([])))).toBe(false);
  });

  it("returns false when there is no errorResult at all", () => {
    expect(isTxTooLate(undefined)).toBe(false);
  });
});

describe("refreshTimeBounds", () => {
  it("replaces an already-expired maxTime with a fresh one starting from now", () => {
    const stale = buildStaleTx();
    expect(Number(stale.timeBounds?.maxTime)).toBeLessThan(Math.floor(Date.now() / 1000));

    const refreshed = refreshTimeBounds(stale, 180);

    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Number(refreshed.timeBounds?.maxTime)).toBeGreaterThan(nowSeconds);
    expect(Number(refreshed.timeBounds?.maxTime)).toBeLessThanOrEqual(nowSeconds + 181);
  });

  it("defaults to SIGNING_VALIDITY_SECONDS when no explicit window is given", () => {
    expect(SIGNING_VALIDITY_SECONDS).toBeGreaterThan(60); // the original, evidenced-insufficient window
    const stale = buildStaleTx();

    const refreshed = refreshTimeBounds(stale);

    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Number(refreshed.timeBounds?.maxTime)).toBeGreaterThanOrEqual(nowSeconds + SIGNING_VALIDITY_SECONDS - 2);
  });

  it("preserves the operation unchanged -- same invoked contract, same function", () => {
    const tx = buildRealTx(60);
    const originalOp = tx.operations[0];
    if (!originalOp || originalOp.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");

    const refreshed = refreshTimeBounds(tx);

    const refreshedOp = refreshed.operations[0];
    if (!refreshedOp || refreshedOp.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");
    expect(refreshedOp.func.toXDR("base64")).toBe(originalOp.func.toXDR("base64"));
  });

  it("preserves already-signed Soroban authorization entries embedded in the operation, byte for byte", () => {
    // The exact case submitMultiPartyInvocation relies on: a transaction
    // whose invokeHostFunction operation already carries another party's
    // real, signed SorobanAuthorizationEntry. Refreshing the envelope's
    // time bounds must never touch, re-derive, or drop it.
    const contract = new Contract(CONTRACT_ID);
    const source = new Account(Keypair.random().publicKey(), "0");
    const unsigned = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(contract.call("initialize"))
      .setTimeout(60)
      .build();
    if (!(unsigned instanceof Transaction)) throw new Error("expected a Transaction");
    const unsignedOp = unsigned.operations[0];
    if (!unsignedOp || unsignedOp.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");

    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        (unsignedOp.func as { invokeContract: unknown }).invokeContract as never,
      ),
      subInvocations: [],
    });
    const signer = Keypair.random().publicKey();
    const signedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signer).toScAddress(),
          nonce: 42n,
          signatureExpirationLedger: 999_999,
          signature: xdr.ScVal.scvBytes(new Uint8Array([1, 2, 3, 4])),
        }),
      ),
      rootInvocation: invocation,
    });
    const built = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.invokeHostFunction({ func: unsignedOp.func, auth: [signedEntry] }))
      .setTimeout(60)
      .build();
    if (!(built instanceof Transaction)) throw new Error("expected a Transaction");
    const op = built.operations[0];
    if (!op || op.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");
    expect(op.auth).toHaveLength(1);

    const refreshed = refreshTimeBounds(built);

    const refreshedOp = refreshed.operations[0];
    if (!refreshedOp || refreshedOp.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");
    expect(refreshedOp.auth).toHaveLength(1);
    expect(refreshedOp.auth?.[0]?.toXDR("base64")).toBe(signedEntry.toXDR("base64"));
  });

  it("rejects a fee-bump transaction", () => {
    const inner = buildRealTx();
    const feeSource = Keypair.random().publicKey();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(feeSource, "200", inner, Networks.TESTNET);

    expect(() => refreshTimeBounds(feeBump as unknown as Transaction)).toThrow();
  });
});

describe("submitAndConfirm", () => {
  function stubServer(fns: {
    sendTransaction?: (tx: unknown) => Promise<unknown>;
    getTransaction?: (hash: string) => Promise<unknown>;
  }): StellarRpc.Server {
    return {
      sendTransaction: fns.sendTransaction ?? (async () => ({ status: "ERROR", errorResult: undefined, hash: "" })),
      getTransaction: fns.getTransaction ?? (async () => ({ status: "NOT_FOUND" })),
    } as unknown as StellarRpc.Server;
  }

  it("throws TxTooLateError, distinguishable from every other failure, when Stellar Core rejects with tx_too_late", async () => {
    const server = stubServer({
      sendTransaction: async () => ({ status: "ERROR", errorResult: txResultWith(xdr.TransactionResultResult.txTooLate()), hash: "deadbeef" }),
    });

    const err = await submitAndConfirm(server, buildRealTx(), "settle").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxTooLateError);
    expect((err as Error).message).toMatch(/fresh transaction will be prepared/);
    expect((err as Error).message).toMatch(/no funds moved/);
  });

  it("still throws a generic OracleError, never TxTooLateError, for a different real rejection reason", async () => {
    const server = stubServer({
      sendTransaction: async () => ({ status: "ERROR", errorResult: txResultWith(xdr.TransactionResultResult.txBadAuth()), hash: "deadbeef" }),
    });

    const err = await submitAndConfirm(server, buildRealTx(), "settle").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OracleError);
    expect(err).not.toBeInstanceOf(TxTooLateError);
  });

  it("does not retry submission itself: sendTransaction is called exactly once, even on tx_too_late", async () => {
    let calls = 0;
    const server = stubServer({
      sendTransaction: async () => {
        calls++;
        return { status: "ERROR", errorResult: txResultWith(xdr.TransactionResultResult.txTooLate()), hash: "x" };
      },
    });

    await submitAndConfirm(server, buildRealTx(), "settle").catch(() => undefined);

    expect(calls).toBe(1);
  });

  it("leaves the existing successful path unchanged: sends once, polls once, returns the real return value", async () => {
    const returnValue = xdr.ScVal.scvBool(true);
    let sendCalls = 0;
    let getCalls = 0;
    const server = stubServer({
      sendTransaction: async () => {
        sendCalls++;
        return { status: "PENDING", hash: "abc123" };
      },
      getTransaction: async () => {
        getCalls++;
        return { status: StellarRpc.Api.GetTransactionStatus.SUCCESS, returnValue };
      },
    });

    const result = await submitAndConfirm(server, buildRealTx(), "settle");

    expect(result).toBe(returnValue);
    expect(sendCalls).toBe(1);
    expect(getCalls).toBe(1);
  });

  it("still classifies a real on-chain execution failure (not tx_too_late) as a distinct OracleError", async () => {
    const server = stubServer({
      sendTransaction: async () => ({ status: "PENDING", hash: "abc123" }),
      getTransaction: async () => ({ status: StellarRpc.Api.GetTransactionStatus.FAILED }),
    });

    const err = await submitAndConfirm(server, buildRealTx(), "settle").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OracleError);
    expect(err).not.toBeInstanceOf(TxTooLateError);
    expect((err as Error).message).toContain("failed on-chain");
  });
});
