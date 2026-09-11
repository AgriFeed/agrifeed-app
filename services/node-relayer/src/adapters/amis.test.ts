import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceUnavailableError } from "@agrifeed/sdk";
import { fetchAmisPrice } from "./amis.js";

describe("fetchAmisPrice", () => {
  it(
    "always throws SourceUnavailableError, never a price, for a commodity AMIS has no product code " +
      "for -- exercised with zero network calls, since the commodity check short-circuits before any " +
      "fetch, matching AMIS's own documented role: real supply/demand context for logging only, never a price",
    async () => {
      await expect(fetchAmisPrice("COCOA")).rejects.toBeInstanceOf(SourceUnavailableError);
      await expect(fetchAmisPrice("COCOA")).rejects.toThrow(/cannot contribute to submit_price/);
    },
  );

  describe("for the 4 commodities AMIS does have a real product code for (WHEAT/RICE/MAIZE/SOYBEAN)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("still always throws SourceUnavailableError when the diagnostic fetch succeeds", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ some: "row" }]), { status: 200 })));

      for (const commodity of ["WHEAT", "MAIZE", "RICE", "SOYBEAN"]) {
        await expect(fetchAmisPrice(commodity)).rejects.toBeInstanceOf(SourceUnavailableError);
      }
    });

    it(
      "still always throws SourceUnavailableError (never something else) when the diagnostic fetch " +
        "itself fails -- that failure must never surface as a different, confusing error, and must " +
        "never block the real error this function always throws for its structural reason",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("fetch failed");
          }),
        );

        const err = await fetchAmisPrice("WHEAT").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SourceUnavailableError);
        expect((err as Error).message).toMatch(/cannot contribute to submit_price/);
      },
    );
  });
});
