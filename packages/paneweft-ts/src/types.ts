// Shared wire-facing types of the TypeScript SDK. Shapes follow src/schemas/v1/object-graph.schema.json.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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

export type ObjectRef = { object: string } | { notCaptured: { reason: string } };
export type Bounded = { accepted: true } | { accepted: false; omittedSoFar: number };
export type Component = "shape" | "list";
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

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NOT_IMPLEMENTED: ${what}`);
    this.name = "NotImplementedError";
  }
}
