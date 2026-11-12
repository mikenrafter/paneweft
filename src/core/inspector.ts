// Pane navigation as a pure reducer (design section 3). The browser and tests drive it; the
// MCP open_entity/navigate operations are its stateless counterpart (pane state is passed back).
//
// Rules (docs/red-contract.md "Inspector reducer" is normative):
//  - state = { trail (root->leaf), retained (pinned panes displaced from the trail), past (history) }.
//  - Any action that changes {trail, retained} pushes the previous {trail, retained} onto `past`.
//  - select(i, item): selection of pane i becomes [item]; unpinned descendants are dropped, pinned
//    descendants move to `retained`; if the item has a target entity a pane for it is appended,
//    in the SAME snapshot (navigation never mixes snapshots).
//  - Expanding a tree row is not an inspector action: it never creates a pane.
//  - back restores the previous {trail, retained}.
//
// CLAIM(navigation-pure): the reducer never mutates its arguments and reads the outside world only through `InspectorWorld`;
//   a refused action returns the same state object with a notice naming what was refused [inspector.test.ts, MC7].
import type { EntityRef } from "./wire.ts";
import { canonicalJson } from "./canonical.ts";
import { notCapturedMessage } from "./not-captured.ts";

export type PaneFilters = Record<string, string | number | boolean | string[]>;
export interface PaneState {
  entity: EntityRef;
  snapshotId: string;
  viewDefinitionId: string;
  selection: string[];
  filters: PaneFilters;
  pinned: boolean;
}
export interface InspectorFrame { trail: PaneState[]; retained: PaneState[] }
export interface InspectorState extends InspectorFrame { past: InspectorFrame[] }

export type InspectorAction =
  | { type: "open"; entity: EntityRef; snapshotId: string; viewDefinitionId?: string }
  | { type: "openFromPane"; paneIndex: number; entity: EntityRef; snapshotId: string }
  | { type: "select"; paneIndex: number; itemId: string }
  | { type: "switchView"; paneIndex: number; viewDefinitionId: string }
  | { type: "pin"; paneIndex: number }
  | { type: "back" };

export type ItemTarget = { kind: "entity"; entity: EntityRef } | { kind: "none" } | { kind: "not-captured"; reason: string } | { kind: "missing" };

/** The data the reducer needs; backed by a Session in production and by literals in tests. */
export interface InspectorWorld {
  /** First applicable view definition for the entity, honouring an explicit preference; undefined if none. */
  initialView(entity: EntityRef, snapshotId: string, preferredViewDefinitionId?: string): string | undefined;
  hasView(entity: EntityRef, snapshotId: string, viewDefinitionId: string): boolean;
  itemTarget(entity: EntityRef, snapshotId: string, viewDefinitionId: string, itemId: string): ItemTarget;
  itemExists(entity: EntityRef, snapshotId: string, viewDefinitionId: string, itemId: string): boolean;
}

export type InspectorNoticeCode = "NO_TARGET" | "NOT_CAPTURED" | "NO_SUCH_PANE" | "UNRESOLVED_TARGET" | "UNKNOWN_VIEW" | "NOTHING_TO_GO_BACK" | "UNKNOWN_ACTION";
export interface InspectorOutcome { state: InspectorState; notice?: { code: InspectorNoticeCode; message: string } }

export function initialInspectorState(): InspectorState {
  return { trail: [], retained: [], past: [] };
}

const frameOf = (state: InspectorFrame): InspectorFrame => ({ trail: state.trail, retained: state.retained });
const sameFrame = (a: InspectorFrame, b: InspectorFrame): boolean => canonicalJson(frameOf(a)) === canonicalJson(frameOf(b));
const freshPane = (entity: EntityRef, snapshotId: string, viewDefinitionId: string): PaneState => ({ entity, snapshotId, viewDefinitionId, selection: [], filters: {}, pinned: false });

/** Commits a new frame; history grows only when the frame really changed. */
function commit(state: InspectorState, next: InspectorFrame, notice?: InspectorOutcome["notice"]): InspectorOutcome {
  const changed = !sameFrame(state, next);
  const result: InspectorState = changed ? { trail: next.trail, retained: next.retained, past: [...state.past, frameOf(state)] } : state;
  return notice === undefined ? { state: result } : { state: result, notice };
}
const refuse = (state: InspectorState, code: InspectorNoticeCode, message: string): InspectorOutcome => ({ state, notice: { code, message } });

/** Panes cut off the trail: pinned ones are kept (appended to `retained`), the rest are dropped. */
const keepPinned = (retained: PaneState[], cut: PaneState[]): PaneState[] => [...retained, ...cut.filter((pane) => pane.pinned)];

export function reduceInspector(state: InspectorState, action: InspectorAction, world: InspectorWorld): InspectorOutcome {
  switch (action.type) {
    case "open": {
      const preferred = action.viewDefinitionId;
      const view = preferred !== undefined && world.hasView(action.entity, action.snapshotId, preferred)
        ? preferred
        : world.initialView(action.entity, action.snapshotId);
      if (view === undefined) return refuse(state, "UNKNOWN_VIEW", `no view applies to entity ${action.entity.id} in snapshot ${action.snapshotId}`);
      return commit(state, { trail: [freshPane(action.entity, action.snapshotId, view)], retained: keepPinned(state.retained, state.trail) });
    }
    case "openFromPane": {
      const pane = state.trail[action.paneIndex];
      if (pane === undefined || pane.snapshotId !== action.snapshotId) return refuse(state, "NO_SUCH_PANE", "the source pane no longer holds the renderer's bound snapshot");
      const view = world.initialView(action.entity, action.snapshotId);
      if (view === undefined) return refuse(state, "UNKNOWN_VIEW", `no view applies to entity ${action.entity.id}`);
      const kept = state.trail.slice(0, action.paneIndex + 1);
      return commit(state, { trail: [...kept, freshPane(action.entity, action.snapshotId, view)], retained: keepPinned(state.retained, state.trail.slice(action.paneIndex + 1)) });
    }
    case "select": {
      const pane = state.trail[action.paneIndex];
      if (!Number.isInteger(action.paneIndex) || pane === undefined) return refuse(state, "NO_SUCH_PANE", `there is no pane ${action.paneIndex}`);
      const target = world.itemTarget(pane.entity, pane.snapshotId, pane.viewDefinitionId, action.itemId);
      if (target.kind === "missing") return refuse(state, "UNRESOLVED_TARGET", `item ${action.itemId} does not exist in view ${pane.viewDefinitionId} of ${pane.entity.id}`);
      const kept = state.trail.slice(0, action.paneIndex + 1).map((entry, position) => (position === action.paneIndex ? { ...entry, selection: [action.itemId] } : entry));
      const retained = keepPinned(state.retained, state.trail.slice(action.paneIndex + 1));
      if (target.kind === "not-captured") return commit(state, { trail: kept, retained }, { code: "NOT_CAPTURED", message: notCapturedMessage(action.itemId, target.reason) });
      if (target.kind === "none") return commit(state, { trail: kept, retained }, { code: "NO_TARGET", message: `item ${action.itemId} has no entity to open` });
      const view = world.initialView(target.entity, pane.snapshotId);
      if (view === undefined) return commit(state, { trail: kept, retained }, { code: "UNKNOWN_VIEW", message: `no view applies to entity ${target.entity.id} in snapshot ${pane.snapshotId}` });
      return commit(state, { trail: [...kept, freshPane(target.entity, pane.snapshotId, view)], retained });
    }
    case "switchView": {
      const pane = state.trail[action.paneIndex];
      if (!Number.isInteger(action.paneIndex) || pane === undefined) return refuse(state, "NO_SUCH_PANE", `there is no pane ${action.paneIndex}`);
      if (!world.hasView(pane.entity, pane.snapshotId, action.viewDefinitionId)) return refuse(state, "UNKNOWN_VIEW", `entity ${pane.entity.id} has no view ${action.viewDefinitionId}`);
      const selection = pane.selection.filter((itemId) => world.itemExists(pane.entity, pane.snapshotId, action.viewDefinitionId, itemId));
      const trail = state.trail.map((entry, position) => (position === action.paneIndex ? { ...entry, viewDefinitionId: action.viewDefinitionId, selection } : entry));
      return commit(state, { trail, retained: state.retained });
    }
    case "pin": {
      const pane = state.trail[action.paneIndex];
      if (!Number.isInteger(action.paneIndex) || pane === undefined) return refuse(state, "NO_SUCH_PANE", `there is no pane ${action.paneIndex}`);
      if (pane.pinned) return { state };
      return commit(state, { trail: state.trail.map((entry, position) => (position === action.paneIndex ? { ...entry, pinned: true } : entry)), retained: state.retained });
    }
    case "back": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return refuse(state, "NOTHING_TO_GO_BACK", "there is no earlier pane state to return to");
      return { state: { trail: previous.trail, retained: previous.retained, past: state.past.slice(0, -1) } };
    }
    default: {
      const unknown = action as { type?: unknown };
      return refuse(state, "UNKNOWN_ACTION", `unknown inspector action ${String(unknown.type)}`);
    }
  }
}
