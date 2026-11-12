import { DetailsBuilder, TableBuilder, type ViewResult, type StandardViewResult } from "./builders.js";
import { type Component, type DiagnosticRecord, type Json, type Limits, type ObjectRef, type Renderer } from "./types.js";
import { type CapturedValue } from "./values.js";
/** The symbol a class implements to be inspectable without a token. */
export declare const paneweftViews: unique symbol;
export interface ViewBuilders {
    self(): ObjectRef;
    details(): DetailsBuilder;
    table(): TableBuilder;
    custom<Payload extends Json>(renderer: Renderer<Payload>, payload: NoInfer<Payload>, fallback: StandardViewResult, objects?: readonly ObjectRef[]): ViewResult;
    /** Publishes `value` (once per traversal) and returns a reference; beyond a bound it returns a not-captured reference, not an error. */
    reference(value: unknown, token?: TypeToken<any>, options?: {
        name?: string;
        key?: string;
    }): ObjectRef;
    field(name: string, value: CapturedValue): void;
    label(text: string): void;
    unsupported(reason: string): ViewResult;
    /** Marks the current view best-effort (separate reads without a consistent domain snapshot). */
    bestEffort(): void;
}
export interface ViewSpec<T> {
    id: string;
    title: string;
    question: string;
    priority: number;
    component: Component;
    render(value: T, view: ViewBuilders): ViewResult;
}
export interface ViewDefinition<T> extends ViewSpec<T> {
    readonly typeId: string;
    /** The line of the call that defined the view (for the catalogue). */
    readonly definedAtLine?: number;
}
export interface TypeSpec {
    id: string;
    source: {
        path: string;
        symbol: string;
    };
}
export interface TypeToken<T> {
    readonly id: string;
    readonly source: {
        path: string;
        symbol: string;
    };
    /** Declares a view of this type. Definitions are discoverable before any instance exists. */
    view(spec: ViewSpec<T>): ViewDefinition<T>;
    readonly views: ReadonlyArray<ViewDefinition<T>>;
}
/** What a class returns from `[paneweftViews]`: the registered definitions to apply, possibly selected per instance. */
export interface ViewSelection<T> {
    type: TypeToken<T>;
    views: ReadonlyArray<ViewDefinition<T>>;
}
export interface Inspectable<T = unknown> {
    [paneweftViews](view: ViewBuilders): ViewSelection<T>;
}
export declare function defineType<T>(spec: TypeSpec): TypeToken<T>;
export interface CaptureOptions {
    captureId?: string;
    runId?: string;
    invocationId?: string;
    limits?: Partial<Limits>;
}
export type InspectResult = {
    status: "inactive";
} | {
    status: "published";
    ref: ObjectRef;
} | {
    status: "failed";
    code: "NO_TYPE" | "VIEW_FAILED";
    message: string;
};
/** The finished immutable result: a paneweft.object-graph/1 document. `text` is the document as it is written and `bytes` its size in UTF-8
 * bytes: the text the serializer counted is the text that goes to the file. */
export declare class ObjectGraph {
    readonly text: string;
    readonly bytes: number;
    readonly emergency: boolean;
    private parsed;
    constructor(text: string, bytes: number, document: Json | undefined, emergency: boolean);
    toJSON(): Json;
}
interface ObjectRec {
    id: string;
    typeId: string;
    domainKey: string | null;
    label: string | undefined;
    fields: Record<string, Json>;
    edges: Json[];
    views: string[];
    depth: number;
    /** The bytes of the label the ledger was charged for. */
    labelBytes: number;
    /** The bytes each declared field was charged: its name, the colon and its encoded value. */
    fieldBytes: Map<string, number>;
}
/** Every name under which a capture counts what it left out. */
type OmissionName = "collectionBytes" | "depth" | "diagnostics" | "fields" | "labels" | "objects" | "references" | "rootBytes" | "roots" | "rows" | "strings" | "values" | "views";
export declare class Capture {
    readonly limits: Limits;
    readonly nested: {
        ms: number;
    };
    private readonly options;
    private readonly objects;
    private readonly viewRecords;
    private readonly pageRecords;
    private readonly diagnosticRecords;
    private readonly rootIds;
    private byObject;
    private readonly byToken;
    private readonly path;
    private references;
    private readonly omitted;
    /** Omissions whose size the capture does not know (an object cut short mid-walk): reported `known: false`, never as a guessed count. */
    private readonly unknownOmissions;
    /** The bytes every part of the document is charged to as it is built (S2): object records, field values, edges, view records and their data,
     * stored page bodies and diagnostics, each by the size of the text it becomes. The ledger starts with the document's own frame. */
    private readonly ledger;
    private readonly sealed;
    private faulted;
    constructor(options?: CaptureOptions);
    objectAt(index: number): ObjectRec;
    count(name: OmissionName, amount: number): void;
    /** Publishes a root. Separate calls are separate observations unless `identity` names a capture-local token. */
    publish(value: unknown, token?: TypeToken<any>, options?: {
        key?: string;
        identity?: string;
    }): InspectResult;
    get diagnostics(): DiagnosticRecord[];
    addDiagnostic(category: string, message: string, extra?: {
        viewId?: string;
        exampleId?: string;
        id?: string;
    }): string;
    /** True when a diagnostic makes the capture failed (a view fault; bounds and notes do not). */
    hasFault(): boolean;
    /** Charges and stores a declared field. The name is charged as the text it becomes, then the value is encoded against what is left; what
     * does not fit is cut and counted. */
    setField(index: number, name: string, value: CapturedValue): void;
    setLabel(index: number, text: string): void;
    /** Records an edge if the budget has room for it; reports whether it did. */
    private addEdge;
    private refusal;
    /** The byte bound that refuses `bytes` more, if any. A root starts a fresh root budget. */
    private byteRefusal;
    private refuse;
    /** Registers `value` (or finds it again) and, for a new object, computes its views before returning. */
    open(parent: {
        index: number;
        name: string;
    } | undefined, key: string | undefined, value: unknown, token: TypeToken<any> | undefined, identity: string | undefined): ObjectRef | "no-type";
    private select;
    private computeView;
    /** The most a stored page of `viewId` of `objectId` costs besides its rows: its record in `pages` and its reference in the view, with commas. */
    pageFrame(objectId: string, viewId: string, index: number): number;
    /** Settles a view against the text it becomes: the record, its stored pages and its entries in the lists that name them are measured by the
     * serializer, and the difference to what was charged while the view was built is charged or given back. A view that no longer fits is dropped. */
    private recordView;
    private objectJson;
    /** The document, member by member. The frame (everything but the lists) is what the ledger was charged for before any content. */
    private document;
    /** The finished document, serialized once by the bounded serializer. When the bound cannot hold even the empty document, or the measure of
     * the text disagrees with the ledger, the empty marked graph is written (the host refuses the first, and the second is a defect). */
    finish(): ObjectGraph;
}
/** Runs `body` with `capture` as the active collector of this call chain (including every `await` inside it). */
export declare function runWithCapture<T>(capture: Capture, body: () => T): T;
/** Publishes at an execution point. With no active collector it returns `inactive` and does no traversal. */
export declare function inspect(value: unknown, token?: TypeToken<any>): InspectResult;
/** Runs `body` with a new Capture as the active collector and returns what it published. */
export declare function withCapture(options: CaptureOptions, body: () => void): ObjectGraph;
/** As `withCapture`, for a body that awaits: the collector stays active across its awaits. */
export declare function withCaptureAsync(options: CaptureOptions, body: () => Promise<void>): Promise<ObjectGraph>;
export {};
