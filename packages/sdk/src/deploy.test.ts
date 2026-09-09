import { describe, expect, it } from "vitest";
import { wasmHashToBytes } from "./deploy.js";

describe("wasmHashToBytes", () => {
  it("decodes a real wasm hash (as printed by `stellar contract build`) to 32 bytes", () => {
    // A real hash from this project's own oracle build output.
    const hash = "16feff2ecec642e1529b157bd1aee95bb192c70e26a4bab222e4997803bfa8f4".slice(0, 64);

    const bytes = wasmHashToBytes(hash);

    expect(bytes).toHaveLength(32);
    expect(bytes[0]).toBe(0x16);
    expect(bytes[1]).toBe(0xfe);
    expect(bytes[31]).toBe(0xf4);
  });

  it("rejects a hash of the wrong length", () => {
    expect(() => wasmHashToBytes("abcd")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => wasmHashToBytes("g".repeat(64))).toThrow();
  });
});
