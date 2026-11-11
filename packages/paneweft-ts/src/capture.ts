// Capture context, type tokens, the symbol protocol and object publication (spec sections 2 and 4).
import { DetailsBuilder, TableBuilder, type ViewResult } from "./builders.ts";
import type { Component, DiagnosticRecord, Json, Limits, ObjectRef } from "./types.ts";
import type { CapturedValue } from "./values.ts";

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
      return { ...viewSpec, typeId: spec.id };
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
  | { status: "failed"; code: "NO_TYPE" | "NOT_IMPLEMENTED" | "VIEW_FAILED"; message: string };

/** The finished immutable result: a paneweft.object-graph/1 document. */
export interface ObjectGraph {
  toJSON(): Json;
}

export class Capture {
  constructor(options: CaptureOptions = {}) {}
  /** Publishes a root. Separate calls are separate observations unless `identity` names a capture-local token. */
  publish(value: unknown, token?: TypeToken<any>, options?: { key?: string; identity?: string }): InspectResult {
    return { status: "failed", code: "NOT_IMPLEMENTED", message: "NOT_IMPLEMENTED: Capture.publish" };
  }
  finish(): ObjectGraph {
    return { toJSON: () => ({}) };
  }
  get diagnostics(): DiagnosticRecord[] {
    return [];
  }
}

/** Publishes at an execution point. With no active collector it returns `inactive` and does no traversal. */
export function inspect(value: unknown, token?: TypeToken<any>): InspectResult {
  return { status: "failed", code: "NOT_IMPLEMENTED", message: "NOT_IMPLEMENTED: inspect" };
}

/** Runs `body` with a new Capture as the active collector and returns what it published. */
export function withCapture(options: CaptureOptions, body: () => void): ObjectGraph {
  body();
  return new Capture(options).finish();
}
