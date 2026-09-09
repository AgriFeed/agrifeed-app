import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { assertExpectedSigner, mergeSignedAuthEntries, toPendingAuthEntries, withAuthEntries } from "./multiparty.js";

// A real, valid-checksum contract strkey (this project's own deployed
// oracle address, already public). Only its validity as a strkey matters
// here, not which contract it actually names.
const CONTRACT_ID = "CBKAREHZ2ZXQW5RKPVERNL52AER2G45XVXQ7PPGLQL7FXJZ6VXRNTM2T";

/** Builds a real (offline, unsimulated) invokeHostFunction operation, the
 * same way multiparty.ts's own functions do, so tests exercise the exact
 * op.func/op.source shape production code sees, not a hand-typed stand-in. */
function buildRealInvokeOp() {
  const contract = new Contract(CONTRACT_ID);
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call("initialize", nativeToScVal(1, { type: "u32" })))
    .setTimeout(30)
    .build();
  const op = tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");
  return { tx, op };
}

/** A syntactically real, unsigned SOROBAN_CREDENTIALS_ADDRESS entry for
 * `address`, wrapping a real invocation tree (via buildRealInvokeOp) so
 * every field inspectAuthEntry reads is a genuine XDR value, not a stub. */
function addressCredentialedEntry(address: string, nonce = 1n): xdr.SorobanAuthorizationEntry {
  const { op } = buildRealInvokeOp();
  const func = op.func as { invokeContract: unknown };
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      func.invokeContract as never,
    ),
    subInvocations: [],
  });
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: new Address(address).toScAddress(),
      nonce,
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    }),
  );
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation });
}

function sourceAccountCredentialedEntry(): xdr.SorobanAuthorizationEntry {
  const { op } = buildRealInvokeOp();
  const func = op.func as { invokeContract: unknown };
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      func.invokeContract as never,
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation,
  });
}

describe("toPendingAuthEntries", () => {
  it("returns one entry per address-credentialed entry, keyed by that address", () => {
    const farmer = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const entries = [addressCredentialedEntry(farmer), addressCredentialedEntry(buyer)];

    const pending = toPendingAuthEntries(entries);

    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.address).sort()).toEqual([farmer, buyer].sort());
    // Each entryXdr round-trips to a real, still-unsigned entry.
    for (const p of pending) {
      const decoded = xdr.SorobanAuthorizationEntry.fromXDR(p.entryXdr, "base64");
      expect(decoded.credentials.type).toBe("sorobanCredentialsAddress");
    }
  });

  it("skips source-account-credentialed entries, since they need no independent signature", () => {
    const farmer = Keypair.random().publicKey();
    const entries = [sourceAccountCredentialedEntry(), addressCredentialedEntry(farmer)];

    const pending = toPendingAuthEntries(entries);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.address).toBe(farmer);
  });

  it("returns an empty array for a call that needed no separate authorization", () => {
    expect(toPendingAuthEntries([])).toEqual([]);
  });
});

describe("withAuthEntries", () => {
  it("replaces the operation's auth array with exactly the entries given, for a two-party call", () => {
    const { tx } = buildRealInvokeOp();
    const farmer = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const signedEntries = [addressCredentialedEntry(farmer), addressCredentialedEntry(buyer)];

    // Mirrors what rpc.assembleTransaction does internally in production
    // (TransactionBuilder.cloneFrom), so this test exercises withAuthEntries
    // against a builder shaped the way it actually receives one, timebounds
    // included, not a bare from-scratch builder.
    const builder = TransactionBuilder.cloneFrom(tx, { fee: tx.fee });

    const rebuilt = withAuthEntries(builder, tx, signedEntries);

    expect(rebuilt).toBeInstanceOf(Transaction);
    const rebuiltOp = rebuilt.operations[0];
    if (!rebuiltOp || rebuiltOp.type !== "invokeHostFunction") throw new Error("expected invokeHostFunction");
    expect(rebuiltOp.auth).toHaveLength(2);
    const addresses = (rebuiltOp.auth ?? [])
      .map((e) => e.credentials)
      .filter((c): c is xdr.SorobanCredentialsAddress => c.type === "sorobanCredentialsAddress")
      .map((c) => Address.fromScAddress(c.address.address).toString());
    expect(addresses.sort()).toEqual([farmer, buyer].sort());
  });

  it("rejects a transaction whose sole operation is not invokeHostFunction", () => {
    const source = new Account(Keypair.random().publicKey(), "0");
    // A real, valid, non-Soroban operation: withAuthEntries must reject a
    // transaction shaped like this rather than silently doing nothing.
    const nonSorobanTx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
      .setTimeout(30)
      .build();
    const builder = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET });

    expect(() => withAuthEntries(builder, nonSorobanTx, [])).toThrow();
  });
});

describe("mergeSignedAuthEntries", () => {
  it("keeps a fresh source-account-credentialed entry alongside the signed address entries", () => {
    // Regression test for a real defect found during audit: when one party
    // (e.g. the farmer) is also the transaction's source account, their
    // requirement comes back from simulation as a SourceAccount-credentialed
    // entry, present in the auth array but needing no separate signature.
    // toPendingAuthEntries correctly never hands that entry out to be
    // signed, so signedEntries alone is missing it entirely. Soroban's host
    // (soroban-env-host's AccountAuthorizationTracker::from_authorization_entry)
    // only authorizes an address whose entry is actually present in the
    // submitted transaction, so dropping it here would make the farmer's
    // require_auth() fail on-chain even though the buyer signed correctly.
    const buyer = Keypair.random().publicKey();
    const freshAuth = [sourceAccountCredentialedEntry(), addressCredentialedEntry(buyer)];
    const signedEntries = [addressCredentialedEntry(buyer)]; // only the buyer's, as toPendingAuthEntries would hand out

    const merged = mergeSignedAuthEntries(freshAuth, signedEntries);

    expect(merged).toHaveLength(2);
    const credentialTypes = merged.map((e) => e.credentials.type).sort();
    expect(credentialTypes).toEqual(["sorobanCredentialsAddress", "sorobanCredentialsSourceAccount"].sort());
  });

  it("uses the signed entry, not a fresh one, for an address-credentialed party", () => {
    // The signed entry carries the original nonce/signature from the first
    // simulation; a fresh re-simulation's address-credentialed entry for the
    // same address carries a different nonce (a real, live re-simulation
    // always mints a new one) and must never replace the already-signed one.
    const buyer = Keypair.random().publicKey();
    const freshUnsigned = addressCredentialedEntry(buyer, 999n);
    const signed = addressCredentialedEntry(buyer, 1n);

    const merged = mergeSignedAuthEntries([freshUnsigned], [signed]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.toXDR("base64")).toBe(signed.toXDR("base64"));
    expect(merged[0]?.toXDR("base64")).not.toBe(freshUnsigned.toXDR("base64"));
  });

  it("returns just the signed entries when no party was satisfied by the source account", () => {
    const farmer = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const signedEntries = [addressCredentialedEntry(farmer), addressCredentialedEntry(buyer)];

    const merged = mergeSignedAuthEntries(signedEntries, signedEntries);

    expect(merged).toHaveLength(2);
  });
});

describe("assertExpectedSigner", () => {
  it("allows a connected address that matches the expected one", () => {
    const address = Keypair.random().publicKey();
    expect(() => assertExpectedSigner(address, address, "farmer")).not.toThrow();
  });

  it("rejects a connected wallet that is a different address than expected", () => {
    const expected = Keypair.random().publicKey();
    const wrongWallet = Keypair.random().publicKey();

    expect(() => assertExpectedSigner(wrongWallet, expected, "farmer")).toThrow(/farmer/);
  });

  it("rejects when no wallet is connected at all", () => {
    const expected = Keypair.random().publicKey();

    expect(() => assertExpectedSigner(null, expected, "buyer")).toThrow(/no wallet/);
  });

  it("names the expected and actual address in the error, for debuggability", () => {
    const expected = Keypair.random().publicKey();
    const wrongWallet = Keypair.random().publicKey();

    try {
      assertExpectedSigner(wrongWallet, expected, "buyer");
      throw new Error("expected assertExpectedSigner to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(expected);
      expect(message).toContain(wrongWallet);
    }
  });
});
