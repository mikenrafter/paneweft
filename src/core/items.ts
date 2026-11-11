// The Items (facts) of a view in document order, per component (design section 2, "Shared item notation").
// Reason: the validator, the session, link resolution, search and the operations all ask "which facts does this view hold";
//   one function answers it so they cannot disagree about what counts as an item.
// Invariants: pure; the order is the order in which ids share one namespace (val.md Q7): list rows | tree nodes | graph nodes then
//   edges | source excerpt then annotations | shape fields | notebook blocks | example scenario, runs, then every run's assertions.
import type { Envelope } from "./wire.ts";

/** An Item as the generic code sees it: the members every item has plus whatever its component adds. */
export interface AnyItem {
  id: string;
  provenance: "read" | "parsed" | "compiled" | "observed" | "inferred";
  evidence: string[];
  label?: string;
  anchor?: { repository: string; path: string; lines: [number, number] };
  entity?: { repository: string; id: string; kind: string };
  reason?: string;
  basis?: string[];
  [member: string]: unknown;
}

export function viewItems(envelope: Envelope): AnyItem[] {
  const data = envelope.data as Record<string, unknown> | undefined;
  if (data === undefined) return [];
  const list = (value: unknown): AnyItem[] => (Array.isArray(value) ? (value as AnyItem[]) : []);
  switch (envelope.component) {
    case "list": return list(data.rows);
    case "tree": return list(data.nodes);
    case "graph": return [...list(data.nodes), ...list(data.edges)];
    case "source": return [data.excerpt as AnyItem, ...list(data.annotations)];
    case "shape": return list(data.fields);
    case "notebook": return list(data.blocks);
    case "example": {
      const runs = list(data.runs);
      return [data.scenario as AnyItem, ...runs, ...runs.flatMap((run) => list(run.assertions))];
    }
  }
}

/** Whether `kind` of component stores its items per unit shown in replies (rows, nodes, edges, ...): the unit name of the counts line. */
export const UNIT_OF_COMPONENT: Record<Envelope["component"], string> = {
  list: "rows", tree: "nodes", graph: "edges", source: "lines", shape: "fields", notebook: "blocks", example: "runs",
};

/**
 * The snapshot a notebook reference points at. A `{viewId, itemId}` target or a view block names a view only; the notebook's recorded
 * `links` say in which snapshot that view lives (a story page can cite views of two repository snapshots). Without a link the
 * notebook's own snapshot is meant.
 */
export function referencedSnapshot(envelope: Envelope, viewId: string, itemId?: string): string {
  const links = envelope.links.filter((candidate) => candidate.viewId === viewId);
  const exact = itemId === undefined ? undefined : links.find((candidate) => candidate.itemId === itemId);
  return (exact ?? links.find((candidate) => candidate.itemId === undefined) ?? links[0])?.snapshotId ?? envelope.snapshotId;
}
