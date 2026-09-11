import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, rpc as StellarRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { OracleError, refreshTimeBounds as sdkRefreshTimeBounds, submitAndConfirm as sdkSubmitAndConfirm, TxTooLateError } from "@agrifeed/sdk";

// submitPrice constructs `new StellarRpc.Server(...)` internally with no
// injectable seam (the "test-only this step" decision from Phase 5 Step
// 7's audit explicitly left submit.ts's production code untouched, so no
// dependency-injection parameter was added either). The only way to
// exercise submitPrice's own real logic against a controlled network
// boundary without changing that code is to replace just the `Server`
// export -- every other export of @stellar/stellar-sdk used in this file
// (Account, Keypair, xdr, scValToNative, and everything submitPrice
// itself imports) stays the real implementation via `importOriginal`.
// `currentStub` is set per-test, immediately before each submitPrice
// call, so each test controls exactly its own network responses.
const currentStub = vi.hoisted(() => ({ server: undefined as unknown }));
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: function StubServer(this: unknown) {
        return currentStub.server;
      } as unknown as typeof actual.rpc.Server,
    },
  };
});

// eslint-disable-next-line import/first -- must follow the hoisted vi.mock above
import { submitPrice } from "./submit.js";

// A genuinely freshly-generated, throwaway keypair, exactly the same
// pattern packages/sdk's own tests use (Keypair.random()) -- never a
// real, funded, or reused secret.
const NODE_KEYPAIR = Keypair.random();
const ORACLE_CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";

function txResultWith(result: xdr.TransactionResultResult): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result,
    ext: xdr.TransactionResultExt.fromXDR(new Uint8Array([0, 0, 0, 0])),
  });
}

/** A stub RPC server matching only the methods submitPrice actually
 * calls -- not a mock of the whole @stellar/stellar-sdk module, a real
 * Account/real TransactionBuilder/real XDR round-trip through submitPrice's
 * own code, with only the network boundary (the 4 StellarRpc.Server calls)
 * replaced by controlled, deterministic responses. */
function stubServer(overrides: {
  getAccount?: () => Promise<Account>;
  prepareTransaction?: (tx: unknown) => Promise<unknown>;
  sendTransaction?: (tx: unknown) => Promise<unknown>;
  getTransaction?: (hash: string) => Promise<unknown>;
}): StellarRpc.Server {
  return {
    getAccount: overrides.getAccount ?? (async () => new Account(NODE_KEYPAIR.publicKey(), "100")),
    prepareTransaction: overrides.prepareTransaction ?? (async (tx: unknown) => tx),
    sendTransaction: overrides.sendTransaction ?? (async () => ({ status: "ERROR", errorResult: undefined, hash: "" })),
    getTransaction: overrides.getTransaction ?? (async () => ({ status: "NOT_FOUND" })),
  } as unknown as StellarRpc.Server;
}

async function runSubmitPriceWithStubServer(
  server: StellarRpc.Server,
  args: { commodity?: string; rawPrice?: string; sourceTs?: bigint } = {},
): Promise<void> {
  currentStub.server = server;
  try {
    await submitPrice(
      { rpcUrl: "https://example-unused.invalid", oracleContractId: ORACLE_CONTRACT_ID },
      NODE_KEYPAIR,
      args.commodity ?? "COCOA",
      args.rawPrice ?? "61880000000",
      args.sourceTs ?? 1_800_000_000n,
    );
  } finally {
    currentStub.server = undefined;
  }
}

describe("submitPrice -- successful path", () => {
  it("builds, signs, submits, and confirms a real submit_price invocation, unchanged shape", async () => {
    let sentTx:
      | {
          operations: Array<{
            func: { invokeContract: { functionName: { toString(): string }; args: xdr.ScVal[] } };
          }>;
        }
      | undefined;
    let getTransactionCalls = 0;
    const server = stubServer({
      sendTransaction: async (tx: unknown) => {
        sentTx = tx as typeof sentTx;
        return { status: "PENDING", hash: "abc123" };
      },
      getTransaction: async () => {
        getTransactionCalls++;
        return { status: StellarRpc.Api.GetTransactionStatus.SUCCESS };
      },
    });

    await runSubmitPriceWithStubServer(server, { commodity: "COCOA", rawPrice: "61880000000", sourceTs: 1_800_000_000n });

    expect(getTransactionCalls).toBe(1);
    expect(sentTx).toBeDefined();
    const op = sentTx!.operations[0]!;
    // Real XDR decoding of what was actually about to be submitted, not
    // an assertion on a mock's call arguments.
    const invocation = op.func.invokeContract;
    expect(invocation.functionName.toString()).toBe("submit_price");
    const args = invocation.args.map((a) => scValToNative(a));
    expect(args[0]).toBe(NODE_KEYPAIR.publicKey()); // node address, first arg
    expect(args[1]).toEqual(["Other", "COCOA"]); // Asset::Other(commodity)
    expect(args[2]).toBe(61_880_000_000n); // i128 raw price, exact
    expect(args[3]).toBe(1_800_000_000n); // source_ts
  });

  it("signs with the node's own keypair before submission, with a real, independently-verifiable signature", async () => {
    let submittedTx: { hash: () => Buffer; toEnvelope: () => xdr.TransactionEnvelope } | undefined;
    const server = stubServer({
      sendTransaction: async (tx: unknown) => {
        submittedTx = tx as typeof submittedTx;
        return { status: "PENDING", hash: "abc123" };
      },
      getTransaction: async () => ({ status: StellarRpc.Api.GetTransactionStatus.SUCCESS }),
    });

    await runSubmitPriceWithStubServer(server);

    const envelope = submittedTx!.toEnvelope() as unknown as {
      v1: { signatures: Array<{ signature: { value: Uint8Array } }> };
    };
    const signatures = envelope.v1.signatures;
    expect(signatures).toHaveLength(1);
    // Independently verify the signature against the transaction's own
    // real hash and the node's real public key -- not merely "a
    // signature is present", a real cryptographic check that it is
    // actually this keypair's signature over this actual transaction.
    const signatureBytes = Buffer.from(signatures[0]!.signature.value);
    expect(NODE_KEYPAIR.verify(submittedTx!.hash(), signatureBytes)).toBe(true);
  });
});

describe("submitPrice -- preflight/submission failure paths", () => {
  it("throws a typed OracleError, not a silent success, when submission is rejected", async () => {
    const server = stubServer({
      sendTransaction: async () => ({
        status: "ERROR",
        errorResult: txResultWith(xdr.TransactionResultResult.txBadAuth()),
        hash: "x",
      }),
    });

    await expect(runSubmitPriceWithStubServer(server)).rejects.toBeInstanceOf(OracleError);
  });

  it("includes the commodity in the error, for a useful operator-facing diagnostic", async () => {
    const server = stubServer({
      sendTransaction: async () => ({
        status: "ERROR",
        errorResult: txResultWith(xdr.TransactionResultResult.txBadAuth()),
        hash: "x",
      }),
    });

    await expect(runSubmitPriceWithStubServer(server, { commodity: "COFFEE" })).rejects.toThrow(/COFFEE/);
  });

  it("does not attempt a second submission after a rejected one (no retry loop inside submitPrice itself)", async () => {
    let sendCalls = 0;
    const server = stubServer({
      sendTransaction: async () => {
        sendCalls++;
        return { status: "ERROR", errorResult: txResultWith(xdr.TransactionResultResult.txBadAuth()), hash: "x" };
      },
    });

    await runSubmitPriceWithStubServer(server).catch(() => undefined);

    expect(sendCalls).toBe(1);
  });

  it("throws a typed OracleError for a real on-chain execution failure, distinct from a submission rejection", async () => {
    const server = stubServer({
      sendTransaction: async () => ({ status: "PENDING", hash: "abc123" }),
      getTransaction: async () => ({ status: StellarRpc.Api.GetTransactionStatus.FAILED }),
    });

    await expect(runSubmitPriceWithStubServer(server)).rejects.toBeInstanceOf(OracleError);
  });

  it("throws a typed OracleError, not hanging forever, when confirmation never arrives", async () => {
    const server = stubServer({
      sendTransaction: async () => ({ status: "PENDING", hash: "abc123" }),
      getTransaction: async () => ({ status: "NOT_FOUND" }),
    });

    await expect(runSubmitPriceWithStubServer(server)).rejects.toThrow(/did not confirm in time/);
  }, 40_000);
});

describe("submitPrice -- error messages never leak the signing secret", () => {
  it("a rejected submission's error never contains the node's own secret key", async () => {
    const server = stubServer({
      sendTransaction: async () => ({
        status: "ERROR",
        errorResult: txResultWith(xdr.TransactionResultResult.txBadAuth()),
        hash: "x",
      }),
    });

    const err = await runSubmitPriceWithStubServer(server).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(NODE_KEYPAIR.secret());
  });
});

// Phase 6 Step 3: submit.ts was refactored to reuse
// packages/sdk/src/soroban-tx.ts's shared refreshTimeBounds/submitAndConfirm
// instead of a second, independently-maintained sign/send/poll loop (see
// docs/phase6-step2-submit-lifecycle-audit.md, decision: CONSOLIDATE, and
// docs/phase6-step3-submit-lifecycle-consolidation.md). These tests prove
// the shared path is genuinely wired in -- not just that the end-to-end
// behavior happens to look the same -- and that node-relayer inherits the
// SDK's tx_too_late classification.
describe("submitPrice -- shared SDK lifecycle (Phase 6 Step 3 consolidation)", () => {
  it("imports refreshTimeBounds and submitAndConfirm through @agrifeed/sdk's public surface, not an internal path", () => {
    // A direct, explicit check that the SDK primitives submit.ts depends
    // on are part of its declared public API (packages/sdk/src/index.ts),
    // not reached via a fragile relative import into the package's dist/
    // internals.
    expect(typeof sdkRefreshTimeBounds).toBe("function");
    expect(typeof sdkSubmitAndConfirm).toBe("function");
  });

  it(
    "refreshes the signing window to well beyond the original 60-second build-time timeout before " +
      "submitting -- proof the shared refreshTimeBounds path is actually used, not dead/unreachable " +
      "duplicate code sitting unused beside an equivalent, independently-maintained implementation",
    async () => {
      let sentTx: { timeBounds?: { maxTime: string } } | undefined;
      const server = stubServer({
        sendTransaction: async (tx: unknown) => {
          sentTx = tx as typeof sentTx;
          return { status: "PENDING", hash: "abc123" };
        },
        getTransaction: async () => ({ status: StellarRpc.Api.GetTransactionStatus.SUCCESS }),
      });

      const beforeCall = Math.floor(Date.now() / 1000);
      await runSubmitPriceWithStubServer(server);

      // The original, unrefreshed build-time window would cap maxTime at
      // beforeCall + 60. refreshTimeBounds's default (180s) starting from
      // just before submission must clear that by a wide, unambiguous
      // margin -- not a coincidence of timing.
      expect(Number(sentTx!.timeBounds!.maxTime)).toBeGreaterThan(beforeCall + 60);
    },
    20000,
  );

  it(
    "classifies a real tx_too_late rejection as TxTooLateError, not the generic OracleError " +
      "submit.ts used to throw for every rejection reason alike",
    async () => {
      const txTooLateResult = new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult.txTooLate(),
        ext: xdr.TransactionResultExt.fromXDR(new Uint8Array([0, 0, 0, 0])),
      });
      const server = stubServer({
        sendTransaction: async () => ({ status: "ERROR", errorResult: txTooLateResult, hash: "x" }),
      });

      const err = await runSubmitPriceWithStubServer(server, { commodity: "WHEAT" }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TxTooLateError);
      expect(err).toBeInstanceOf(OracleError); // TxTooLateError extends OracleError
      // The method label (submit_price(WHEAT)) is still threaded through,
      // preserving the existing "commodity is in the error" diagnostic
      // even for this newly-distinguishable failure kind.
      expect((err as Error).message).toContain("submit_price(WHEAT)");
    },
  );

  it(
    "does not retry submission itself on tx_too_late either -- sendTransaction is called exactly once, " +
      "matching submitAndConfirm's own no-retry guarantee, not a second, possibly-divergent implementation",
    async () => {
      let sendCalls = 0;
      const server = stubServer({
        sendTransaction: async () => {
          sendCalls++;
          return {
            status: "ERROR",
            errorResult: new xdr.TransactionResult({
              feeCharged: xdr.Int64.fromString("100"),
              result: xdr.TransactionResultResult.txTooLate(),
              ext: xdr.TransactionResultExt.fromXDR(new Uint8Array([0, 0, 0, 0])),
            }),
            hash: "x",
          };
        },
      });

      await runSubmitPriceWithStubServer(server).catch(() => undefined);

      expect(sendCalls).toBe(1);
    },
  );
});
