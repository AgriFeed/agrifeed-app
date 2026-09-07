/** A single observed price from one upstream source, before normalization. */
export interface SourcePrice {
  source: "FAO" | "IMF";
  commodity: string;
  /** Decimal string, e.g. "2544.80". Sources report in different units
   * (USD/tonne, US cents/lb); normalize.ts converts, never this file. */
  price: string;
  unit: string;
  /** When the underlying observation is dated (an FAO annual figure is
   * dated to a year-end, an IMF monthly figure to a month-end), not when
   * we happened to fetch it. */
  asOf: Date;
}

export type SourceAdapter = (commodity: string) => Promise<SourcePrice>;
