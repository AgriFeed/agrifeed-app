import { TxTooLateError } from "@agrifeed/sdk";
import { logger } from "./logger.js";

/**
 * Logs one commodity's submission failure for this cycle. Kept in its own
 * module (rather than inline in index.ts's `tick`) so it can be imported
 * and tested directly without pulling in index.ts's top-level `main()`
 * call, which runs as an import side effect.
 *
 * `TxTooLateError` gets its own, server-appropriate message: the shared
 * SDK error (packages/sdk/src/types.ts) is worded for a human sitting at
 * a browser wallet ("approving it in the wallet took longer than the
 * window allowed") -- accurate for its actual callers
 * (pricefloor.ts/multiparty.ts), but misleading here, where nothing waits
 * on a human and no wallet is involved. This is a node-relayer-local
 * `catch` branch, not an edit to the shared SDK message (see
 * docs/phase6-step2-submit-lifecycle-audit.md, "E. Error semantics") --
 * forking or rewording the shared message would just reintroduce the kind
 * of duplication this consolidation removes.
 */
export function logSubmitFailure(err: unknown, commodity: string): void {
  if (err instanceof TxTooLateError) {
    logger.warn(
      "submit_price: signing window expired before reaching the network -- transient, no funds moved, " +
        "the next scheduled cycle will retry with a fresh transaction",
      { commodity },
    );
    return;
  }
  logger.error("failed to submit price, skipping this commodity this cycle", {
    commodity,
    error: err instanceof Error ? err.message : String(err),
  });
}
