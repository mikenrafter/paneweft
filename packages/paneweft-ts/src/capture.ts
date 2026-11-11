// Capture context, type tokens, the symbol protocol and object publication (spec sections 2 and 4; docs/v1-red-contract.md 3-5).
//
// A capture assigns an object id on publication (registration order, never an identity of an allocation), then computes the object's
// views and follows the references the views declare. Everything is bounded while it is built: a bound that bites yields a
// not-captured reference and a named omission, never an error and never silence.
import { Budget, DetailsBuilder, TableBuilder, canonicalJson, sha256Hex, type ViewResult } from "./builders.ts";
import { callerLine } from "./callsite.ts";
import { applyLimitOverrides, defaultLimits } from "./limits.ts";
import { ViewError, type Component, type DiagnosticRecord, type Json, type Limits, type ObjectRef } from "./types.ts";
import { cutString, encodeValue, type CapturedValue, type EncodeStats } from "./values.ts";

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
}

type Bound = "depth" | "objects" | "references" | "rootBytes" | "collectionBytes" | "roots";
const BOUND_REASON: Record<Bound, string> = { depth: "depth-limit", objects: "object-limit", references: "reference-limit", rootBytes: "root-bytes-limit", collectionBytes: "collection-limit", roots: "collection-limit" };

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
    return new DetailsBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs));
  }
  table(): TableBuilder {
    return new TableBuilder(this.capture.limits, new Budget(this.capture.nested, this.capture.limits.viewBudgetMs));
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
    const stats: EncodeStats = { strings: 0 };
    const encoded = encodeValue(value, this.capture.limits, stats);
    this.capture.count("strings", stats.strings);
    (this.capture.objectAt(this.index).fields)[name] = encoded;
  }
  label(text: string): void {
    this.capture.objectAt(this.index).label = text;
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
  private bytesRoot = 0;
  private bytesTotal = 0;

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
    this.diagnosticRecords.push({ id, category: known, message: cutString(message, 2000)[0], ...(extra.viewId === undefined ? {} : { viewId: extra.viewId }), ...(extra.exampleId === undefined ? {} : { exampleId: extra.exampleId }), nextAction: NEXT_ACTION[known] ?? "Read the message, fix the named source, then recollect the example." });
    return id;
  }

  /** True when a diagnostic makes the capture failed (a view fault; bounds and notes do not). */
  hasFault(): boolean {
    return this.diagnosticRecords.some((d) => ["view-exception", "output-schema", "reference", "registration"].includes(d.category));
  }

  private refusal(parentDepth: number | undefined): Bound | undefined {
    const limits = this.limits;
    if (parentDepth !== undefined && this.references >= limits.references) return "references";
    if (parentDepth !== undefined && parentDepth + 1 > limits.depth) return "depth";
    if (this.objects.length >= limits.objects) return "objects";
    if (parentDepth === undefined && this.rootIds.length >= limits.roots) return "roots";
    if (parentDepth !== undefined && this.bytesRoot >= limits.rootBytes) return "rootBytes";
    if (this.bytesTotal >= limits.collectionBytes) return "collectionBytes";
    return undefined;
  }

  private refuse(parent: { index: number; name: string } | undefined, bound: Bound): ObjectRef {
    this.count(bound, 1);
    if (parent !== undefined) this.objectAt(parent.index).edges.push({ name: parent.name, kind: "not-captured", reason: BOUND_REASON[bound] });
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
        this.references += 1;
        this.objectAt(parent.index).edges.push({ name: parent.name, kind: this.path.includes(existing) ? "cycle" : "alias", target: id });
      }
      return { object: id };
    }
    const parentDepth = parent === undefined ? undefined : this.objectAt(parent.index).depth;
    const bound = this.refusal(parentDepth);
    if (bound !== undefined) return this.refuse(parent, bound);

    const index = this.objects.length;
    const id = `o${index + 1}`;
    const context = new ObjectContext(this, index);
    const selection = this.select(value, token, context);
    this.objects.push({ id, typeId: selection.type.id, domainKey: key ?? null, label: undefined, fields: {}, edges: [], views: [], depth: parentDepth === undefined ? 0 : parentDepth + 1 });
    if (trackable) this.byObject.set(value, index);
    if (identity !== undefined) this.byToken.set(identity, index);
    if (parent === undefined) {
      this.rootIds.push(id);
      this.bytesRoot = 0;
    } else {
      this.references += 1;
      this.objectAt(parent.index).edges.push({ name: parent.name, kind: "child", target: id });
    }
    this.path.push(index);
    try {
      for (const definition of selection.views) this.computeView(index, context, value, definition);
    } finally {
      this.path.pop();
    }
    const size = JSON.stringify(this.objectJson(index)).length;
    this.bytesRoot += size;
    this.bytesTotal += size;
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
      this.addDiagnostic(category, message, { viewId: definition.id });
      return;
    } finally {
      context.currentView = undefined;
    }
    this.recordView(index, definition, result, context.viewBestEffort || context.anyBestEffort);
  }

  private recordView(index: number, definition: ViewDefinition<any>, result: ViewResult, bestEffort: boolean): void {
    const object = this.objectAt(index);
    if (result === null || typeof result !== "object" || (result.kind !== "built" && result.kind !== "unsupported")) {
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
    const size = JSON.stringify(record).length;
    this.bytesRoot += size;
    this.bytesTotal += size;
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
    const omitted = Object.fromEntries([...this.omitted.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => [name, { known: true, count }]));
    const completeness: Json = this.omitted.size === 0 ? { status: "complete" } : { status: "partial", omitted };
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

const ACTIVE: Capture[] = [];

export function activateCapture(capture: Capture): void {
  ACTIVE.push(capture);
}
export function deactivateCapture(): Capture | undefined {
  return ACTIVE.pop();
}

/** Publishes at an execution point. With no active collector it returns `inactive` and does no traversal. */
export function inspect(value: unknown, token?: TypeToken<any>): InspectResult {
  const capture = ACTIVE[ACTIVE.length - 1];
  if (capture === undefined) return { status: "inactive" };
  return capture.publish(value, token);
}

/** Runs `body` with a new Capture as the active collector and returns what it published. */
export function withCapture(options: CaptureOptions, body: () => void): ObjectGraph {
  const capture = new Capture(options);
  activateCapture(capture);
  try {
    body();
  } finally {
    deactivateCapture();
  }
  return capture.finish();
}
