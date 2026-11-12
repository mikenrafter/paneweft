import { Ledger } from "./bounded.js";
import type { Json, Limits } from "./types.js";
/** A value the encoder understands beyond plain JSON. */
export declare class Redacted {
    readonly reason?: string | undefined;
    constructor(reason?: string | undefined);
}
export declare class Unsupported {
    readonly reason: string;
    constructor(reason: string);
}
export declare const absent: unique symbol;
export type CapturedValue = null | undefined | boolean | number | bigint | string | Uint8Array | Redacted | Unsupported | typeof absent | CapturedValue[] | Map<string, CapturedValue> | {
    [key: string]: CapturedValue;
};
export declare function redacted(reason?: string): Redacted;
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
export declare const newStats: () => EncodeStats;
/** The longest prefix of `text` of at most `limitBytes` UTF-8 bytes; never splits a code point, and the walk ends at the cut. */
export declare function prefixOf(text: string, limitBytes: number): string;
/** `[kept prefix, omitted byte count]`; the cut never splits a code point. */
export declare function cutString(text: string, limitBytes: number): [string, number];
/** True when `text` has more than `max` code points; never walks more than `2 * max + 1` units of it. */
export declare function exceedsCodePoints(text: string, max: number): boolean;
/** The `paneweft.object-graph/1` encoding of `value` under `limits`, charged to `ledger` as it is built. Getters are never evaluated, on records
 * or on array indexes.
 *
 * Every piece is charged by the size of the text it becomes (`emit`), all or nothing: a leaf that does not fit becomes a `not-captured` marker
 * (an array element, or an object member named `…`), a container that runs out of room ends with one marker, and what was dropped is counted
 * in `stats.values`. Work is proportional to the output, not to the size of a huge container (sparse arrays included). A caller that gives no
 * ledger gets one that holds `limits.rootBytes` and `limits.collectionBytes`. The caller has just charged something (a name, a frame), so the
 * ledger holds at least the marker reserve on entry. */
export declare function encodeValue(value: CapturedValue, limits: Limits, stats?: EncodeStats, depth?: number, ledger?: Ledger): Json;
/** The display form used in shape examples and list cells. */
export declare function displayValue(value: CapturedValue, limits?: Limits, stats?: EncodeStats): string;
/** The shape `type` of a leaf. */
export declare function typeName(value: CapturedValue): string;
/** The Scalar form of a cell or shape example: plain scalars stay typed, every other state shows its display text. */
export declare function scalarOf(value: CapturedValue, limits: Limits, stats: EncodeStats): string | number | boolean | null;
/** CLAIM(S25): every free text scalar is cut before serialization; callers charge its emitted fragment [emission.test.ts]. */
export declare function boundedText(text: string, limits: Pick<Limits, "stringBytes">, stats: EncodeStats, schemaCap?: number): string;
