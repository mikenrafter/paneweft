export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export interface Limits {
    depth: number;
    objects: number;
    references: number;
    rootBytes: number;
    stringBytes: number;
    pageRows: number;
    collectionBytes: number;
    roots: number;
    viewRows: number;
    viewBudgetMs: number;
}
export type ObjectRef = {
    object: string;
} | {
    notCaptured: {
        reason: string;
    };
};
export type Bounded = {
    accepted: true;
} | {
    accepted: false;
    omittedSoFar: number;
};
export type Component = "shape" | "list" | "custom";
export type Direction = "asc" | "desc";
/** Diagnostics are data: a programming error or schema violation is never a successful empty view. */
export interface DiagnosticRecord {
    id: string;
    category: "compiler" | "typecheck" | "assertion" | "view-exception" | "output-schema" | "reference" | "limit" | "registration" | "renderer" | "runner";
    message: string;
    viewId?: string;
    exampleId?: string;
    nextAction: string;
}
/** A fault in how a view uses the SDK (a bad column, a duplicate id, an unknown type). It becomes a diagnostic of `category`. */
export declare class ViewError extends Error {
    readonly category: DiagnosticRecord["category"];
    constructor(category: DiagnosticRecord["category"], message: string);
}
/** The payload type is checked at every custom() call. Digests bind the renderer and its payload schema. */
export interface Renderer<Payload extends Json> {
    readonly id: string;
    readonly apiVersion: number;
    readonly payloadSchemaDigest: string;
    readonly assetDigest: string;
    readonly payloadType?: (payload: Payload) => Payload;
}
export declare function defineRenderer<Payload extends Json>(renderer: Omit<Renderer<Payload>, "payloadType">): Renderer<Payload>;
