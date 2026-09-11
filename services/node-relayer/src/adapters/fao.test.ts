import { afterEach, describe, expect, it, vi } from "vitest";
import { splitFaoRow, tryClassicApi } from "./fao.js";

describe("splitFaoRow", () => {
  it("splits a real-shaped FAOSTAT normalized-CSV row into its quoted fields", () => {
    const line = '"107","Côte d\'Ivoire","661","Cocoa, beans","5532","Producer Price (USD/tonne)","2023","2023","tonnes","2650.5","A"';
    const fields = splitFaoRow(line);
    expect(fields[0]).toBe("107");
    expect(fields[2]).toBe("661");
    expect(fields[6]).toBe("2023");
    expect(fields[9]).toBe("2650.5");
  });

  it("round-trips the exact number of fields a real row has", () => {
    const line = '"a","b","c"';
    expect(splitFaoRow(line)).toEqual(["a", "b", "c"]);
  });

  it("preserves an embedded comma inside a field's own text (e.g. a country name)", () => {
    const line = '"107","Ivory Coast, Republic of","661"';
    const fields = splitFaoRow(line);
    expect(fields[1]).toBe("Ivory Coast, Republic of");
  });
});

describe("tryClassicApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a real SourcePrice, picking the most recent year, when the API responds with real-shaped data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { Year: "2021", Value: 2000 },
              { Year: "2023", Value: 2650.5 },
              { Year: "2022", Value: 2200 },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await tryClassicApi("COCOA", { area: "107", item: "661" });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("FAO");
    expect(result!.price).toBe("2650.5");
    expect(result!.unit).toBe("USD/MT");
    expect(result!.asOf.getUTCFullYear()).toBe(2023);
  });

  it("returns null (triggering the bulk-CSV fallback) on a non-ok HTTP response, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));

    const result = await tryClassicApi("COCOA", { area: "107", item: "661" });

    expect(result).toBeNull();
  });

  it("returns null on a real network failure, never throwing, so the caller can fall back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await tryClassicApi("COCOA", { area: "107", item: "661" });

    expect(result).toBeNull();
  });

  it("returns null when the response has no data rows, rather than fabricating a price", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const result = await tryClassicApi("COCOA", { area: "107", item: "661" });

    expect(result).toBeNull();
  });
});
