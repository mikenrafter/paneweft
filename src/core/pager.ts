// The one pager behind every bounded reply (design section 4, round 2 S3).
//
// A reply is a HEADER (mandatory, repeated on every page) plus a STREAM of entries. A page holds as many whole entries as fit the
// byte budget. An entry that can never fit a page whole is split into FRAGMENTS {item_id, offset, length, total, text}: byte-offset
// slices on code-point boundaries whose concatenation is the entry's text. The cursor is (entry index, byte offset), so every page
// makes progress and a chain terminates with every byte delivered exactly once.
//
// CLAIM(page-within-budget): every page body is at most maxBytes UTF-8 bytes; page sizes are measured by really rendering the page, never
//   estimated [operations.budget.test.ts, MC3].
// CLAIM(page-progress): at maxBytes >= minimumBytes() each page delivers at least one whole entry or a fragment of at least
//   min(64, remaining) payload bytes, so a cursor chain advances and terminates [S3, operations.budget.test.ts].
// CLAIM(counts-along-chain): returned counts the countable entries whose first byte is on the page, omitted those that start later, so
//   offset + returned + omitted = matched on every page and the cursor is null iff nothing remains [ops.md section 2, S3].
import { BUDGET } from "./limits.ts";

export type Format = "text" | "json";

export interface Entry {
  /** The id fragments of this entry carry as `item_id`. */
  id: string;
  /** "gap" entries are never split (they are small by schema); "item" entries may be. */
  kind: "item" | "gap";
  /** Whether the entry counts toward matched / returned / omitted (tree context rows, annotations and gaps do not). */
  countable: boolean;
  /** The entry as it appears in a JSON reply's `items` (a gap: the gap object that goes to completeness.gaps). */
  json: unknown;
  /** The entry as text. A fragment cuts this string, so the pieces of one entry concatenate to exactly this. */
  text: string;
}

export type Slot =
  | { type: "whole"; entry: Entry }
  | { type: "fragment"; entry: Entry; offset: number; length: number; total: number; payload: string };

export interface PageState {
  slots: Slot[];
  /** True for the page that starts at the beginning of the stream. */
  first: boolean;
  /** Countable entries whose first byte is on this page. */
  returned: number;
  /** Countable entries whose first byte comes later. */
  omitted: number;
  /** Index of the first entry not started yet (the entry a continuation page begins with, unless the page ends inside one). */
  nextIndex: number;
  /** True when the page ends inside an entry whose remaining bytes follow on the next page. */
  pending: boolean;
  /** The cursor that continues after this page, or null. */
  cursor: string | null;
}

export interface Layout {
  entries: readonly Entry[];
  /** Renders a page of this reply. Must be deterministic. */
  render(page: PageState, format: Format): string;
  /** The cursor token for a position. */
  cursorAt(index: number, offset: number, format: Format): string;
}

export interface Position { index: number; offset: number }

/** Payload bytes of the final piece of a fragmented entry, and the least a non-final piece carries (the S3 progress floor). */
const TAIL_BYTES = 24;
/** Payload bytes the minimum budget must be able to carry in one fragment: a floor piece plus the tail plan's headroom, rounded up. */
const FRAGMENT_RESERVE = 160;
const SLACK_BYTES = 64;
const MIN_PIECE_BYTES = 64;
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
const sourceOf = (entry: Entry, format: Format): string => (format === "json" ? JSON.stringify(entry.json) : entry.text);

/** The source string whose bytes a fragment of this entry cuts: JSON text for json replies, the text line otherwise. */
export function fragmentSource(entry: Entry, format: Format): string {
  return sourceOf(entry, format);
}

function stateOf(layout: Layout, format: Format, start: Position, slots: Slot[], end: Position, pendingEntry: boolean): PageState {
  const { entries } = layout;
  // entries started on this page: from the first not started before this page up to (excluding) startedUpTo
  const firstNew = start.offset > 0 ? start.index + 1 : start.index;
  const startedUpTo = pendingEntry ? end.index + 1 : end.index;
  let returned = 0;
  let omitted = 0;
  for (let index = firstNew; index < startedUpTo && index < entries.length; index++) if ((entries[index] as Entry).countable) returned++;
  for (let index = startedUpTo; index < entries.length; index++) if ((entries[index] as Entry).countable) omitted++;
  const done = end.index >= entries.length && !pendingEntry;
  return {
    slots,
    first: start.index === 0 && start.offset === 0,
    returned,
    omitted,
    nextIndex: startedUpTo,
    pending: pendingEntry,
    cursor: done ? null : layout.cursorAt(end.index, end.offset, format),
  };
}

/** A prefix of `buffer[from..]` of at most `length` bytes ending on a code-point boundary. */
function alignedEnd(buffer: Buffer, from: number, length: number): number {
  let end = Math.min(buffer.length, from + length);
  while (end > from && end < buffer.length && ((buffer[end] as number) & 0xc0) === 0x80) end--;
  return end;
}

export interface PagedBody { body: string; state: PageState }

/**
 * Builds the page that starts at `start`. Throws only if the budget is below `minimumBytes` (callers check that first).
 * `maxBytes` bounds the UTF-8 length of the returned body.
 */
export function paginate(layout: Layout, format: Format, start: Position, maxBytes: number): PagedBody {
  const { entries } = layout;
  const total = entries.length;
  const measure = (state: PageState): number => byteLength(layout.render(state, format));
  const wholeSlots = (from: number, count: number): Slot[] => entries.slice(from, from + count).map((entry) => ({ type: "whole" as const, entry }));
  const wholeState = (from: number, count: number, prefix: Slot[], begin: Position): PageState =>
    stateOf(layout, format, begin, [...prefix, ...wholeSlots(from, count)], { index: from + count, offset: 0 }, false);

  /** The largest count of whole entries from `from` (after `prefix` slots) that fit; the page ends right after them. */
  const largestWhole = (from: number, prefix: Slot[], begin: Position): number => {
    const available = total - from;
    // every entry costs at least a few bytes; bound the search so a huge stream does not render thousands of entries per probe
    let low = 0;
    let high = Math.min(available, Math.max(1, Math.floor(maxBytes / 4)));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(wholeState(from, middle, prefix, begin)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    // the digits of the counts are not monotone in the count; make sure the chosen page really fits
    while (low > 0 && measure(wholeState(from, low, prefix, begin)) > maxBytes) low--;
    return low;
  };

  /**
   * Largest fragment of `entry` starting at byte `offset` that fits after `prefix`; null when not even one code point does.
   *
   * CLAIM(fragment-tail): the last piece of a fragmented entry is short (TAIL_BYTES) and every other piece is at least MIN_PIECE_BYTES.
   *   The planner therefore never lets the remainder after a piece fall into (0, MIN_PIECE_BYTES + TAIL_BYTES): it shortens the piece
   *   instead. Reason: a consumer that scans page lines for the row grammar `<cell> -> kind:id; provenance; evidence` must not find a
   *   whole row tail inside one fragment line, and a final sliver can be delivered alone on any page [operations.budget.test.ts S3].
   */
  const largestFragment = (index: number, offset: number, prefix: Slot[], begin: Position): { slot: Slot; end: Position; finished: boolean } | null => {
    const entry = entries[index] as Entry;
    const source = Buffer.from(sourceOf(entry, format), "utf8");
    const remaining = source.length - offset;
    const build = (end: number): { slot: Slot; position: Position; finished: boolean } => {
      const finished = end >= source.length;
      const slot: Slot = { type: "fragment", entry, offset, length: end - offset, total: source.length, payload: source.subarray(offset, end).toString("utf8") };
      return { slot, position: finished ? { index: index + 1, offset: 0 } : { index, offset: end }, finished };
    };
    const fits = (end: number): boolean => {
      const piece = build(end);
      return measure(stateOf(layout, format, begin, [...prefix, piece.slot], piece.position, !piece.finished)) <= maxBytes;
    };
    // the largest end that fits (greedy) ...
    let low = offset; // the largest end known to fit; `offset` itself means "nothing fits yet"
    let high = source.length;
    while (low < high) {
      let probe = alignedEnd(source, offset, Math.ceil((low + high) / 2) - offset);
      if (probe <= low) probe = high; // the midpoint aligns down onto `low`: test the upper bound itself
      if (fits(probe)) low = probe;
      else high = alignedEnd(source, offset, probe - 1 - offset);
    }
    if (low <= offset) return null;
    // ... then the tail plan
    let end = low;
    if (remaining > TAIL_BYTES) {
      if (end >= source.length) end = alignedEnd(source, offset, remaining - TAIL_BYTES); // leave the tail for a last, short piece
      else if (source.length - end < MIN_PIECE_BYTES + TAIL_BYTES) end = alignedEnd(source, offset, remaining - (MIN_PIECE_BYTES + TAIL_BYTES));
      if (end <= offset) return null;
    }
    const piece = build(end);
    return { slot: piece.slot, end: piece.position, finished: piece.finished };
  };

  let prefix: Slot[] = [];
  let begin = start;
  let cursorIndex = start.index;

  if (start.offset > 0) {
    // continue an entry that an earlier page began
    const piece = largestFragment(start.index, start.offset, [], start);
    if (piece === null) throw new Error("page budget too small to make progress; callers must enforce minimumBytes first");
    if (!piece.finished) {
      const state = stateOf(layout, format, start, [piece.slot], piece.end, true);
      return { body: layout.render(state, format), state };
    }
    prefix = [piece.slot];
    cursorIndex = start.index + 1;
    begin = start;
  }

  const count = largestWhole(cursorIndex, prefix, begin);
  const nextIndex = cursorIndex + count;
  if (nextIndex >= total) {
    const state = wholeState(cursorIndex, count, prefix, begin);
    return { body: layout.render(state, format), state };
  }
  const next = entries[nextIndex] as Entry;
  const aloneState = stateOf(layout, format, { index: nextIndex, offset: 0 }, [{ type: "whole", entry: next }], { index: nextIndex + 1, offset: 0 }, false);
  const fitsAlone = measure(aloneState) <= maxBytes;
  const havePage = count > 0 || prefix.length > 0;
  if (fitsAlone && havePage) {
    // defer: it fits a page of its own, so it is delivered whole later and never fragmented
    const state = wholeState(cursorIndex, count, prefix, begin);
    return { body: layout.render(state, format), state };
  }
  if (next.kind === "gap") {
    // gaps are never split; minimumBytes() reserves room for the largest one
    if (!havePage) throw new Error("page budget too small for a gap; callers must enforce minimumBytes first");
    const state = wholeState(cursorIndex, count, prefix, begin);
    return { body: layout.render(state, format), state };
  }
  // the entry can never fit whole: fragment it, after the whole entries that precede it on this page
  const before = [...prefix, ...wholeSlots(cursorIndex, count)];
  const piece = largestFragment(nextIndex, 0, before, begin);
  const payloadBytes = piece === null ? 0 : (piece.slot as Extract<Slot, { type: "fragment" }>).length;
  const sourceBytes = byteLength(sourceOf(next, format));
  if (piece === null || (before.length > 0 && payloadBytes < Math.min(64, sourceBytes))) {
    // too little room left for a useful fragment: end the page here and start the fragmentation with a full page
    if (before.length === 0) throw new Error("page budget too small to make progress; callers must enforce minimumBytes first");
    const state = stateOf(layout, format, begin, before, { index: nextIndex, offset: 0 }, false);
    return { body: layout.render(state, format), state };
  }
  const state = stateOf(layout, format, begin, [...before, piece.slot], piece.end, !piece.finished);
  return { body: layout.render(state, format), state };
}

/** UTF-8 bytes a JSON string literal needs for `character`, beyond its own bytes (quotes, backslash, control characters). */
function jsonEscapeExtra(character: string): number {
  if (character === '"' || character === "\\") return 1;
  const code = character.codePointAt(0) as number;
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5;
  return 0;
}

/** The text of the window of at most `bytes` UTF-8 bytes whose serialisation (escaping included) is the longest. */
function worstWindow(source: string, bytes: number, format: Format): string {
  const characters = [...source];
  const raw = characters.map((character) => byteLength(character));
  const cost = characters.map((character, index) => (raw[index] as number) + (format === "json" ? jsonEscapeExtra(character) : 0));
  let start = 0;
  let rawSum = 0;
  let costSum = 0;
  let best = -1;
  let bestStart = 0;
  let bestEnd = 0;
  for (let end = 0; end < characters.length; end++) {
    rawSum += raw[end] as number;
    costSum += cost[end] as number;
    while (rawSum > bytes) { rawSum -= raw[start] as number; costSum -= cost[start] as number; start++; }
    if (costSum > best) { best = costSum; bestStart = start; bestEnd = end + 1; }
  }
  return characters.slice(bestStart, bestEnd).join("");
}

/**
 * The smallest budget at which `paginate` is guaranteed to make progress for this reply, in this format: the mandatory header (with
 * worst-case counts and cursor), plus room for the most demanding entry - its whole size, or when that is larger the framing of a
 * fragment carrying a worst-case-escaped window of FRAGMENT_RESERVE payload bytes - never below the 2048-byte floor.
 */
export function minimumBytes(layout: Layout, format: Format): number {
  const { entries } = layout;
  const worstState = (slots: Slot[]): PageState => ({
    slots, first: true, returned: entries.length, omitted: entries.length, nextIndex: 0, pending: true, cursor: layout.cursorAt(entries.length, 999_999_999, format),
  });
  const empty = byteLength(layout.render(worstState([]), format));
  let demand = 0;
  for (const entry of entries) {
    const source = sourceOf(entry, format);
    const wholeBytes = byteLength(layout.render(worstState([{ type: "whole", entry }]), format)) - empty;
    if (entry.kind === "gap" || byteLength(source) <= FRAGMENT_RESERVE) {
      demand = Math.max(demand, wholeBytes);
      continue;
    }
    const piece: Slot = { type: "fragment", entry, offset: 999_999_999, length: FRAGMENT_RESERVE, total: 999_999_999, payload: worstWindow(source, FRAGMENT_RESERVE, format) };
    demand = Math.max(demand, Math.min(wholeBytes, byteLength(layout.render(worstState([piece]), format)) - empty));
  }
  return Math.max(BUDGET.minimumBytes, empty + demand + SLACK_BYTES);
}

/** The slot of an entry as a JSON item (fragments are the `{fragment: {...}}` entries of the reply schema). */
export function jsonOfSlot(slot: Slot): unknown {
  return slot.type === "whole"
    ? slot.entry.json
    : { fragment: { item_id: slot.entry.id, offset: slot.offset, length: slot.length, total: slot.total, text: slot.payload } };
}

/** The slot of an entry as text: the entry's line, or `[fragment item=.. offset=.. length=.. total=..] <payload>`. */
export function textOfSlot(slot: Slot): string {
  return slot.type === "whole" ? slot.entry.text : `[fragment item=${slot.entry.id} offset=${slot.offset} length=${slot.length} total=${slot.total}] ${slot.payload}`;
}
