// ViewerSource over a Session in-process: the server answers its HTTP routes from it, and tests mount the viewer on it.
import type { Entity, EntityRef } from "../core/wire.ts";
import { err, ok, type Result } from "../core/errors.ts";
import { checkFreshness } from "../core/freshness.ts";
import { resolveItemSource } from "../core/links.ts";
import { rankViews, type RankOutput } from "../core/registry.ts";
import { searchSession } from "../core/search.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { SearchHit, ViewerSource, ViewModel } from "./source.ts";

const sameEntity = (a: EntityRef, b: EntityRef): boolean => a.repository === b.repository && a.kind === b.kind && a.id === b.id;

export function createSessionSource(session: Session): ViewerSource {
  const viewsOf = async (entity: EntityRef, snapshotId: string) => {
    const found: Array<{ key: ViewKey; definitionId: string; completeness: ViewModel["envelope"]["completeness"] }> = [];
    for (const key of await session.listViews()) {
      if (key.snapshotId !== snapshotId) continue;
      const stored = await session.getView(key);
      if (stored.ok && sameEntity(stored.value.envelope.entity, entity)) found.push({ key, definitionId: stored.value.envelope.viewDefinitionId, completeness: stored.value.envelope.completeness });
    }
    return found;
  };

  const getView = async (key: ViewKey): Promise<Result<ViewModel>> => {
    const stored = await session.getView(key);
    if (!stored.ok) return stored;
    const { envelope, contentHash } = stored.value;
    const freshness = await checkFreshness(envelope.freshness, await session.repositories());
    if (envelope.component !== "notebook") return ok({ envelope, freshness, contentHash });
    const page = await session.notebookGet(envelope.id, undefined, envelope.snapshotId);
    return ok({ envelope, freshness, contentHash, notebookRevision: page.ok ? page.value.revision : 1 });
  };

  return {
    getEntity: (entity, snapshotId) => session.getEntity(entity, snapshotId),
    async applicableViews(entity, snapshotId, preferredViewDefinitionId): Promise<Result<RankOutput>> {
      const found: Result<Entity> = await session.getEntity(entity, snapshotId);
      if (!found.ok) return found;
      const { definitions } = await session.listDefinitions();
      const instances = (await viewsOf(entity, snapshotId)).map(({ definitionId, completeness }) => ({ definitionId, completeness }));
      return ok(rankViews({ entity: found.value, definitions, instances, ...(preferredViewDefinitionId === undefined ? {} : { preferredViewDefinitionId }) }));
    },
    async getViewFor(entity, snapshotId, definitionId) {
      const match = (await viewsOf(entity, snapshotId)).find((view) => view.definitionId === definitionId);
      if (match === undefined) return err("NOT_FOUND", `no view of definition "${definitionId}" for ${entity.kind}/${entity.id} in snapshot "${snapshotId}"`);
      return getView(match.key);
    },
    getView,
    async openItemSource(key, itemId) {
      return ok(await resolveItemSource(session, key, itemId));
    },
    async search(query, scope): Promise<Result<SearchHit[]>> {
      const documents = await searchSession(session, query, scope);
      return ok(documents.map((document): SearchHit => ({
        type: document.type, id: document.id, text: document.text, snapshotId: document.snapshotId,
        ...(typeof document.extra.viewId === "string" ? { viewId: document.extra.viewId } : {}),
        ...(typeof document.extra.itemId === "string" ? { itemId: document.extra.itemId } : {}),
        ...(document.extra.entity === undefined ? {} : { entity: document.extra.entity as EntityRef }),
      })));
    },
    updateNotebook: (pageId, expectedRevision, blocks, snapshotId) => session.notebookUpdate(pageId, expectedRevision, { blocks }, snapshotId),
  };
}
