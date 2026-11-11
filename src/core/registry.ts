// View applicability and ordering for an entity (design section 3, MC12). Pure.
//
// Rules: exact entity-kind match only (no inheritance, no executable predicates); the `*`
// built-ins are always appended after exact-kind views; order is ascending priority (default 50)
// then definition id by code-unit order; availability is available | needs_data(missing roles) |
// unsupported(reason); an available preferred view wins, an unavailable one falls back visibly.
//
// CLAIM(rank-total): every entity gets at least one available view (the built-ins), so `selected` is never null for a real
//   entity and an empty registry still shows metadata and raw data [registry.test.ts, MC12].
import type { Entity, Envelope, ViewDefinition } from "./wire.ts";
import { compareCodeUnits } from "./canonical.ts";

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
export const DEFAULT_PRIORITY = 50;

/** The `*` fallback definitions: metadata and raw JSON, always available, after every exact-kind view. */
const BUILTINS: RankedView[] = [
  { definitionId: "builtin:metadata", title: "Metadata", priority: 1000, component: "shape", availability: { status: "available" }, fallback: true },
  { definitionId: "builtin:raw", title: "Raw", priority: 1001, component: "shape", availability: { status: "available" }, fallback: true },
];

function availabilityOf(definition: ViewDefinition, entity: Entity, instances: ViewInstanceInfo[]): Availability {
  const required = new Set([...definition.requires, definition.dataRole]);
  const present = new Set(entity.dataRoles);
  const missingRoles = [...required].filter((role) => !present.has(role)).sort(compareCodeUnits);
  if (missingRoles.length > 0) return { status: "needs_data", missingRoles };
  const instance = instances.find((candidate) => candidate.definitionId === definition.id);
  if (instance?.completeness.status === "unsupported") return { status: "unsupported", reason: instance.completeness.reason };
  return { status: "available" };
}

export function rankViews(input: RankInput): RankOutput {
  const exact: RankedView[] = input.definitions
    .filter((definition) => definition.entityKind === input.entity.kind)
    .map((definition) => ({
      definitionId: definition.id,
      title: definition.title,
      priority: definition.priority ?? DEFAULT_PRIORITY,
      component: definition.component,
      availability: availabilityOf(definition, input.entity, input.instances),
      fallback: false,
    }))
    .sort((a, b) => a.priority - b.priority || compareCodeUnits(a.definitionId, b.definitionId));
  const views = [...exact, ...BUILTINS];
  const firstAvailable = views.find((view) => view.availability.status === "available");
  const requested = input.preferredViewDefinitionId;
  if (requested === undefined) return { views, selected: firstAvailable === undefined ? null : { definitionId: firstAvailable.definitionId } };
  const preferred = views.find((view) => view.definitionId === requested);
  if (preferred?.availability.status === "available") return { views, selected: { definitionId: preferred.definitionId } };
  if (firstAvailable === undefined) return { views, selected: null };
  const availability = preferred?.availability;
  const reason = availability === undefined
    ? `no view definition "${requested}" applies to ${input.entity.kind} ${input.entity.id}`
    : availability.status === "needs_data"
      ? `missing data roles: ${availability.missingRoles.join(", ")}`
      : availability.status === "unsupported" ? availability.reason : "unavailable";
  return { views, selected: { definitionId: firstAvailable.definitionId, fallbackFrom: { requested, reason } } };
}
