// View applicability and ordering for an entity (design section 3, MC12). Pure.
//
// Rules: exact entity-kind match only (no inheritance, no executable predicates); the `*`
// built-ins are always appended after exact-kind views; order is ascending priority (default 50)
// then definition id by code-unit order; availability is available | needs_data(missing roles) |
// unsupported(reason); an available preferred view wins, an unavailable one falls back visibly.
import type { Entity, Envelope, ViewDefinition } from "./wire.ts";

export type Availability =
  | { status: "available" }
  | { status: "needs_data"; missingRoles: string[] }
  | { status: "unsupported"; reason: string };

export interface RankedView {
  definitionId: string;
  title: string;
  priority: number;
  component: string;
  availability: Availability;
  /** true for the built-in `*` views */
  fallback: boolean;
}
export interface ViewInstanceInfo { definitionId: string; completeness: Envelope["completeness"] }
export interface RankInput {
  entity: Entity;
  definitions: ViewDefinition[];
  instances: ViewInstanceInfo[];
  preferredViewDefinitionId?: string;
}
export interface RankOutput {
  views: RankedView[];
  selected: { definitionId: string; fallbackFrom?: { requested: string; reason: string } } | null;
}

export const BUILTIN_VIEW_IDS = ["builtin:metadata", "builtin:raw"] as const;

/** STUB. */
export function rankViews(_input: RankInput): RankOutput {
  return { views: [], selected: null };
}
