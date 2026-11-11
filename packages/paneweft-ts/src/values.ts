// Tagged values (docs/v1-red-contract.md section 2): every state JSON cannot carry is an explicit tagged object.
import type { Json, Limits } from "./types.ts";

/** A value the encoder understands beyond plain JSON. */
export class Redacted {
  constructor(readonly reason?: string) {}
}
export class Unsupported {
  constructor(readonly reason: string) {}
}
export const absent: unique symbol = Symbol.for("paneweft.absent");

export type CapturedValue = null | undefined | boolean | number | bigint | string | Uint8Array | Redacted | Unsupported | typeof absent | CapturedValue[] | Map<string, CapturedValue> | { [key: string]: CapturedValue };

export function redacted(reason?: string): Redacted {
  return new Redacted(reason);
}

/** What encoding gave up, so builders can name the omission instead of hiding it. */
export interface EncodeStats {
  strings: number;
}

const MAX_NESTING = 64;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** `[kept prefix, omitted byte count]`; the cut never splits a code point. */
export function cutString(text: string, limitBytes: number): [string, number] {
  // Every UTF-16 unit is at most 3 UTF-8 bytes, so a short string cannot exceed the limit.
  if (text.length * 3 <= limitBytes) return [text, 0];
  let bytes = 0;
  let end = 0;
  let total = 0;
  let open = true;
  for (const char of text) {
    const length = utf8Length(char.codePointAt(0) as number);
    total += length;
    if (open && bytes + length <= limitBytes) {
      bytes += length;
      end += char.length;
    } else {
      open = false;
    }
  }
  return total <= limitBytes ? [text, 0] : [text.slice(0, end), total - bytes];
}

function isRecordLike(value: object): value is Record<string, CapturedValue> {
  return !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof Redacted) && !(value instanceof Unsupported);
}

/** The `paneweft.object-graph/1` encoding of `value` under `limits`. Getters are never evaluated. */
export function encodeValue(value: CapturedValue, limits: Limits, stats: EncodeStats = { strings: 0 }, depth = 0): Json {
  if (depth > MAX_NESTING) return { $paneweft: "unsupported", reason: "nesting" };
  switch (typeof value) {
    case "undefined":
      return { $paneweft: "absent" };
    case "boolean":
      return value;
    case "string": {
      const [kept, omitted] = cutString(value, limits.stringBytes);
      if (omitted === 0) return value;
      stats.strings += 1;
      return { $paneweft: "truncated", text: kept, keptBytes: Buffer.byteLength(kept, "utf8"), omittedBytes: omitted };
    }
    case "number":
      if (Number.isNaN(value)) return { $paneweft: "float", value: "NaN" };
      if (value === Number.POSITIVE_INFINITY) return { $paneweft: "float", value: "Infinity" };
      if (value === Number.NEGATIVE_INFINITY) return { $paneweft: "float", value: "-Infinity" };
      if (Object.is(value, -0)) return { $paneweft: "float", value: "-0" };
      // An integer-valued number beyond the safe range is ALREADY lossy: refuse to guess (decision 9); a bigint is the exact form.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return { $paneweft: "unsupported", reason: "lossy-number" };
      return value;
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { $paneweft: "bigint", decimal: value.toString() };
    case "symbol":
      return value === absent ? { $paneweft: "absent" } : { $paneweft: "unsupported", reason: "symbol" };
    case "function":
      return { $paneweft: "unsupported", reason: "function" };
    default:
      break;
  }
  if (value === null) return null;
  if (value instanceof Redacted) return value.reason === undefined ? { $paneweft: "redacted" } : { $paneweft: "redacted", reason: value.reason };
  if (value instanceof Unsupported) return { $paneweft: "unsupported", reason: value.reason };
  if (value instanceof Uint8Array) {
    const kept = value.subarray(0, limits.stringBytes);
    const tag: { [key: string]: Json } = { $paneweft: "bytes", base64: Buffer.from(kept).toString("base64"), length: value.length };
    if (kept.length < value.length) tag.truncated = true;
    return tag;
  }
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, limits, stats, depth + 1));
  if (value instanceof Map) {
    const entries = [...value.entries()];
    if (entries.some(([key]) => key === "$paneweft")) return { $paneweft: "map", entries: entries.map(([key, item]) => [key, encodeValue(item, limits, stats, depth + 1)]) };
    return Object.fromEntries(entries.map(([key, item]) => [key, encodeValue(item, limits, stats, depth + 1)]));
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { $paneweft: "unsupported", reason: "invalid-date" } : value.toISOString();
  if (!isRecordLike(value)) return { $paneweft: "unsupported", reason: "object" };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, Json]> = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) entries.push([key, { $paneweft: "unsupported", reason: "getter" }]);
    else entries.push([key, encodeValue(descriptor.value as CapturedValue, limits, stats, depth + 1)]);
  }
  if (entries.some(([key]) => key === "$paneweft")) return { $paneweft: "map", entries: entries.map(([key, item]) => [key, item]) };
  return Object.fromEntries(entries);
}

/** The display form used in shape examples and list cells. */
export function displayValue(value: CapturedValue): string {
  if (value === null) return "null";
  if (value === undefined || value === absent) return "<absent>";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return "<unsupported: lossy-number>";
    return String(value);
  }
  if (typeof value === "function") return "<unsupported: function>";
  if (typeof value === "symbol") return "<unsupported: symbol>";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (value instanceof Redacted) return value.reason === undefined ? "<redacted>" : `<redacted: ${value.reason}>`;
  if (value instanceof Unsupported) return `<unsupported: ${value.reason}>`;
  return JSON.stringify(encodeValue(value, { depth: 4, objects: 1, references: 0, rootBytes: 1, stringBytes: 16 * 1024, pageRows: 1, collectionBytes: 1, roots: 1, viewRows: 1, viewBudgetMs: 1 }));
}

/** The shape `type` of a leaf. */
export function typeName(value: CapturedValue): string {
  if (value === null) return "null";
  if (value === undefined || value === absent) return "absent";
  switch (typeof value) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "bigint": return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? "number" : "bigint";
    case "number": return Number.isInteger(value) && !Number.isSafeInteger(value) ? "unsupported" : "number";
    case "function": case "symbol": return "unsupported";
    default: break;
  }
  if (value instanceof Uint8Array) return "bytes";
  if (value instanceof Redacted) return "redacted";
  if (value instanceof Unsupported) return "unsupported";
  return Array.isArray(value) ? "array" : "object";
}

/** The Scalar form of a cell or shape example: plain scalars stay typed, every other state shows its display text. */
export function scalarOf(value: CapturedValue, limits: Limits, stats: EncodeStats): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) && !(Number.isInteger(value) && !Number.isSafeInteger(value))) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string") {
    const [kept, omitted] = cutString(value, limits.stringBytes);
    if (omitted > 0) stats.strings += 1;
    return kept;
  }
  return displayValue(value);
}
