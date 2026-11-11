// Shared literal data for the inspector reducer suites (MC7): a tiny InspectorWorld built from a
// literal table, pane/state builders and deepFreeze.
//
// The world is a DATA FAKE OF THE REPOSITORY (which entities exist in which snapshot, which views they
// have, what each item points at). It is not a fake of the reducer: the unit under test is
// reduceInspector. The table is also read directly (not through the world functions) by the
// independent model in inspector.model.test.ts, so the model and the reducer reach the same data by
// two different routes.
import type { EntityRef } from "../../src/core/wire.ts";
import type { InspectorWorld, ItemTarget, PaneState } from "../../src/core/inspector.ts";

export const ENT = {
  A: { repository: "r", id: "A", kind: "t/a" },
  B: { repository: "r", id: "B", kind: "t/b" },
  C: { repository: "r", id: "C", kind: "t/c" },
  D: { repository: "r", id: "D", kind: "t/d" },
  /** Not present in any snapshot of the table. */
  Z: { repository: "r", id: "Z", kind: "t/z" },
} as const satisfies Record<string, EntityRef>;
export type EntityId = keyof typeof ENT;

/** item id -> id of the target entity, or null for an item without an entity. Absent = no such item. */
export type ItemTable = Record<string, EntityId | null>;
export interface EntityRow { initial: string; views: Record<string, ItemTable> }

// Table (derivation of every interesting behaviour is in the tests that use it):
//  s1: A has views va-list (initial) and va-graph; B has vb-list (initial), vb-tree; C has vc-list;
//      D has vd-list. a-x exists only in va-list, so switching A to va-graph drops a-x from a selection.
//      C's item c-a points back at A: entity relations are cyclic and that is legal (design section 3).
//  s2 (newer snapshot): B's initial view is vb-s2, and there is no D and no a-x. A navigation that
//      started in s1 must never land on s2's initial view of B.
export const WORLD_TABLE: Record<string, Record<string, EntityRow>> = {
  s1: {
    A: {
      initial: "va-list",
      views: {
        "va-list": { "a-b": "B", "a-x": "D", "a-c": "C", "a-none": null },
        "va-graph": { "a-b": "B", "a-c": "C" },
      },
    },
    B: { initial: "vb-list", views: { "vb-list": { "b-c": "C", "b-none": null }, "vb-tree": { "b-c": "C" } } },
    C: { initial: "vc-list", views: { "vc-list": { "c-a": "A" } } },
    D: { initial: "vd-list", views: { "vd-list": { "d-leaf": null } } },
  },
  s2: {
    A: { initial: "va-list", views: { "va-list": { "a-b": "B", "a-c": "C" } } },
    B: { initial: "vb-s2", views: { "vb-s2": { "b-c": "C" }, "vb-list": { "b-c": "C" } } },
    C: { initial: "vc-list", views: { "vc-list": { "c-a": "A" } } },
  },
};

export const ALL_ITEM_IDS = ["a-b", "a-x", "a-c", "a-none", "b-c", "b-none", "c-a", "d-leaf", "ghost"] as const;
export const ALL_VIEW_IDS = ["va-list", "va-graph", "vb-list", "vb-tree", "vb-s2", "vc-list", "vd-list", "ghost-view"] as const;

function row(entity: EntityRef, snapshotId: string): EntityRow | undefined {
  return WORLD_TABLE[snapshotId]?.[entity.id];
}

/** The literal-table world. initialView honours an explicit, available preference (InspectorWorld doc). */
export const WORLD: InspectorWorld = {
  initialView(entity, snapshotId, preferred) {
    const found = row(entity, snapshotId);
    if (found === undefined) return undefined;
    if (preferred !== undefined && preferred in found.views) return preferred;
    return found.initial;
  },
  hasView(entity, snapshotId, viewDefinitionId) {
    const found = row(entity, snapshotId);
    return found !== undefined && viewDefinitionId in found.views;
  },
  itemTarget(entity, snapshotId, viewDefinitionId, itemId): ItemTarget {
    const items = row(entity, snapshotId)?.views[viewDefinitionId];
    if (items === undefined || !(itemId in items)) return { kind: "missing" };
    const target = items[itemId];
    return target === null || target === undefined ? { kind: "none" } : { kind: "entity", entity: ENT[target] };
  },
  itemExists(entity, snapshotId, viewDefinitionId, itemId) {
    const items = row(entity, snapshotId)?.views[viewDefinitionId];
    return items !== undefined && itemId in items;
  },
};

/** Expected-value constructor for one pane (a literal-data builder, not logic). */
export function P(entityId: EntityId, snapshotId: string, viewDefinitionId: string, selection: string[] = [], pinned = false): PaneState {
  return { entity: ENT[entityId], snapshotId, viewDefinitionId, selection, filters: {}, pinned };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
