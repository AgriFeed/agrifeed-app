/** Narrow `scValToNative()` output defensively. The indexer has no
 * agrifeed-contract source to read event payload shapes from, so every
 * event handler must check shape at runtime and skip (never guess or
 * fabricate) rather than assume a field exists. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map);
}

/** Soroban structs frequently decode to a Map keyed by field name. */
export function toRecord(v: unknown): Record<string, unknown> | null {
  if (isRecord(v)) return v;
  if (v instanceof Map) return Object.fromEntries(v as Map<string, unknown>);
  return null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return null;
}

export function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}
