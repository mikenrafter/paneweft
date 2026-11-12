import type { Json, Limits } from "./types.js";
/** A piece of capture output: JSON text and its exact size in UTF-8 bytes. */
export interface Fragment {
    readonly text: string;
    readonly bytes: number;
}
/** The only serializer: the size of `json` is the size of this text. */
export declare function emit(json: Json): Fragment;
/** The fragment of the string `text` if it is at most `limit` bytes, else `undefined`. A string longer than `limit` UTF-16 units is not looked
 * at: every unit takes at least one byte of JSON text, so it cannot fit (that bounds the work; the size of what is returned is the size of the
 * text that was emitted). */
export declare function emitString(text: string, limit: number): Fragment | undefined;
export type CutReason = "root-bytes-limit" | "collection-limit";
/** The wire marker for a value or a rest of a container the byte budget cut. */
export declare const notCaptured: (reason: CutReason) => Json;
/** The member name that ends an object cut short by the budget; its value is a `not-captured` marker. */
export declare const CUT_KEY = "\u2026";
/** The most a cut container needs to end: `,"…":` and the longer marker. Held back from ordinary charges, spent only by a marker. */
export declare const MARKER_RESERVE: number;
/** The bytes a capture may still emit, as the smaller of the root budget and the collection budget. */
export declare class Ledger {
    readonly rootBytes: number;
    readonly collectionBytes: number;
    private rootUsed;
    private totalUsed;
    /** `base` is what the document already holds before any content: its frame and the completeness block it may need. */
    constructor(rootBytes: number, collectionBytes: number, base?: number);
    private rootRoom;
    private totalRoom;
    /** Bytes left in the closer budget, the marker reserve included. */
    room(): number;
    /** What ordinary content may still use. */
    spare(): number;
    /** Charges `bytes` if they fit what ordinary content may use; otherwise charges nothing and says so. */
    take(bytes: number): boolean;
    /** Charges the bytes of a marker, which may use the reserve. */
    takeMarker(bytes: number): void;
    give(bytes: number): void;
    /** A new root starts a fresh root budget. */
    startRoot(): void;
    /** Bytes charged to the collection so far; the difference of two readings is what was charged between them. */
    used(): number;
    /** Which budget is closer to empty, for the reason a marker names. */
    reason(): CutReason;
}
/** What one view has charged so far (its data and its stored pages). The capture settles it against the exact text of the record, or gives all
 * of it back when the view fails.
 *
 * A view may hold an *escrow*: bytes of the ledger taken when the view starts, before anything it references is captured. The view's own charges draw on its escrow
 * first, so the objects a list references while its rows are being added cannot spend the room the rows need (F18). Whatever is left unspent is settled with the rest:
 * `bytes` counts the escrow and what was taken beyond it. */
export declare class Charge {
    private readonly ledger;
    bytes: number;
    private escrow;
    constructor(ledger: Ledger, escrow?: number);
    spare(): number;
    take(bytes: number): boolean;
}
/** The share of the room a list view holds back for its own rows when it starts: the denominator. The objects its rows reference get the other half. */
export declare const ROW_ESCROW_DIVISOR = 2;
/** The marker for the current state of `ledger`. */
export declare function markerFor(ledger: Ledger): Json;
/** The document text and its size. The text is what is written; the size is what was measured on it. */
export interface Emission {
    readonly text: string;
    readonly bytes: number;
    /** True when the measure found the document over its bound and the empty marked graph was written instead. Never expected. */
    readonly emergency: boolean;
}
/** Serializes the graph `document` and checks the text against `limits.collectionBytes`. `empty` builds the document written when the ledger
 * and the measure disagree. */
export declare function serializeGraph(document: Json, limits: Pick<Limits, "collectionBytes">, empty: () => Json): Emission;
