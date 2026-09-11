import { afterEach, describe, expect, it, vi } from "vitest";
import { OracleError, TxTooLateError } from "@agrifeed/sdk";
import { logSubmitFailure } from "./submitFailureLog.js";

// logSubmitFailure is the one piece of node-relayer-specific error
// handling this Phase 6 Step 3 consolidation adds (see
// docs/phase6-step2-submit-lifecycle-audit.md, "E. Error semantics"):
// TxTooLateError's own message (packages/sdk/src/types.ts) is worded for
// a human at a browser wallet ("approving it in the wallet took longer
// than the window allowed") -- correct for its real callers
// (pricefloor.ts/multiparty.ts), wrong for this unattended server. These
// tests exercise the real logger (not a mock of it), capturing what
// actually reaches stdout/stderr.
describe("logSubmitFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a server-appropriate warning for TxTooLateError, never mentioning a wallet or browser prompt", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logSubmitFailure(new TxTooLateError("submit_price(COCOA)"), "COCOA");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0] as [string];
    const record = JSON.parse(line) as { level: string; msg: string; commodity: string };
    expect(record.level).toBe("warn");
    expect(record.commodity).toBe("COCOA");
    expect(record.msg.toLowerCase()).not.toMatch(/wallet|browser|prompt/);
    // The real operational fact an operator needs: no funds moved, this
    // will self-heal without intervention on the next scheduled cycle --
    // not "try again" (there is no human here to try anything).
    expect(record.msg).toMatch(/next scheduled cycle will retry/);
  });

  it("still logs the generic failure line, unchanged, for every other error kind", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logSubmitFailure(new OracleError("submit_price(WHEAT) submission failed: bad auth"), "WHEAT");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line] = errorSpy.mock.calls[0] as [string];
    const record = JSON.parse(line) as { level: string; msg: string; commodity: string; error: string };
    expect(record.level).toBe("error");
    expect(record.commodity).toBe("WHEAT");
    expect(record.msg).toBe("failed to submit price, skipping this commodity this cycle");
    expect(record.error).toContain("bad auth");
  });

  it("routes a non-Error thrown value through the same generic path, stringified, never crashing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logSubmitFailure("a plain string rejection", "MAIZE");

    const [line] = errorSpy.mock.calls[0] as [string];
    const record = JSON.parse(line) as { error: string };
    expect(record.error).toBe("a plain string rejection");
  });
});
