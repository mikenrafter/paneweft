// Search over a session (design section 4): entities, views, example scenarios and notebook claims, ranked exact > prefix > substring,
// then by kind, id and snapshot. Shared by the agent operation (paged) and the viewer source so both rank identically.
import type { EntityRef } from "./wire.ts";
import type { Session } from "./session.ts";
import { viewItems } from "./items.ts";
import { compareCodeUnits } from "./canonical.ts";

export const SEARCH_TYPES = ["entity", "view", "example", "claim"] as const;
export interface SearchScope { entity: EntityRef; snapshotId: string }
export interface SearchDocument { type: (typeof SEARCH_TYPES)[number]; id: string; snapshotId: string; texts: string[]; text: string; extra: Record<string, unknown> }

/** The matching documents, best first. */
export async function searchSession(session: Session, query: string, scope?: SearchScope): Promise<SearchDocument[]> {
  const documents: SearchDocument[] = [];
  const entities = await session.listEntities();
  const inScope = (snapshotId: string, ref: EntityRef): boolean => {
    if (scope === undefined) return true;
    if (snapshotId !== scope.snapshotId) return false;
    const same = (a: EntityRef, b: EntityRef) => a.repository === b.repository && a.kind === b.kind && a.id === b.id;
    const origin = entities.find((entity) => entity.snapshotId === snapshotId && same(entity, scope.entity));
    return same(ref, scope.entity) || (origin?.relations ?? []).some((relation) => same(relation.target, ref));
  };
  for (const entity of entities) {
    if (inScope(entity.snapshotId, entity)) documents.push({ type: "entity", id: entity.id, snapshotId: entity.snapshotId, texts: [entity.label], text: entity.label, extra: { entity: { repository: entity.repository, id: entity.id, kind: entity.kind } } });
  }
  for (const key of await session.listViews()) {
    const stored = await session.getView(key);
    if (!stored.ok) continue;
    const view = stored.value.envelope;
    if (!inScope(view.snapshotId, view.entity)) continue;
    documents.push({ type: "view", id: view.id, snapshotId: view.snapshotId, texts: [view.title, view.question], text: view.title, extra: { viewId: view.id, component: view.component } });
    if (view.component === "example" && view.data !== undefined) {
      const label = (view.data as { scenario: { label?: string; id: string } }).scenario.label ?? (view.data as { scenario: { id: string } }).scenario.id;
      documents.push({ type: "example", id: view.id, snapshotId: view.snapshotId, texts: [label], text: label, extra: { viewId: view.id } });
    }
    if (view.component === "notebook") {
      for (const block of viewItems(view)) {
        if (block.kind === "claim") documents.push({ type: "claim", id: block.id, snapshotId: view.snapshotId, texts: [String(block.statement)], text: String(block.statement), extra: { viewId: view.id, itemId: block.id } });
      }
    }
  }
  const needle = query.toLowerCase();
  const tierOf = (texts: string[]): number | null => {
    let best: number | null = null;
    for (const text of texts) {
      const lower = text.toLowerCase();
      const tier = lower === needle ? 0 : lower.startsWith(needle) ? 1 : lower.includes(needle) ? 2 : null;
      if (tier !== null && (best === null || tier < best)) best = tier;
    }
    return best;
  };
  return documents.flatMap((document) => { const tier = tierOf(document.texts); return tier === null ? [] : [{ document, tier }]; })
    .sort((a, b) => a.tier - b.tier || SEARCH_TYPES.indexOf(a.document.type) - SEARCH_TYPES.indexOf(b.document.type) || compareCodeUnits(a.document.id, b.document.id) || compareCodeUnits(a.document.snapshotId, b.document.snapshotId))
    .map(({ document }) => document);
}
