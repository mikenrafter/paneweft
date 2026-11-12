import type { Json } from "./types.js";
export type OptionStatus = "chosen" | "abandoned" | "superseded" | "failed";
export interface TrailOptionSpec {
    id: string;
    status: OptionStatus;
    reason: string;
    evidence?: Array<{
        provenance: "read" | "parsed" | "compiled" | "observed" | "inferred";
        source: string;
        reason?: string;
    }>;
    supersededBy?: string;
}
export interface TrailEntrySpec {
    id: string;
    order: number;
    question: string;
    options: TrailOptionSpec[];
    decision: string;
    /** Snapshot-bound links to a type, view, example or source; a source link may carry the anchor it points at. */
    links?: Array<{
        kind: "type" | "view" | "example" | "source";
        id: string;
        snapshotId: string;
        anchor?: {
            repository: string;
            path: string;
            lines: [number, number];
        };
    }>;
    supersedes?: string;
    deadEndExample?: string;
}
export declare class TrailBuilder {
    readonly id: string;
    readonly title: string;
    private readonly entries;
    constructor(id: string, title: string);
    entry(entry: TrailEntrySpec): this;
    /** `paneweft.trail/1`. Defaults: empty evidence and links; `supersedes`, `supersededBy` and `deadEndExample` only when set. */
    toJSON(): Json;
}
export declare function trail(id: string, title: string): TrailBuilder;
