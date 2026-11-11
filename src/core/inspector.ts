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
import type { EntityRef } from "./wire.ts";

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
  | { type: "select"; paneIndex: number; itemId: string }
  | { type: "switchView"; paneIndex: number; viewDefinitionId: string }
  | { type: "pin"; paneIndex: number }
  | { type: "back" };

export type ItemTarget = { kind: "entity"; entity: EntityRef } | { kind: "none" } | { kind: "missing" };

/** The data the reducer needs; backed by a Session in production and by literals in tests. */
export interface InspectorWorld {
  /** First applicable view definition for the entity, honouring an explicit preference; undefined if none. */
  initialView(entity: EntityRef, snapshotId: string, preferredViewDefinitionId?: string): string | undefined;
  hasView(entity: EntityRef, snapshotId: string, viewDefinitionId: string): boolean;
  itemTarget(entity: EntityRef, snapshotId: string, viewDefinitionId: string, itemId: string): ItemTarget;
  itemExists(entity: EntityRef, snapshotId: string, viewDefinitionId: string, itemId: string): boolean;
}

export type InspectorNoticeCode = "NO_TARGET" | "NO_SUCH_PANE" | "UNRESOLVED_TARGET" | "UNKNOWN_VIEW" | "NOTHING_TO_GO_BACK";
export interface InspectorOutcome { state: InspectorState; notice?: { code: InspectorNoticeCode; message: string } }

export function initialInspectorState(): InspectorState {
  return { trail: [], retained: [], past: [] };
}

/** STUB: returns the state unchanged with a notice. */
export function reduceInspector(state: InspectorState, _action: InspectorAction, _world: InspectorWorld): InspectorOutcome {
  return { state, notice: { code: "UNRESOLVED_TARGET", message: "reduceInspector is not implemented" } };
}
