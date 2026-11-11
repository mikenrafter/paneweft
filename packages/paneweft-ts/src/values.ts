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
  /** Strings cut at the string limit. */
  strings: number;
  /** Array elements, map entries and object members left out because the byte budget ran out. */
  values: number;
}
export const newStats = (): EncodeStats => ({ strings: 0, values: 0 });

/** The byte budget an encoding is charged against WHILE it builds its output (S2): `room()` is what is left of the smaller of the root and
 * collection budgets, `spend` charges bytes of JSON text, `reason()` names the budget that is closer to empty. */
export interface ByteMeter {
  room(): number;
  spend(bytes: number): void;
  reason(): "root-bytes-limit" | "collection-limit";
}

/** Bytes kept back so that a container which runs out of budget can always end with a marker. */
export const RESERVE = 64;
const jsonBytes = (json: Json): number => Buffer.byteLength(JSON.stringify(json), "utf8");
const isMarker = (json: Json): boolean => json !== null && typeof json === "object" && !Array.isArray(json) && json.$paneweft === "not-captured";
/** The member name that ends an object cut short by the budget; its value is a `not-captured` marker. */
const CUT_KEY = "\u2026";

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

/** The `paneweft.object-graph/1` encoding of `value` under `limits`. Getters are never evaluated, on records or on array indexes.
 *
 * With a `meter` the output is charged WHILE it is built (S2): a string is cut to the room left, and a container that runs out of room
 * stops and ends with `{ "$paneweft": "not-captured", "reason": ... }` (an array element, or an object member named `…`); the dropped
 * elements are counted in `stats.values`. Work is proportional to the output, not to the size of a huge container (sparse arrays
 * included). Without a meter nothing is bounded but strings, bytes and nesting. */
export function encodeValue(value: CapturedValue, limits: Limits, stats: EncodeStats = newStats(), depth = 0, meter?: ByteMeter): Json {
  const marker = (): Json => {
    const tag: Json = { $paneweft: "not-captured", reason: meter === undefined ? "budget" : meter.reason() };
    meter?.spend(jsonBytes(tag));
    return tag;
  };
  /** Emits `leaf` if it fits in what is left after the reserve, otherwise the marker. */
  const emit = (leaf: Json): Json => {
    if (meter === undefined) return leaf;
    const size = jsonBytes(leaf);
    if (size > meter.room() - RESERVE) {
      stats.values += 1;
      return marker();
    }
    meter.spend(size);
    return leaf;
  };
  const exhausted = (): boolean => meter !== undefined && meter.room() < RESERVE + 2;
  if (depth > MAX_NESTING) return emit({ $paneweft: "unsupported", reason: "nesting" });
  switch (typeof value) {
    case "undefined":
      return emit({ $paneweft: "absent" });
    case "boolean":
      return emit(value);
    case "string": {
      const [kept, omitted] = cutString(value, limits.stringBytes);
      let leaf: Json = omitted === 0 ? value : { $paneweft: "truncated", text: kept, keptBytes: Buffer.byteLength(kept, "utf8"), omittedBytes: omitted };
      if (omitted > 0) stats.strings += 1;
      if (meter !== undefined && jsonBytes(leaf) > meter.room() - RESERVE) {
        // cut again to what the budget still allows (the tag itself costs about 90 bytes)
        let allowed = Math.floor((meter.room() - RESERVE - 90) / 2);
        for (; allowed > 0; allowed = Math.floor(allowed / 2)) {
          const [text, rest] = cutString(value, Math.min(allowed, limits.stringBytes));
          leaf = { $paneweft: "truncated", text, keptBytes: Buffer.byteLength(text, "utf8"), omittedBytes: Buffer.byteLength(value, "utf8") - Buffer.byteLength(text, "utf8") };
          if (rest >= 0 && jsonBytes(leaf) <= meter.room() - RESERVE) break;
        }
        if (allowed <= 0) {
          stats.values += 1;
          return marker();
        }
        if (omitted === 0) stats.strings += 1;
      }
      return emit(leaf);
    }
    case "number":
      if (Number.isNaN(value)) return emit({ $paneweft: "float", value: "NaN" });
      if (value === Number.POSITIVE_INFINITY) return emit({ $paneweft: "float", value: "Infinity" });
      if (value === Number.NEGATIVE_INFINITY) return emit({ $paneweft: "float", value: "-Infinity" });
      if (Object.is(value, -0)) return emit({ $paneweft: "float", value: "-0" });
      // An integer-valued number beyond the safe range is ALREADY lossy: refuse to guess (decision 9); a bigint is the exact form.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return emit({ $paneweft: "unsupported", reason: "lossy-number" });
      return emit(value);
    case "bigint":
      return emit(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { $paneweft: "bigint", decimal: value.toString() });
    case "symbol":
      return emit(value === absent ? { $paneweft: "absent" } : { $paneweft: "unsupported", reason: "symbol" });
    case "function":
      return emit({ $paneweft: "unsupported", reason: "function" });
    default:
      break;
  }
  if (value === null) return emit(null);
  if (value instanceof Redacted) return emit(value.reason === undefined ? { $paneweft: "redacted" } : { $paneweft: "redacted", reason: value.reason });
  if (value instanceof Unsupported) return emit({ $paneweft: "unsupported", reason: value.reason });
  if (value instanceof Uint8Array) {
    // base64 is 4 bytes per 3; leave 120 bytes for the tag
    const byRoom = meter === undefined ? Infinity : Math.max(0, Math.floor(((meter.room() - RESERVE - 120) * 3) / 4));
    const kept = value.subarray(0, Math.min(limits.stringBytes, byRoom));
    const tag: { [key: string]: Json } = { $paneweft: "bytes", base64: Buffer.from(kept).toString("base64"), length: value.length };
    if (kept.length < value.length) tag.truncated = true;
    return emit(tag);
  }
  if (value instanceof Date) return emit(Number.isNaN(value.getTime()) ? { $paneweft: "unsupported", reason: "invalid-date" } : value.toISOString());
  if (!Array.isArray(value) && !(value instanceof Map) && !isRecordLike(value)) return emit({ $paneweft: "unsupported", reason: "object" });
  if (exhausted()) {
    stats.values += 1;
    return marker();
  }
  meter?.spend(2);
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (exhausted()) {
        stats.values += value.length - index;
        out.push(marker());
        break;
      }
      if (index > 0) meter?.spend(1);
      // an index that holds an accessor is not read (S10): reading it would run the getter
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      const item = descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined) ? emit({ $paneweft: "unsupported", reason: "getter" }) : encodeValue(descriptor?.value as CapturedValue, limits, stats, depth + 1, meter);
      out.push(item);
      if (isMarker(item) && meter !== undefined) {
        // the budget ran out inside this element: its marker is the cut, nothing more is added
        stats.values += value.length - index - 1;
        break;
      }
    }
    return out;
  }
  const pairs: Array<[string, Json]> = [];
  let total: number;
  let stopped = false;
  if (value instanceof Map) {
    total = value.size;
    let index = 0;
    for (const [key, item] of value) {
      if (exhausted()) break;
      const name = String(key);
      meter?.spend((index > 0 ? 1 : 0) + jsonBytes(name) + 1);
      const encoded = encodeValue(item, limits, stats, depth + 1, meter);
      pairs.push([name, encoded]);
      index += 1;
      if (isMarker(encoded) && meter !== undefined) {
        stopped = true;
        break;
      }
    }
  } else {
    const keys = Object.keys(value);
    total = keys.length;
    for (const [index, key] of keys.entries()) {
      if (exhausted()) break;
      meter?.spend((index > 0 ? 1 : 0) + jsonBytes(key) + 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const accessor = descriptor === undefined ? undefined : descriptor.get !== undefined || descriptor.set !== undefined ? ({ $paneweft: "unsupported", reason: "getter" } as Json) : undefined;
      const encoded = accessor === undefined ? encodeValue(descriptor?.value as CapturedValue, limits, stats, depth + 1, meter) : emit(accessor);
      pairs.push([key, encoded]);
      if (isMarker(encoded) && meter !== undefined) {
        stopped = true;
        break;
      }
    }
  }
  if (stopped) stats.values += total - pairs.length;
  else if (pairs.length < total) {
    stats.values += total - pairs.length;
    let cutKey = CUT_KEY;
    while (pairs.some(([key]) => key === cutKey)) cutKey += CUT_KEY;
    meter?.spend((pairs.length > 0 ? 1 : 0) + jsonBytes(cutKey) + 1);
    pairs.push([cutKey, marker()]);
  }
  if (pairs.some(([key]) => key === "$paneweft")) return { $paneweft: "map", entries: pairs.map(([key, item]) => [key, item]) };
  return Object.fromEntries(pairs);
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
  // a display cell never needs more text than one string may hold, so a huge container is cut here too
  let left = 16 * 1024;
  const meter: ByteMeter = { room: () => left, spend: (bytes) => { left -= bytes; }, reason: () => "collection-limit" };
  return JSON.stringify(encodeValue(value, { depth: 4, objects: 1, references: 0, rootBytes: 1, stringBytes: 16 * 1024, pageRows: 1, collectionBytes: 1, roots: 1, viewRows: 1, viewBudgetMs: 1 }, newStats(), 0, meter));
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
