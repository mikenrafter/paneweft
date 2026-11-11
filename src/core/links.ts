// Cross-view links and evidence (design section 3, MC8): exact addressing by snapshot, view
// instance and optional item. Navigation never silently mixes snapshots; a missing target is a
// named unresolved result, never the newest snapshot.
import type { EntityRef, Source } from "./wire.ts";
import type { Session, ViewKey } from "./session.ts";
import type { NumberedLine } from "./anchors.ts";

export type LinkTarget =
  | { snapshotId: string; viewId: string; itemId?: string }
  | { snapshotId: string; entity: EntityRef; preferredViewDefinitionId?: string };

export type LinkResolution =
  | {
      status: "resolved";
      snapshotId: string;
      viewId?: string;
      itemId?: string;
      entity?: EntityRef;
      viewDefinitionId?: string;
      fallback?: { requested: string; used: string; reason: string };
    }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; missing: "snapshot" | "view" | "item" | "entity"; message: string };

/** STUB. */
export async function resolveLink(_session: Session, _target: LinkTarget): Promise<LinkResolution> {
  return { status: "unresolved", code: "UNRESOLVED_TARGET", missing: "view", message: "resolveLink is not implemented" };
}

export type SourceOpening =
  | {
      status: "resolved";
      repository: string;
      revision: string | null;
      path: string;
      highlight: [number, number];
      stored: { viewId: string; snapshotId: string; lines: NumberedLine[] };
      currency: { state: "fresh" | "stale" | "unknown"; recordedSha256: string | null; currentSha256: string | null };
    }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; message: string };

/**
 * Opens the stored excerpt that covers the item's anchor (an item with an `anchor`, or a source
 * view's annotation). `currency` compares the recorded file hash with the registered root's bytes.
 * STUB.
 */
export async function resolveItemSource(_session: Session, _key: ViewKey, _itemId: string): Promise<SourceOpening> {
  return { status: "unresolved", code: "UNRESOLVED_TARGET", message: "resolveItemSource is not implemented" };
}

/** S11: evidence cites a declared source of the claim's view as well as items of views. */
export type SourceTarget = { snapshotId: string; viewId: string; sourceId: string };
export type SourceResolution =
  | { status: "resolved"; sourceId: string; source: Source }
  | { status: "unresolved"; code: "UNRESOLVED_TARGET"; missing: "source"; message: string };
export type EvidenceStep =
  | { relation: "supports" | "contradicts"; target: LinkTarget; resolution: LinkResolution }
  | { relation: "supports" | "contradicts"; target: SourceTarget; resolution: SourceResolution };
/**
 * Resolves every supports/contradicts target of a notebook claim block, in declared order (source ids and
 * `{viewId,itemId}` targets interleaved exactly as the claim lists them; supports first, then contradicts). STUB.
 */
export async function resolveClaimEvidence(_session: Session, _key: ViewKey, _claimBlockId: string): Promise<EvidenceStep[]> {
  return [];
}
