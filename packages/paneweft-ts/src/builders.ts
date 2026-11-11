// Context-owned, bounded builders (spec amendment S5): row() stops accepting at the limit and returns the omission count;
// exhaustion gives partial output, never a failed view.
import type { Bounded, Direction, Json, ObjectRef } from "./types.ts";
import type { CapturedValue } from "./values.ts";

export interface BuiltView {
  readonly kind: "built";
  readonly component: "shape" | "list";
  readonly data: Json;
}
export interface UnsupportedView {
  readonly kind: "unsupported";
  readonly reason: string;
}
export type ViewResult = BuiltView | UnsupportedView;

export interface RowSpec {
  id: string;
  cells: Record<string, CapturedValue>;
  target?: ObjectRef;
}

export class DetailsBuilder {
  /** Fluent. When the builder is full the field is refused and counted; the omission shows in the view's completeness. */
  field(name: string, value: CapturedValue): this {
    return this;
  }
  done(): ViewResult {
    return { kind: "unsupported", reason: "NOT_IMPLEMENTED: DetailsBuilder.done" };
  }
}

export class TableBuilder {
  textColumn(key: string, title: string): this {
    return this;
  }
  numberColumn(key: string, title: string): this {
    return this;
  }
  booleanColumn(key: string, title: string): this {
    return this;
  }
  /** Records the order and sorts rows by that column, stable (equal keys keep insertion order). */
  orderBy(key: string, direction: Direction): this {
    return this;
  }
  row(spec: RowSpec): Bounded {
    return { accepted: true };
  }
  done(): ViewResult {
    return { kind: "unsupported", reason: "NOT_IMPLEMENTED: TableBuilder.done" };
  }
}
