// The one boundary between captured data and capture output (consolidation D1).
//
// Every size the SDK charges is the size of a `Fragment`, and a `Fragment` exists only because `emit` serialized it: the bytes are counted on
// the JSON text that is written, escaping included. Nothing here (or anywhere in the SDK) decides "does it fit" from the length of an input.
// A `Ledger` admits a charge all-or-nothing, so an unchecked spend cannot exist; the ledger holds back the bytes of the one marker that ends
// a cut container (truncation metadata), and the document's own frame and completeness block are charged before anything else.
// `serializeGraph` is the only function that produces the document text; it measures that text once more and, should the measure ever
// disagree with the ledger, replaces the document with the empty marked graph instead of writing something over the bound.
import type { Json, Limits } from "./types.ts";

/** A piece of capture output: JSON text and its exact size in UTF-8 bytes. */
export interface Fragment {
  readonly text: string;
  readonly bytes: number;
}

/** The only serializer: the size of `json` is the size of this text. */
export function emit(json: Json): Fragment {
  const text = JSON.stringify(json);
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

/** The fragment of the string `text` if it is at most `limit` bytes, else `undefined`. A string longer than `limit` UTF-16 units is not looked
 * at: every unit takes at least one byte of JSON text, so it cannot fit (that bounds the work; the size of what is returned is the size of the
 * text that was emitted). */
export function emitString(text: string, limit: number): Fragment | undefined {
  if (text.length + 2 > limit) return undefined;
  const fragment = emit(text);
  return fragment.bytes <= limit ? fragment : undefined;
}

export type CutReason = "root-bytes-limit" | "collection-limit";

/** The wire marker for a value or a rest of a container the byte budget cut. */
export const notCaptured = (reason: CutReason): Json => ({ $paneweft: "not-captured", reason });
/** The member name that ends an object cut short by the budget; its value is a `not-captured` marker. */
export const CUT_KEY = "…";

/** The most a cut container needs to end: `,"…":` and the longer marker. Held back from ordinary charges, spent only by a marker. */
export const MARKER_RESERVE = 1 + emit(CUT_KEY).bytes + 1 + Math.max(emit(notCaptured("root-bytes-limit")).bytes, emit(notCaptured("collection-limit")).bytes);

/** The bytes a capture may still emit, as the smaller of the root budget and the collection budget. */
export class Ledger {
  private rootUsed = 0;
  private totalUsed: number;
  /** `base` is what the document already holds before any content: its frame and the completeness block it may need. */
  constructor(readonly rootBytes: number, readonly collectionBytes: number, base = 0) {
    this.totalUsed = base;
  }
  private rootRoom(): number {
    return Math.max(0, this.rootBytes - this.rootUsed);
  }
  private totalRoom(): number {
    return Math.max(0, this.collectionBytes - this.totalUsed);
  }
  /** Bytes left in the closer budget, the marker reserve included. */
  room(): number {
    return Math.min(this.rootRoom(), this.totalRoom());
  }
  /** What ordinary content may still use. */
  spare(): number {
    return Math.max(0, this.room() - MARKER_RESERVE);
  }
  /** Charges `bytes` if they fit what ordinary content may use; otherwise charges nothing and says so. */
  take(bytes: number): boolean {
    if (bytes > this.spare()) return false;
    this.rootUsed += bytes;
    this.totalUsed += bytes;
    return true;
  }
  /** Charges the bytes of a marker, which may use the reserve. */
  takeMarker(bytes: number): void {
    this.rootUsed += bytes;
    this.totalUsed += bytes;
  }
  give(bytes: number): void {
    this.rootUsed = Math.max(0, this.rootUsed - bytes);
    this.totalUsed = Math.max(0, this.totalUsed - bytes);
  }
  /** A new root starts a fresh root budget. */
  startRoot(): void {
    this.rootUsed = 0;
  }
  /** Bytes charged to the collection so far; the difference of two readings is what was charged between them. */
  used(): number {
    return this.totalUsed;
  }
  /** Which budget is closer to empty, for the reason a marker names. */
  reason(): CutReason {
    return this.rootRoom() <= this.totalRoom() ? "root-bytes-limit" : "collection-limit";
  }
}

/** What one view has charged so far (its data and its stored pages). The capture settles it against the exact text of the record, or gives all
 * of it back when the view fails.
 *
 * A view may hold an *escrow*: bytes of the ledger taken when the view starts, before anything it references is captured. The view's own charges draw on its escrow
 * first, so the objects a list references while its rows are being added cannot spend the room the rows need (F18). Whatever is left unspent is settled with the rest:
 * `bytes` counts the escrow and what was taken beyond it. */
export class Charge {
  bytes: number;
  private escrow: number;
  constructor(private readonly ledger: Ledger, escrow = 0) {
    const held = escrow > 0 && ledger.take(escrow) ? escrow : 0;
    this.bytes = held;
    this.escrow = held;
  }
  spare(): number { return this.escrow + this.ledger.spare(); }
  take(bytes: number): boolean {
    const fromEscrow = Math.min(bytes, this.escrow);
    const rest = bytes - fromEscrow;
    if (rest > 0) {
      if (!this.ledger.take(rest)) return false;
      this.bytes += rest;
    }
    this.escrow -= fromEscrow;
    return true;
  }
}

/** The share of the room a list view holds back for its own rows when it starts: the denominator. The objects its rows reference get the other half. */
export const ROW_ESCROW_DIVISOR = 2;

/** The marker for the current state of `ledger`. */
export function markerFor(ledger: Ledger): Json {
  return notCaptured(ledger.reason());
}

/** The document text and its size. The text is what is written; the size is what was measured on it. */
export interface Emission {
  readonly text: string;
  readonly bytes: number;
  /** True when the measure found the document over its bound and the empty marked graph was written instead. Never expected. */
  readonly emergency: boolean;
}

/** Serializes the graph `document` and checks the text against `limits.collectionBytes`. `empty` builds the document written when the ledger
 * and the measure disagree. */
export function serializeGraph(document: Json, limits: Pick<Limits, "collectionBytes">, empty: () => Json): Emission {
  const measured = emit(document);
  if (measured.bytes <= limits.collectionBytes) return { text: measured.text, bytes: measured.bytes, emergency: false };
  const fallback = emit(empty());
  return { text: fallback.text, bytes: fallback.bytes, emergency: true };
}
