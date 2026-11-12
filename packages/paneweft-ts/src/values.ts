// Tagged values (docs/v1-red-contract.md section 2): every state JSON cannot carry is an explicit tagged object.
import { CUT_KEY, Ledger, emit, emitString, markerFor } from "./bounded.ts";
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
  /** True when an object was cut with members still unvisited: how many are left is not known, because the walk stopped (S2). */
  open: boolean;
  /** True once a marker has been written: the cut is marked where it happened, and every container around it ends there without a marker of its
   * own (the ledger holds back the bytes of one marker, not one per level). */
  cut: boolean;
}
export const newStats = (): EncodeStats => ({ strings: 0, values: 0, open: false, cut: false });

const MAX_NESTING = 64;
/** The extra bytes of the map tag over a plain object: `"$paneweft":"map","entries":[` and `]`, and two brackets per entry. */
const MAP_TAG = emit({ $paneweft: "map", entries: [] }).bytes - 2;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** The longest prefix of `text` of at most `limitBytes` UTF-8 bytes; never splits a code point, and the walk ends at the cut. */
export function prefixOf(text: string, limitBytes: number): string {
  // Every UTF-16 unit is at most 3 UTF-8 bytes, so a short string cannot exceed the limit.
  if (text.length * 3 <= limitBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const length = utf8Length(char.codePointAt(0) as number);
    if (bytes + length > limitBytes) break;
    bytes += length;
    end += char.length;
  }
  return text.slice(0, end);
}

/** `[kept prefix, omitted byte count]`; the cut never splits a code point. */
export function cutString(text: string, limitBytes: number): [string, number] {
  const kept = prefixOf(text, limitBytes);
  return kept.length === text.length ? [text, 0] : [kept, Buffer.byteLength(text, "utf8") - Buffer.byteLength(kept, "utf8")];
}

/** True when `text` has more than `max` code points; never walks more than `2 * max + 1` units of it. */
export function exceedsCodePoints(text: string, max: number): boolean {
  if (text.length > 2 * max) return true;
  let count = 0;
  for (const _ of text) count += 1;
  return count > max;
}

function isRecordLike(value: object): value is Record<string, CapturedValue> {
  return !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof Redacted) && !(value instanceof Unsupported);
}

const truncatedTag = (text: string, total: number): Json => ({ $paneweft: "truncated", text, keptBytes: Buffer.byteLength(text, "utf8"), omittedBytes: total - Buffer.byteLength(text, "utf8") });

/** The `paneweft.object-graph/1` encoding of `value` under `limits`, charged to `ledger` as it is built. Getters are never evaluated, on records
 * or on array indexes.
 *
 * Every piece is charged by the size of the text it becomes (`emit`), all or nothing: a leaf that does not fit becomes a `not-captured` marker
 * (an array element, or an object member named `…`), a container that runs out of room ends with one marker, and what was dropped is counted
 * in `stats.values`. Work is proportional to the output, not to the size of a huge container (sparse arrays included). A caller that gives no
 * ledger gets one that holds `limits.rootBytes` and `limits.collectionBytes`. The caller has just charged something (a name, a frame), so the
 * ledger holds at least the marker reserve on entry. */
export function encodeValue(value: CapturedValue, limits: Limits, stats: EncodeStats = newStats(), depth = 0, ledger: Ledger = new Ledger(limits.rootBytes, limits.collectionBytes, 0)): Json {
  const marker = (separator = 0): Json => {
    const tag = markerFor(ledger);
    ledger.takeMarker(separator + emit(tag).bytes);
    stats.cut = true;
    return tag;
  };
  /** Emits `leaf` if it fits, otherwise the marker. */
  const leaf = (json: Json): Json => {
    if (json !== null && typeof json === "object" && !Array.isArray(json) && typeof json.reason === "string" && json.$paneweft !== "not-captured") json = { ...json, reason: boundedText(json.reason, limits, stats, 256) };
    if (ledger.take(emit(json).bytes)) return json;
    stats.values += 1;
    return marker();
  };
  if (depth > MAX_NESTING) return leaf({ $paneweft: "unsupported", reason: "nesting" });
  switch (typeof value) {
    case "undefined":
      return leaf({ $paneweft: "absent" });
    case "boolean":
      return leaf(value);
    case "string":
      return encodeString(value, limits, stats, ledger, marker);
    case "number":
      if (Number.isNaN(value)) return leaf({ $paneweft: "float", value: "NaN" });
      if (value === Number.POSITIVE_INFINITY) return leaf({ $paneweft: "float", value: "Infinity" });
      if (value === Number.NEGATIVE_INFINITY) return leaf({ $paneweft: "float", value: "-Infinity" });
      if (Object.is(value, -0)) return leaf({ $paneweft: "float", value: "-0" });
      // An integer-valued number beyond the safe range is ALREADY lossy: refuse to guess (decision 9); a bigint is the exact form.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return leaf({ $paneweft: "unsupported", reason: "lossy-number" });
      return leaf(value);
    case "bigint":
      if ((value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) && (value < 0n ? -value : value) >= 10n ** BigInt(limits.stringBytes - Number(value < 0n))) {
        stats.strings += 1; stats.values += 1; return marker();
      }
      return leaf(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { $paneweft: "bigint", decimal: value.toString() });
    case "symbol":
      return leaf(value === absent ? { $paneweft: "absent" } : { $paneweft: "unsupported", reason: "symbol" });
    case "function":
      return leaf({ $paneweft: "unsupported", reason: "function" });
    default:
      break;
  }
  if (value === null) return leaf(null);
  if (value instanceof Redacted) return leaf(value.reason === undefined ? { $paneweft: "redacted" } : { $paneweft: "redacted", reason: boundedText(value.reason, limits, stats, 256) });
  if (value instanceof Unsupported) return leaf({ $paneweft: "unsupported", reason: boundedText(value.reason, limits, stats, 256) });
  if (value instanceof Uint8Array) return encodeBytes(value, limits, stats, ledger, leaf);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? leaf({ $paneweft: "unsupported", reason: "invalid-date" }) : encodeString(value.toISOString(), limits, stats, ledger, marker);
  if (!Array.isArray(value) && !(value instanceof Map) && !isRecordLike(value)) return leaf({ $paneweft: "unsupported", reason: "object" });
  // a container pays for its two brackets before anything else
  if (!ledger.take(2)) {
    stats.values += 1;
    return marker();
  }
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0 && !ledger.take(1)) {
        stats.values += value.length - index;
        out.push(marker(1));
        break;
      }
      // an index that holds an accessor is not read (S10): reading it would run the getter
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      const item = descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined) ? leaf({ $paneweft: "unsupported", reason: "getter" }) : encodeValue(descriptor?.value as CapturedValue, limits, stats, depth + 1, ledger);
      out.push(item);
      if (stats.cut) {
        // the budget ran out inside this element: its marker is the cut, nothing more is added
        stats.values += value.length - index - 1;
        break;
      }
    }
    return out;
  }
  // Members of a Map or an object. `charged` is what each kept pair cost, so that a pair can be given back when the cut key has no room.
  const pairs: Array<[string, Json]> = [];
  const charged: number[] = [];
  let stopped = false;
  let tagged = false;
  /** Charges `,"name":` (and what the map tag adds) if it fits; a name that does not fit ends the container (S2). */
  const admitKey = (name: string): boolean => {
    if (Buffer.byteLength(name) > limits.stringBytes) { stats.strings += 1; return false; }
    const separator = pairs.length > 0 ? 1 : 0;
    // the first `$paneweft` key turns the object into a map tag, which costs more for every entry kept so far
    const becomesTagged = !tagged && name === "$paneweft";
    const extra = (tagged || becomesTagged ? 2 : 0) + (becomesTagged ? MAP_TAG + 2 * pairs.length : 0);
    const key = emitString(name, Math.max(0, ledger.spare() - separator - 1 - extra));
    if (key === undefined || !ledger.take(separator + key.bytes + 1 + extra)) return false;
    if (becomesTagged) tagged = true;
    charged.push(separator + key.bytes + 1 + extra);
    return true;
  };
  let left = 0;
  const keep = (name: string, item: Json, before: number): void => {
    pairs.push([name, item]);
    charged[charged.length - 1] = ledger.used() - before;
  };
  if (value instanceof Map) {
    const total = value.size;
    for (const [key, item] of value) {
      const before = ledger.used();
      const name = String(key);
      if (!admitKey(name)) break;
      const encoded = encodeValue(item, limits, stats, depth + 1, ledger);
      keep(name, encoded, before);
      if (stats.cut) {
        stopped = true;
        break;
      }
    }
    left = total - pairs.length;
  } else {
    // A counted walk that ends with the budget (S2): `for...in` reads a member only when asked for the next one, so a huge object costs what
    // is kept, not what it holds. How many members were left is then not known: it is recorded as unknown, never as a guess.
    let more = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const before = ledger.used();
      if (stopped || !admitKey(key)) {
        more = true;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const accessor = descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined);
      const encoded = accessor ? leaf({ $paneweft: "unsupported", reason: "getter" }) : encodeValue(descriptor?.value as CapturedValue, limits, stats, depth + 1, ledger);
      keep(key, encoded, before);
      if (stats.cut) stopped = true;
    }
    if (more) {
      left = 1;
      stats.open = true;
    }
  }
  if (stopped) stats.values += left;
  else if (left > 0) {
    stats.values += left;
    // the member that ends the container; a key already used by a kept member makes the name longer, and a pair is given back until it fits
    for (;;) {
      let cutKey = CUT_KEY;
      while (pairs.some(([key]) => key === cutKey)) cutKey += CUT_KEY;
      const tag = markerFor(ledger);
      const cost = (pairs.length > 0 ? 1 : 0) + emit(cutKey).bytes + 1 + emit(tag).bytes + (tagged ? 2 : 0);
      if (cost <= ledger.room() || pairs.length === 0) {
        ledger.takeMarker(cost);
        stats.cut = true;
        pairs.push([cutKey, tag]);
        break;
      }
      ledger.give(charged.pop() as number);
      pairs.pop();
      tagged = pairs.some(([key]) => key === "$paneweft");
      stats.values += 1;
    }
  }
  if (tagged) return { $paneweft: "map", entries: pairs.map(([key, item]) => [key, item]) };
  return Object.fromEntries(pairs);
}

function encodeString(value: string, limits: Limits, stats: EncodeStats, ledger: Ledger, marker: () => Json): Json {
  const [kept, omitted] = cutString(value, limits.stringBytes);
  const whole = omitted === 0 ? emit(value) : emit(truncatedTag(kept, Buffer.byteLength(kept, "utf8") + omitted));
  if (ledger.take(whole.bytes)) {
    if (omitted > 0) stats.strings += 1;
    return omitted === 0 ? value : truncatedTag(kept, Buffer.byteLength(kept, "utf8") + omitted);
  }
  // cut again to what the budget still allows: the longest prefix whose tag fits, found by halving the interval (escaping makes the size of a
  // prefix irregular, so the size of each candidate is the size of its text)
  const total = Buffer.byteLength(value, "utf8");
  let low = 0;
  let high = Math.min(limits.stringBytes, total);
  const fits = (limit: number): boolean => emit(truncatedTag(prefixOf(value, limit), total)).bytes <= ledger.spare();
  if (!fits(0)) {
    stats.values += 1;
    return marker();
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const tag = truncatedTag(prefixOf(value, low), total);
  ledger.take(emit(tag).bytes);
  stats.strings += 1;
  return tag;
}

function encodeBytes(value: Uint8Array, limits: Limits, stats: EncodeStats, ledger: Ledger, leaf: (json: Json) => Json): Json {
  const tag = (count: number): Json => {
    const out: { [key: string]: Json } = { $paneweft: "bytes", base64: Buffer.from(value.subarray(0, count)).toString("base64"), length: value.length };
    if (count < value.length) out.truncated = true;
    return out;
  };
  let count = Math.min(value.length, 3 * Math.floor(limits.stringBytes / 4));
  if (emit(tag(count)).bytes > ledger.spare()) {
    // base64 takes 4 bytes per 3 and nothing in it is escaped, so the room gives the count; the size of the text confirms it
    count = Math.min(count, Math.max(0, 3 * Math.floor((ledger.spare() - emit(tag(0)).bytes) / 4)));
    while (count > 0 && emit(tag(count)).bytes > ledger.spare()) count -= 3;
  }
  if (count < value.length) stats.strings += 1;
  return leaf(tag(Math.max(0, count)));
}

/** The display form used in shape examples and list cells. */
export function displayValue(value: CapturedValue, limits?: Limits, stats = newStats()): string {
  const effective = limits ?? { depth: 4, objects: 1, references: 0, rootBytes: 16 * 1024, stringBytes: 16 * 1024, pageRows: 1, collectionBytes: 16 * 1024, roots: 1, viewRows: 1, viewBudgetMs: 1 };
  let safe = value;
  if (value instanceof Redacted && value.reason !== undefined) safe = new Redacted(boundedText(value.reason, effective, stats, 256));
  else if (value instanceof Unsupported) safe = new Unsupported(boundedText(value.reason, effective, stats, 256));
  return boundedText(displayUnbounded(safe, effective), effective, stats);
}
function displayUnbounded(value: CapturedValue, effective: Limits): string {
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
  return emit(encodeValue(value, effective, newStats(), 0, new Ledger(effective.stringBytes + 128, effective.stringBytes + 128, 0))).text;
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
  return displayValue(value, limits, stats);
}

/** CLAIM(S25): every free text scalar is cut before serialization; callers charge its emitted fragment [emission.test.ts]. */
export function boundedText(text: string, limits: Pick<Limits, "stringBytes">, stats: EncodeStats, schemaCap = Infinity): string {
  const [kept, omitted] = cutString(text, Math.min(limits.stringBytes, schemaCap));
  if (omitted > 0) stats.strings += 1;
  return kept;
}
