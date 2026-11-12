// Capture context, type tokens, the symbol protocol and object publication (spec sections 2 and 4; docs/v1-red-contract.md 3-5).
//
// A capture assigns an object id on publication (registration order, never an identity of an allocation), then computes the object's
// views and follows the references the views declare. Everything is bounded while it is built: a bound that bites yields a
// not-captured reference and a named omission, never an error and never silence.
import { AsyncLocalStorage } from "node:async_hooks";
import { Budget, DetailsBuilder, TableBuilder, canonicalJson, sha256Hex, type ViewResult } from "./builders.ts";
import { callerLine } from "./callsite.ts";
import { applyLimitOverrides, defaultLimits } from "./limits.ts";
import { ViewError, type Component, type DiagnosticRecord, type Json, type Limits, type ObjectRef } from "./types.ts";
import { RESERVE, cutString, encodeValue, jsonStringBytes, newStats, type ByteMeter, type CapturedValue } from "./values.ts";

/** The symbol a class implements to be inspectable without a token. */
export const paneweftViews: unique symbol = Symbol.for("paneweft.views");

export interface ViewBuilders {
  details(): DetailsBuilder;
  table(): TableBuilder;
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

/** The finished immutable result: a paneweft.object-graph/1 document. */
export class ObjectGraph {
  constructor(private readonly document: Json) {}
  toJSON(): Json {
    return this.document;
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
  /** The label text the byte budget was charged for. */
  chargedLabel: string;
}

type Bound = "depth" | "objects" | "references" | "rootBytes" | "collectionBytes" | "roots";
const BOUND_REASON: Record<Bound, string> = { depth: "depth-limit", objects: "object-limit", references: "reference-limit", rootBytes: "root-bytes-limit", collectionBytes: "collection-limit", roots: "collection-limit" };

const FAULT_CATEGORIES: ReadonlyArray<DiagnosticRecord["category"]> = ["view-exception", "output-schema", "reference", "registration"];
const jsonBytes = (json: Json): number => Buffer.byteLength(JSON.stringify(json), "utf8");
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
  details(): DetailsBuilder {
    return new DetailsBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs), this.capture.meter);
  }
  table(): TableBuilder {
    return new TableBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs), this.capture.meter);
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
  private readonly omitted = new Map<string, number>();
  /** Omissions whose size the capture does not know (an object cut short mid-walk): reported `known: false`, never as a guessed count. */
  private readonly unknownOmissions = new Set<string>();
  /** Bytes of JSON text charged to the current root and to the whole collection (S2). */
  private rootUsed = 0;
  private totalUsed = 0;
  private faulted = false;

  /** The byte budget every part of the graph is charged to AS IT IS BUILT: object records, field values, edges, view records and their data,
   * stored page bodies and diagnostics. Nothing is measured after the fact. */
  readonly meter: ByteMeter = {
    room: () => Math.max(0, Math.min(this.limits.rootBytes - this.rootUsed, this.limits.collectionBytes - this.totalUsed)),
    spend: (bytes) => { this.rootUsed += bytes; this.totalUsed += bytes; },
    reason: () => (this.limits.rootBytes - this.rootUsed <= this.limits.collectionBytes - this.totalUsed ? "root-bytes-limit" : "collection-limit"),
  };

  constructor(options: CaptureOptions = {}) {
    this.limits = applyLimitOverrides(defaultLimits(), options.limits);
    const captureId = options.captureId ?? "c1";
    this.options = { captureId, runId: options.runId ?? "run-1", invocationId: options.invocationId ?? "inv-1" };
  }

  objectAt(index: number): ObjectRec {
    return this.objects[index] as ObjectRec;
  }

  count(name: string, amount: number): void {
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
    const cost = jsonBytes(entry as unknown as Json) + 1;
    if (cost > this.meter.room()) this.count("diagnostics", 1);
    else {
      this.meter.spend(cost);
      this.diagnosticRecords.push(entry);
    }
    return id;
  }

  /** True when a diagnostic makes the capture failed (a view fault; bounds and notes do not). */
  hasFault(): boolean {
    return this.faulted;
  }

  /** Charges and stores a declared field. The value is encoded against the byte budget; what does not fit is cut and counted. */
  setField(index: number, name: string, value: CapturedValue): void {
    const object = this.objectAt(index);
    const known = Object.hasOwn(object.fields, name);
    const nameBytes = known ? 0 : jsonStringBytes(name, this.meter.room() - RESERVE - 2);
    if (nameBytes === undefined) {
      this.count("fields", 1);
      return;
    }
    if (!known) this.meter.spend(nameBytes + 2);
    const stats = newStats();
    const encoded = encodeValue(value, this.limits, stats, 0, this.meter);
    this.count("strings", stats.strings);
    this.count("values", stats.values);
    if (stats.open) this.unknownOmissions.add("values");
    // defined, not assigned: a field named `__proto__` is a field, not the prototype of the record
    Object.defineProperty(object.fields, name, { value: encoded, enumerable: true, writable: true, configurable: true });
  }

  setLabel(index: number, text: string): void {
    const object = this.objectAt(index);
    const label = cutString(text, 256)[0];
    const delta = jsonBytes(label) - jsonBytes(object.chargedLabel);
    if (delta > 0 && delta > this.meter.room() - RESERVE) {
      this.count("labels", 1);
      return;
    }
    this.meter.spend(delta);
    object.label = label;
    object.chargedLabel = label;
  }

  /** Records an edge if the budget has room for it; reports whether it did. */
  private addEdge(index: number, edge: Json): boolean {
    const cost = jsonBytes(edge) + 1;
    if (cost > this.meter.room() - RESERVE) return false;
    this.meter.spend(cost);
    this.objectAt(index).edges.push(edge);
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

  /** The byte bound that refuses a new object whose record and edge need `need` bytes, if any. A root starts a fresh root budget. */
  private byteRefusal(need: number, isRoot: boolean): Bound | undefined {
    if (need <= this.meter.room() - RESERVE) return undefined;
    return !isRoot && this.meter.reason() === "root-bytes-limit" ? "rootBytes" : "collectionBytes";
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
    if (parent === undefined) this.rootUsed = 0; // a root starts a fresh root budget

    const index = this.objects.length;
    const id = `o${index + 1}`;
    const context = new ObjectContext(this, index);
    const selection = this.select(value, token, context);
    const typeId = selection.type.id;
    // the record of the object (and the edge that reaches it) is charged before the object exists: no room, no object
    // a domain key is at most 256 characters in the schema; a longer one is cut (and counted), not kept whole
    const [domainKey, keyCut] = key === undefined ? [null, 0] : cutString(key, 256);
    const label = cutString(domainKey ?? typeId.split("::").pop() ?? typeId, 256)[0];
    const childEdge: Json | undefined = parent === undefined ? undefined : { name: parent.name, kind: "child", target: id };
    const skeleton = 170 + jsonBytes(id) + jsonBytes(typeId) + jsonBytes(domainKey) + jsonBytes(label) + (childEdge === undefined ? 0 : jsonBytes(childEdge) + 1);
    const byteBound = this.byteRefusal(skeleton, parent === undefined);
    if (byteBound !== undefined) return this.refuse(parent, byteBound);
    this.meter.spend(skeleton - (childEdge === undefined ? 0 : jsonBytes(childEdge) + 1));
    if (keyCut > 0) this.count("strings", 1);
    this.objects.push({ id, typeId, domainKey, label: undefined, fields: {}, edges: [], views: [], depth: parentDepth === undefined ? 0 : parentDepth + 1, chargedLabel: label });
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
    const prepaid = jsonBytes({ viewId: definition.id, objectId: object.id, title: definition.title, question: definition.question, component: definition.component, priority: definition.priority, evidence: { provenance: "observed", runId: this.options.runId }, completeness: { status: "partial", reason: "row-limit", omitted: { rows: { known: true, count: 1_000_000_000 }, strings: { known: true, count: 1_000_000_000 } } }, pages: [] }) + jsonBytes(definition.id) + 2 + 160;
    if (prepaid > this.meter.room() - RESERVE) {
      this.count("views", 1);
      this.addDiagnostic("limit", `view ${definition.id} of object ${object.id} was not run: the byte budget of this capture is used up`, { viewId: definition.id });
      return;
    }
    this.meter.spend(prepaid);
    context.currentView = definition.id;
    context.viewBestEffort = false;
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
      this.refund(prepaid);
      this.addDiagnostic(category, message, { viewId: definition.id });
      return;
    } finally {
      context.currentView = undefined;
    }
    this.recordView(index, definition, result, context.viewBestEffort || context.anyBestEffort, prepaid);
  }

  private refund(bytes: number): void {
    this.rootUsed = Math.max(0, this.rootUsed - bytes);
    this.totalUsed = Math.max(0, this.totalUsed - bytes);
  }

  private recordView(index: number, definition: ViewDefinition<any>, result: ViewResult, bestEffort: boolean, prepaid: number): void {
    const object = this.objectAt(index);
    if (result === null || typeof result !== "object" || (result.kind !== "built" && result.kind !== "unsupported")) {
      this.refund(prepaid);
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
    if (result.kind === "unsupported") {
      const reason = cutString(result.reason, 500)[0];
      record.completeness = { status: "unsupported", reason, ...(bestEffort ? { consistency: "best-effort" } : {}) };
      record.unsupportedReason = reason;
      record.pages = [];
    } else {
      if (result.component !== definition.component) {
        this.refund(prepaid);
        this.addDiagnostic("output-schema", `view ${definition.id} declares component ${JSON.stringify(definition.component)} but built a ${JSON.stringify(result.component)}`, { viewId: definition.id });
        return;
      }
      const omitted = result.omitted ?? {};
      const names = Object.keys(omitted);
      const completeness: Record<string, Json> = names.length === 0 ? { status: "complete" } : { status: "partial", reason: names.includes("rows") ? "row-limit" : "string-limit", omitted: Object.fromEntries(names.map((name) => [name, { known: true, count: omitted[name] as number }])) };
      for (const name of names) this.count(name, omitted[name] as number);
      if (bestEffort) completeness.consistency = "best-effort";
      if (result.overBudgetMs !== undefined) this.addDiagnostic("limit", `view ${definition.id} spent ${result.overBudgetMs} ms of its own computation; the cooperative budget is ${this.limits.viewBudgetMs} ms`, { viewId: definition.id });
      record.completeness = completeness;
      record.data = result.data;
      record.pages = (result.pages ?? []).map((page, offset) => ({ index: offset + 1, pageId: page.pageId, rowCount: page.rows.length }));
      for (const [offset, page] of (result.pages ?? []).entries()) this.pageRecords.push({ pageId: page.pageId, viewId: definition.id, objectId: object.id, index: offset + 1, rows: page.rows });
      if (result.rowsTotal !== undefined) record.rowsTotal = result.rowsTotal;
    }
    // the view's data and pages were charged while the builders produced them; the record around them and its entry in the object are charged here
    // (the page references were paid for with their pages)
    const { data: _data, pages: _pages, ...frame } = record;
    const cost = jsonBytes(frame as Json) + jsonBytes(definition.id) + 2;
    if (cost > prepaid && cost - prepaid > this.meter.room()) {
      this.refund(prepaid);
      this.count("views", 1);
      this.addDiagnostic("limit", `view ${definition.id} of object ${object.id} was dropped: the byte budget of this capture is used up`, { viewId: definition.id });
      return;
    }
    if (cost > prepaid) this.meter.spend(cost - prepaid);
    else this.refund(prepaid - cost);
    object.views.push(definition.id);
    this.viewRecords.push(record);
  }

  private objectJson(index: number): Json {
    const object = this.objectAt(index);
    const label = cutString(object.label ?? object.domainKey ?? object.typeId.split("::").pop() ?? object.typeId, 256)[0];
    const hashInput = { domainKey: object.domainKey, fields: object.fields, label, typeId: object.typeId };
    return { id: object.id, typeId: object.typeId, domainKey: object.domainKey, label, fields: object.fields, edges: object.edges, views: object.views, contentHash: sha256Hex(canonicalJson(hashInput)) };
  }

  finish(): ObjectGraph {
    const names = [...new Set([...this.omitted.keys(), ...this.unknownOmissions])].sort();
    const omitted = Object.fromEntries(names.map((name) => [name, this.unknownOmissions.has(name) ? { known: false, count: null } : { known: true, count: this.omitted.get(name) as number }]));
    const completeness: Json = names.length === 0 ? { status: "complete" } : { status: "partial", omitted };
    return new ObjectGraph({
      schemaVersion: "paneweft.object-graph/1",
      captureId: this.options.captureId,
      runId: this.options.runId,
      invocationId: this.options.invocationId,
      roots: this.rootIds,
      objects: this.objects.map((_, index) => this.objectJson(index)),
      views: this.viewRecords,
      pages: this.pageRecords,
      diagnostics: this.diagnosticRecords as unknown as Json,
      limits: { ...this.limits },
      completeness,
    });
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
