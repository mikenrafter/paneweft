// Capture context, type tokens, the symbol protocol and object publication (spec sections 2 and 4; docs/v1-red-contract.md 3-5).
//
// A capture assigns an object id on publication (registration order, never an identity of an allocation), then computes the object's
// views and follows the references the views declare. Everything is bounded while it is built: a bound that bites yields a
// not-captured reference and a named omission, never an error and never silence.
import { AsyncLocalStorage } from "node:async_hooks";
import { Charge, Ledger, ROW_ESCROW_DIVISOR, emit, emitString, serializeGraph } from "./bounded.ts";
import { Budget, DetailsBuilder, TableBuilder, canonicalJson, sha256Hex, type ViewResult, type StandardViewResult } from "./builders.ts";
import { callerLine } from "./callsite.ts";
import { applyLimitOverrides, defaultLimits } from "./limits.ts";
import { ViewError, type Component, type DiagnosticRecord, type Json, type Limits, type ObjectRef, type Renderer } from "./types.ts";
import { cutString, encodeValue, newStats, type CapturedValue } from "./values.ts";

/** The symbol a class implements to be inspectable without a token. */
export const paneweftViews: unique symbol = Symbol.for("paneweft.views");

export interface ViewBuilders {
  self(): ObjectRef;
  details(): DetailsBuilder;
  table(): TableBuilder;
  custom<Payload extends Json>(renderer: Renderer<Payload>, payload: NoInfer<Payload>, fallback: StandardViewResult, objects?: readonly ObjectRef[]): ViewResult;
  /** Publishes `value` (once per traversal) and returns a reference; beyond a bound it returns a not-captured reference, not an error. */
  reference(value: unknown, token?: TypeToken<any>, options?: { name?: string; key?: string }): ObjectRef;
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
  source: { path: string; symbol: string };
}

export interface TypeToken<T> {
  readonly id: string;
  readonly source: { path: string; symbol: string };
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

export function defineType<T>(spec: TypeSpec): TypeToken<T> {
  const views: ViewDefinition<T>[] = [];
  return {
    id: spec.id,
    source: spec.source,
    views,
    view(viewSpec: ViewSpec<T>): ViewDefinition<T> {
      const line = callerLine(0);
      const definition: ViewDefinition<T> = { ...viewSpec, typeId: spec.id, ...(line === undefined ? {} : { definedAtLine: line }) };
      views.push(definition);
      return definition;
    },
  };
}

export interface CaptureOptions {
  captureId?: string;
  runId?: string;
  invocationId?: string;
  limits?: Partial<Limits>;
}

export type InspectResult =
  | { status: "inactive" }
  | { status: "published"; ref: ObjectRef }
  | { status: "failed"; code: "NO_TYPE" | "VIEW_FAILED"; message: string };

/** The finished immutable result: a paneweft.object-graph/1 document. `text` is the document as it is written and `bytes` its size in UTF-8
 * bytes: the text the serializer counted is the text that goes to the file. */
export class ObjectGraph {
  private parsed: Json | undefined;
  constructor(readonly text: string, readonly bytes: number, document: Json | undefined, readonly emergency: boolean) {
    this.parsed = document;
  }
  toJSON(): Json {
    this.parsed ??= JSON.parse(this.text) as Json;
    return this.parsed;
  }
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
const OMISSION_NAMES: readonly OmissionName[] = ["collectionBytes", "depth", "diagnostics", "fields", "labels", "objects", "references", "rootBytes", "roots", "rows", "strings", "values", "views"];
/** The completeness block at its largest: every omission named, with the largest count. The document's frame holds room for it from the start. */
const WIDEST_COMPLETENESS: Json = { status: "partial", omitted: Object.fromEntries(OMISSION_NAMES.map((name) => [name, { known: true, count: Number.MAX_SAFE_INTEGER }])) };

type Bound = "depth" | "objects" | "references" | "rootBytes" | "collectionBytes" | "roots";
const BOUND_REASON: Record<Bound, string> = { depth: "depth-limit", objects: "object-limit", references: "reference-limit", rootBytes: "root-bytes-limit", collectionBytes: "collection-limit", roots: "collection-limit" };

/** The hash an object record carries is 64 hex digits; its place is paid for before the fields that it covers exist. */
const CONTENT_HASH_PLACEHOLDER = "0".repeat(64);
const FAULT_CATEGORIES: ReadonlyArray<DiagnosticRecord["category"]> = ["view-exception", "output-schema", "reference", "registration"];
const DIAGNOSTIC_CATEGORIES: ReadonlyArray<DiagnosticRecord["category"]> = ["compiler", "typecheck", "assertion", "view-exception", "output-schema", "reference", "limit", "registration", "renderer", "runner"];
const NEXT_ACTION: Record<string, string> = {
  "view-exception": "Fix the exception in the named view function, then recollect the example.",
  "output-schema": "Fix the view so it builds a valid component (columns, unique ids, declared component), then recollect.",
  reference: "Give the referenced value a type token or implement [paneweftViews], then recollect.",
  limit: "Select fewer fields or rows, or ask the owner for a larger limit, then recollect.",
  registration: "Declare each view id once and register the module in the manifest, then recollect.",
  assertion: "Read the failed claim in the example, fix the code or the expectation, then recollect.",
};

function hasViews(value: unknown): value is Inspectable {
  return typeof value === "object" && value !== null && typeof (value as Record<symbol, unknown>)[paneweftViews] === "function";
}

class ObjectContext implements ViewBuilders {
  currentView: string | undefined;
  viewBestEffort = false;
  anyBestEffort = false;
  constructor(private readonly capture: Capture, readonly index: number) {}
  /** What the view being computed has charged; set for the length of one view. */
  charge: Charge | undefined;
  self(): ObjectRef { return { object: this.capture.objectAt(this.index).id }; }
  details(): DetailsBuilder {
    return new DetailsBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs), this.chargeOfView());
  }
  table(): TableBuilder {
    const object = this.capture.objectAt(this.index).id;
    const view = this.currentView ?? "";
    return new TableBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs), this.chargeOfView(), (page) => this.capture.pageFrame(object, view, page));
  }
  custom<Payload extends Json>(renderer: Renderer<Payload>, payload: NoInfer<Payload>, fallback: StandardViewResult, objects: readonly ObjectRef[] = []): ViewResult {
    if (fallback.kind === "unsupported") return fallback;
    if (fallback.component !== "shape" && fallback.component !== "list" || (fallback.pages?.length ?? 0) > 0) throw new ViewError("output-schema", "custom views require a standard fallback without stored pages");
    const metadata = { id: renderer.id, apiVersion: renderer.apiVersion, payloadSchemaDigest: renderer.payloadSchemaDigest, assetDigest: renderer.assetDigest };
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(metadata.id) || !Number.isSafeInteger(metadata.apiVersion) || metadata.apiVersion < 1 || ![metadata.payloadSchemaDigest, metadata.assetDigest].every((digest) => /^[0-9a-f]{64}$/.test(digest))) throw new ViewError("output-schema", "invalid renderer identity or digest");
    const stats = newStats();
    const charge = this.chargeOfView();
    const ledger = new Ledger(charge.spare(), charge.spare());
    const bounded = encodeValue(payload as CapturedValue, this.capture.limits, stats, 0, ledger);
    if (bounded === null || typeof bounded !== "object" || Array.isArray(bounded)) throw new ViewError("output-schema", "a custom renderer payload must be an object");
    const data: Json = { renderer: metadata, payload: bounded, objects: objects.flatMap((ref) => "object" in ref ? [ref.object] : []), fallback: { component: fallback.component, data: fallback.data } };
    if (!charge.take(emit(data).bytes - emit(fallback.data).bytes + emit(metadata).bytes)) return { ...fallback, omitted: { ...fallback.omitted, values: (fallback.omitted?.values ?? 0) + 1 } };
    const omitted = { ...fallback.omitted };
    if (stats.strings > 0) omitted.strings = (omitted.strings ?? 0) + stats.strings;
    if (stats.values > 0) omitted.values = (omitted.values ?? 0) + stats.values;
    return { kind: "built", component: "custom", data, omitted };
  }
  private chargeOfView(): Charge {
    if (this.charge === undefined) throw new ViewError("output-schema", "a builder can only be created while a view is being computed");
    return this.charge;
  }
  reference(value: unknown, token?: TypeToken<any>, options: { name?: string; key?: string } = {}): ObjectRef {
    const name = options.name ?? this.currentView ?? "reference";
    if (name.length === 0) throw new ViewError("reference", "an edge name must not be empty");
    const started = performance.now();
    const outcome = this.capture.open({ index: this.index, name: cutString(name, 256)[0] }, options.key, value, token, undefined);
    this.capture.nested.ms += performance.now() - started;
    if (outcome === "no-type") throw new ViewError("reference", `cannot reference a value with no type: pass a type token as the second argument or implement [paneweftViews] on its class (got ${describe(value)})`);
    return outcome;
  }
  field(name: string, value: CapturedValue): void {
    this.capture.setField(this.index, name, value);
  }
  label(text: string): void {
    this.capture.setLabel(this.index, text);
  }
  unsupported(reason: string): ViewResult {
    return { kind: "unsupported", reason };
  }
  bestEffort(): void {
    this.viewBestEffort = true;
    this.anyBestEffort = true;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return `an object with constructor ${(value as object).constructor?.name ?? "unknown"}`;
  return typeof value;
}

export class Capture {
  readonly limits: Limits;
  readonly nested = { ms: 0 };
  private readonly options: Required<Pick<CaptureOptions, "captureId" | "runId" | "invocationId">>;
  private readonly objects: ObjectRec[] = [];
  private readonly viewRecords: Json[] = [];
  private readonly pageRecords: Json[] = [];
  private readonly diagnosticRecords: DiagnosticRecord[] = [];
  private readonly rootIds: string[] = [];
  private byObject = new Map<unknown, number>();
  private readonly byToken = new Map<string, number>();
  private readonly path: number[] = [];
  private references = 0;
  private readonly omitted = new Map<OmissionName, number>();
  /** Omissions whose size the capture does not know (an object cut short mid-walk): reported `known: false`, never as a guessed count. */
  private readonly unknownOmissions = new Set<OmissionName>();
  /** The bytes every part of the document is charged to as it is built (S2): object records, field values, edges, view records and their data,
   * stored page bodies and diagnostics, each by the size of the text it becomes. The ledger starts with the document's own frame. */
  private readonly ledger: Ledger;
  private readonly sealed: boolean;
  private faulted = false;

  constructor(options: CaptureOptions = {}) {
    this.limits = applyLimitOverrides(defaultLimits(), options.limits);
    const captureId = options.captureId ?? "c1";
    this.options = { captureId, runId: options.runId ?? "run-1", invocationId: options.invocationId ?? "inv-1" };
    const frame = emit(this.document([], [], [], [], [], WIDEST_COMPLETENESS)).bytes;
    this.ledger = new Ledger(this.limits.rootBytes, this.limits.collectionBytes, frame);
    this.sealed = frame > this.limits.collectionBytes;
  }

  objectAt(index: number): ObjectRec {
    return this.objects[index] as ObjectRec;
  }

  count(name: OmissionName, amount: number): void {
    if (amount > 0) this.omitted.set(name, (this.omitted.get(name) ?? 0) + amount);
  }

  /** Publishes a root. Separate calls are separate observations unless `identity` names a capture-local token. */
  publish(value: unknown, token?: TypeToken<any>, options: { key?: string; identity?: string } = {}): InspectResult {
    this.byObject = new Map();
    const outcome = this.open(undefined, options.key, value, token, options.identity);
    if (outcome === "no-type") return { status: "failed", code: "NO_TYPE", message: `cannot publish a value with no type: pass a type token or implement [paneweftViews] on its class (got ${describe(value)})` };
    return { status: "published", ref: outcome };
  }

  get diagnostics(): DiagnosticRecord[] {
    return [...this.diagnosticRecords];
  }

  addDiagnostic(category: string, message: string, extra: { viewId?: string; exampleId?: string; id?: string } = {}): string {
    const known = (DIAGNOSTIC_CATEGORIES as ReadonlyArray<string>).includes(category) ? (category as DiagnosticRecord["category"]) : "view-exception";
    const id = extra.id ?? `diag-${this.options.captureId}-${this.diagnosticRecords.length + 1}`;
    const entry: DiagnosticRecord = { id, category: known, message: cutString(message, 2000)[0], ...(extra.viewId === undefined ? {} : { viewId: extra.viewId }), ...(extra.exampleId === undefined ? {} : { exampleId: extra.exampleId }), nextAction: NEXT_ACTION[known] ?? "Read the message, fix the named source, then recollect the example." };
    if (FAULT_CATEGORIES.includes(known)) this.faulted = true;
    // a diagnostic is charged like everything else; when even it does not fit it is counted, and a fault still fails the capture
    if (!this.ledger.take(emit(entry as unknown as Json).bytes + (this.diagnosticRecords.length > 0 ? 1 : 0))) this.count("diagnostics", 1);
    else this.diagnosticRecords.push(entry);
    return id;
  }

  /** True when a diagnostic makes the capture failed (a view fault; bounds and notes do not). */
  hasFault(): boolean {
    return this.faulted;
  }

  /** Charges and stores a declared field. The name is charged as the text it becomes, then the value is encoded against what is left; what
   * does not fit is cut and counted. */
  setField(index: number, name: string, value: CapturedValue): void {
    if (Buffer.byteLength(name) > this.limits.stringBytes) { this.count("fields", 1); this.count("strings", 1); return; }
    const object = this.objectAt(index);
    const known = Object.hasOwn(object.fields, name);
    if (known) this.ledger.give(object.fieldBytes.get(name) as number);
    const separator = !known && object.fieldBytes.size > 0 ? 1 : 0;
    const key = emitString(name, this.ledger.spare() - separator - 1);
    if (key === undefined || !this.ledger.take(separator + key.bytes + 1)) {
      if (known) throw new Error("a declared field no longer fits the room it was given back");
      this.count("fields", 1);
      return;
    }
    const before = this.ledger.used();
    const stats = newStats();
    const encoded = encodeValue(value, this.limits, stats, 0, this.ledger);
    object.fieldBytes.set(name, key.bytes + 1 + (this.ledger.used() - before));
    this.count("strings", stats.strings);
    this.count("values", stats.values);
    if (stats.open) this.unknownOmissions.add("values");
    // defined, not assigned: a field named `__proto__` is a field, not the prototype of the record
    Object.defineProperty(object.fields, name, { value: encoded, enumerable: true, writable: true, configurable: true });
  }

  setLabel(index: number, text: string): void {
    const object = this.objectAt(index);
    const [label, omitted] = cutString(text, Math.min(256, this.limits.stringBytes));
    const bytes = emit(label).bytes;
    const delta = bytes - object.labelBytes;
    if (delta > 0 && !this.ledger.take(delta)) {
      this.count("labels", 1);
      return;
    }
    if (delta < 0) this.ledger.give(-delta);
    if (omitted > 0) this.count("strings", 1);
    object.label = label;
    object.labelBytes = bytes;
  }

  /** Records an edge if the budget has room for it; reports whether it did. */
  private addEdge(index: number, edge: Json): boolean {
    const object = this.objectAt(index);
    if (!this.ledger.take(emit(edge).bytes + (object.edges.length > 0 ? 1 : 0))) return false;
    object.edges.push(edge);
    return true;
  }

  private refusal(parentDepth: number | undefined): Bound | undefined {
    const limits = this.limits;
    if (parentDepth !== undefined && this.references >= limits.references) return "references";
    if (parentDepth !== undefined && parentDepth + 1 > limits.depth) return "depth";
    if (this.objects.length >= limits.objects) return "objects";
    if (parentDepth === undefined && this.rootIds.length >= limits.roots) return "roots";
    return undefined;
  }

  /** The byte bound that refuses `bytes` more, if any. A root starts a fresh root budget. */
  private byteRefusal(bytes: number, isRoot: boolean): Bound | undefined {
    if (bytes <= this.ledger.spare()) return undefined;
    return !isRoot && this.ledger.reason() === "root-bytes-limit" ? "rootBytes" : "collectionBytes";
  }

  private refuse(parent: { index: number; name: string } | undefined, bound: Bound): ObjectRef {
    this.count(bound, 1);
    if (parent !== undefined) this.addEdge(parent.index, { name: parent.name, kind: "not-captured", reason: BOUND_REASON[bound] });
    return { notCaptured: { reason: BOUND_REASON[bound] } };
  }

  /** Registers `value` (or finds it again) and, for a new object, computes its views before returning. */
  open(parent: { index: number; name: string } | undefined, key: string | undefined, value: unknown, token: TypeToken<any> | undefined, identity: string | undefined): ObjectRef | "no-type" {
    if (token === undefined && !hasViews(value)) return "no-type";
    const trackable = (typeof value === "object" && value !== null) || typeof value === "function";
    const existing = identity !== undefined ? this.byToken.get(identity) : trackable ? this.byObject.get(value) : undefined;
    if (existing !== undefined) {
      const id = this.objectAt(existing).id;
      if (parent !== undefined) {
        if (this.references >= this.limits.references) return this.refuse(parent, "references");
        const edge: Json = { name: parent.name, kind: this.path.includes(existing) ? "cycle" : "alias", target: id };
        if (!this.addEdge(parent.index, edge)) return this.refuse(parent, this.byteRefusal(Infinity, false) ?? "collectionBytes");
        this.references += 1;
      }
      return { object: id };
    }
    const parentDepth = parent === undefined ? undefined : this.objectAt(parent.index).depth;
    const bound = this.refusal(parentDepth);
    if (bound !== undefined) return this.refuse(parent, bound);
    if (parent === undefined) this.ledger.startRoot(); // a root starts a fresh root budget

    const index = this.objects.length;
    const id = `o${index + 1}`;
    const context = new ObjectContext(this, index);
    const selection = this.select(value, token, context);
    const typeId = selection.type.id;
    // the record of the object, its entry in the root list and the edge that reaches it are charged before the object exists: no room, no object.
    // A domain key is at most 256 characters in the schema; a longer one is cut (and counted), not kept whole.
    const [domainKey, keyCut] = key === undefined ? [null, 0] : cutString(key, Math.min(256, this.limits.stringBytes));
    const label = cutString(domainKey ?? typeId.split("::").pop() ?? typeId, Math.min(256, this.limits.stringBytes))[0];
    const childEdge: Json | undefined = parent === undefined ? undefined : { name: parent.name, kind: "child", target: id };
    const record = emit({ id, typeId, domainKey, label, fields: {}, edges: [], views: [], contentHash: CONTENT_HASH_PLACEHOLDER }).bytes + (this.objects.length > 0 ? 1 : 0);
    const listed = parent === undefined ? emit(id).bytes + (this.rootIds.length > 0 ? 1 : 0) : 0;
    const edge = childEdge === undefined ? 0 : emit(childEdge).bytes + (this.objectAt((parent as { index: number }).index).edges.length > 0 ? 1 : 0);
    const byteBound = this.byteRefusal(record + listed + edge, parent === undefined);
    if (byteBound !== undefined) return this.refuse(parent, byteBound);
    this.ledger.take(record + listed);
    if (keyCut > 0) this.count("strings", 1);
    this.objects.push({ id, typeId, domainKey, label: undefined, fields: {}, edges: [], views: [], depth: parentDepth === undefined ? 0 : parentDepth + 1, labelBytes: emit(label).bytes, fieldBytes: new Map() });
    if (trackable) this.byObject.set(value, index);
    if (identity !== undefined) this.byToken.set(identity, index);
    if (parent === undefined) {
      this.rootIds.push(id);
    } else {
      this.references += 1;
      this.addEdge(parent.index, childEdge as Json);
    }
    this.path.push(index);
    try {
      for (const definition of selection.views) this.computeView(index, context, value, definition);
    } finally {
      this.path.pop();
    }
    return { object: id };
  }

  private select(value: unknown, token: TypeToken<any> | undefined, context: ObjectContext): ViewSelection<any> {
    if (token !== undefined) return { type: token, views: token.views };
    return (value as Inspectable)[paneweftViews](context);
  }

  private computeView(index: number, context: ObjectContext, value: unknown, definition: ViewDefinition<any>): void {
    const object = this.objectAt(index);
    if (object.views.includes(definition.id)) {
      this.addDiagnostic("registration", `object ${object.id} computed two views with the id ${definition.id}`, { viewId: definition.id });
      return;
    }
    // The frame of the view record is paid for BEFORE the view runs, so a field or table that takes all the room cannot leave its own view
    // without one; recordView settles the difference. No room for the frame: the view is not run, and the omission is named.
    const prepaid = emit({ viewId: definition.id, objectId: object.id, title: definition.title, question: definition.question, component: definition.component, priority: definition.priority, evidence: { provenance: "observed", runId: this.options.runId }, completeness: { status: "partial", reason: "row-limit", omitted: { rows: { known: true, count: Number.MAX_SAFE_INTEGER }, strings: { known: true, count: Number.MAX_SAFE_INTEGER } } }, data: 0, rowsTotal: Number.MAX_SAFE_INTEGER, pages: [] }).bytes + emit(definition.id).bytes + 2;
    if (!this.ledger.take(prepaid)) {
      this.count("views", 1);
      this.addDiagnostic("limit", `view ${definition.id} of object ${object.id} was not run: the byte budget of this capture is used up`, { viewId: definition.id });
      return;
    }
    context.currentView = definition.id;
    context.viewBestEffort = false;
    // F18: a list view holds back half of the room for its own rows before the objects its rows reference are captured, so a large object keeps its main list
    context.charge = new Charge(this.ledger, definition.component === "list" ? Math.floor(this.ledger.spare() / ROW_ESCROW_DIVISOR) : 0);
    const charge = context.charge;
    let result: ViewResult;
    try {
      const returned: unknown = definition.render(value, context);
      if (returned instanceof Promise) {
        void returned.catch(() => undefined);
        throw new ViewError("output-schema", `view ${definition.id} returned a promise: render must be synchronous, because the value is snapshotted while it is borrowed`);
      }
      result = returned as ViewResult;
    } catch (error) {
      const category = error instanceof ViewError ? error.category : "view-exception";
      const message = error instanceof ViewError ? error.message : `view ${definition.id} threw: ${error instanceof Error ? error.message : String(error)}`;
      this.ledger.give(prepaid + charge.bytes);
      this.addDiagnostic(category, message, { viewId: definition.id });
      return;
    } finally {
      context.currentView = undefined;
      context.charge = undefined;
    }
    this.recordView(index, definition, result, context.viewBestEffort || context.anyBestEffort, prepaid + charge.bytes);
  }

  /** The most a stored page of `viewId` of `objectId` costs besides its rows: its record in `pages` and its reference in the view, with commas. */
  pageFrame(objectId: string, viewId: string, index: number): number {
    const pageId = `sha256:${"0".repeat(64)}`;
    return emit({ pageId, viewId, objectId, index, rows: [] }).bytes + emit({ index, pageId, rowCount: this.limits.pageRows }).bytes + 2;
  }

  /** Settles a view against the text it becomes: the record, its stored pages and its entries in the lists that name them are measured by the
   * serializer, and the difference to what was charged while the view was built is charged or given back. A view that no longer fits is dropped. */
  private recordView(index: number, definition: ViewDefinition<any>, result: ViewResult, bestEffort: boolean, paid: number): void {
    const object = this.objectAt(index);
    if (result === null || typeof result !== "object" || (result.kind !== "built" && result.kind !== "unsupported")) {
      this.ledger.give(paid);
      this.addDiagnostic("output-schema", `view ${definition.id} did not return a built or unsupported result: finish the builder with done() or return view.unsupported(reason)`, { viewId: definition.id });
      return;
    }
    const record: Record<string, Json> = {
      viewId: definition.id,
      objectId: object.id,
      title: definition.title,
      question: definition.question,
      component: definition.component,
      priority: definition.priority,
      evidence: { provenance: "observed", runId: this.options.runId },
    };
    const pages: Json[] = [];
    const counted: Array<[OmissionName, number]> = [];
    if (result.kind === "unsupported") {
      const [reason, cut] = cutString(result.reason, Math.min(500, this.limits.stringBytes));
      if (cut > 0) counted.push(["strings", 1]);
      record.completeness = { status: "unsupported", reason, ...(bestEffort ? { consistency: "best-effort" } : {}) };
      record.unsupportedReason = reason;
      record.pages = [];
    } else {
      if (result.component !== definition.component && definition.component !== "custom") {
        this.ledger.give(paid);
        this.addDiagnostic("output-schema", `view ${definition.id} declares component ${JSON.stringify(definition.component)} but built a ${JSON.stringify(result.component)}`, { viewId: definition.id });
        return;
      }
      record.component = result.component;
      if (result.component === "custom") record.renderer = (result.data as { renderer: Json }).renderer;
      const omitted = result.omitted ?? {};
      const names = Object.keys(omitted) as Array<"rows" | "strings">;
      const completeness: Record<string, Json> = names.length === 0 ? { status: "complete" } : { status: "partial", reason: names.includes("rows") ? "row-limit" : "string-limit", omitted: Object.fromEntries(names.map((name) => [name, { known: true, count: omitted[name] as number }])) };
      for (const name of names) counted.push([name, omitted[name] as number]);
      if (bestEffort) completeness.consistency = "best-effort";
      if (result.overBudgetMs !== undefined) this.addDiagnostic("limit", `view ${definition.id} spent ${result.overBudgetMs} ms of its own computation; the cooperative budget is ${this.limits.viewBudgetMs} ms`, { viewId: definition.id });
      record.completeness = completeness;
      record.data = result.data;
      record.pages = (result.pages ?? []).map((page, offset) => ({ index: offset + 1, pageId: page.pageId, rowCount: page.rows.length }));
      for (const [offset, page] of (result.pages ?? []).entries()) pages.push({ pageId: page.pageId, viewId: definition.id, objectId: object.id, index: offset + 1, rows: page.rows });
      if (result.rowsTotal !== undefined) record.rowsTotal = result.rowsTotal;
    }
    let exact = emit(record as Json).bytes + (this.viewRecords.length > 0 ? 1 : 0) + emit(definition.id).bytes + (object.views.length > 0 ? 1 : 0);
    pages.forEach((page, offset) => {
      exact += emit(page).bytes + (this.pageRecords.length + offset > 0 ? 1 : 0);
    });
    if (exact > paid && !this.ledger.take(exact - paid)) {
      this.ledger.give(paid);
      this.count("views", 1);
      this.addDiagnostic("limit", `view ${definition.id} of object ${object.id} was dropped: the byte budget of this capture is used up`, { viewId: definition.id });
      return;
    }
    if (exact < paid) this.ledger.give(paid - exact);
    for (const [name, amount] of counted) this.count(name, amount);
    object.views.push(definition.id);
    this.viewRecords.push(record);
    this.pageRecords.push(...pages);
  }

  private objectJson(index: number): Json {
    const object = this.objectAt(index);
    const label = cutString(object.label ?? object.domainKey ?? object.typeId.split("::").pop() ?? object.typeId, Math.min(256, this.limits.stringBytes))[0];
    const hashInput = { domainKey: object.domainKey, fields: object.fields, label, typeId: object.typeId };
    return { id: object.id, typeId: object.typeId, domainKey: object.domainKey, label, fields: object.fields, edges: object.edges, views: object.views, contentHash: sha256Hex(canonicalJson(hashInput)) };
  }

  /** The document, member by member. The frame (everything but the lists) is what the ledger was charged for before any content. */
  private document(roots: string[], objects: Json[], views: Json[], pages: Json[], diagnostics: Json[], completeness: Json): Json {
    return {
      schemaVersion: "paneweft.object-graph/1",
      captureId: this.options.captureId,
      runId: this.options.runId,
      invocationId: this.options.invocationId,
      roots,
      objects,
      views,
      pages,
      diagnostics,
      limits: { ...this.limits },
      completeness,
    };
  }

  /** The finished document, serialized once by the bounded serializer. When the bound cannot hold even the empty document, or the measure of
   * the text disagrees with the ledger, the empty marked graph is written (the host refuses the first, and the second is a defect). */
  finish(): ObjectGraph {
    const names = [...new Set([...this.omitted.keys(), ...this.unknownOmissions])].sort();
    const omitted = Object.fromEntries(names.map((name) => [name, this.unknownOmissions.has(name) ? { known: false, count: null } : { known: true, count: this.omitted.get(name) as number }]));
    const completeness: Json = names.length === 0 ? { status: "complete" } : { status: "partial", omitted };
    const empty = (): Json => this.document([], [], [], [], [], { status: "partial", omitted: { collectionBytes: { known: true, count: Math.max(1, this.omitted.get("collectionBytes") ?? 0) } } });
    if (this.sealed) {
      const text = emit(empty());
      return new ObjectGraph(text.text, text.bytes, undefined, false);
    }
    const document = this.document(this.rootIds, this.objects.map((_, index) => this.objectJson(index)), this.viewRecords, this.pageRecords, this.diagnosticRecords as unknown as Json[], completeness);
    const emission = serializeGraph(document, this.limits, empty);
    return new ObjectGraph(emission.text, emission.bytes, emission.emergency ? undefined : document, emission.emergency);
  }
}

// The collector of a call chain (S8): an AsyncLocalStorage store, so an async example sees ITS capture whatever else is in flight. A
// process-wide stack mixed the inspections of concurrent examples and popped the wrong capture.
const ACTIVE = new AsyncLocalStorage<Capture>();

/** Runs `body` with `capture` as the active collector of this call chain (including every `await` inside it). */
export function runWithCapture<T>(capture: Capture, body: () => T): T {
  return ACTIVE.run(capture, body);
}

/** Publishes at an execution point. With no active collector it returns `inactive` and does no traversal. */
export function inspect(value: unknown, token?: TypeToken<any>): InspectResult {
  const capture = ACTIVE.getStore();
  if (capture === undefined) return { status: "inactive" };
  return capture.publish(value, token);
}

/** Runs `body` with a new Capture as the active collector and returns what it published. */
export function withCapture(options: CaptureOptions, body: () => void): ObjectGraph {
  const capture = new Capture(options);
  runWithCapture(capture, body);
  return capture.finish();
}

/** As `withCapture`, for a body that awaits: the collector stays active across its awaits. */
export async function withCaptureAsync(options: CaptureOptions, body: () => Promise<void>): Promise<ObjectGraph> {
  const capture = new Capture(options);
  await runWithCapture(capture, body);
  return capture.finish();
}
