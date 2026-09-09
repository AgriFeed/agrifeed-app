import { describe, expect, it } from "vitest";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { cancelArgs, fundArgs } from "./pricefloor.js";

describe("cancelArgs", () => {
  it("encodes exactly one address argument, matching the contract's cancel(caller: Address)", () => {
    const caller = Keypair.random().publicKey();

    const args = cancelArgs(caller);

    // F-03: the old implementation invoked cancel() with an empty array,
    // while the contract requires exactly one Address argument. This is
    // the regression test for that fix.
    expect(args).toHaveLength(1);
  });

  it("round-trips to the exact caller address, not a different or malformed one", () => {
    const caller = Keypair.random().publicKey();

    const [arg] = cancelArgs(caller);
    if (!arg) throw new Error("expected one argument");

    expect(scValToNative(arg)).toBe(caller);
  });

  it("produces a different encoding for a different caller", () => {
    const a = cancelArgs(Keypair.random().publicKey());
    const b = cancelArgs(Keypair.random().publicKey());

    expect(a[0]?.toXDR("base64")).not.toBe(b[0]?.toXDR("base64"));
  });
});

// Regression coverage for fund(buyer: Address, amount: i128), unchanged by
// this step, matching the requirement to prove existing behavior still
// holds after the cancel fix and the new multi-party module land alongside it.
describe("fundArgs", () => {
  it("encodes exactly two arguments: the buyer address, then the i128 amount", () => {
    const buyer = Keypair.random().publicKey();

    const args = fundArgs(buyer, 500n);

    expect(args).toHaveLength(2);
    expect(scValToNative(args[0]!)).toBe(buyer);
    // i128 values can exceed Number.MAX_SAFE_INTEGER, so this SDK never
    // casts through Number(); scValToNative decodes i128 as a bigint,
    // which is asserted here directly rather than coerced.
    expect(scValToNative(args[1]!)).toBe(500n);
  });

  it("preserves large i128 amounts exactly, without float precision loss", () => {
    const buyer = Keypair.random().publicKey();
    const large = 123_456_789_012_345_678_901_234n; // well beyond Number.MAX_SAFE_INTEGER

    const args = fundArgs(buyer, large);

    expect(scValToNative(args[1]!)).toBe(large);
  });
});
