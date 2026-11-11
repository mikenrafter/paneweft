// ViewerSource over a Session in-process: the server answers its HTTP routes from it, and tests mount the viewer on it.
import type { Entity, EntityRef } from "../core/wire.ts";
import { err, ok, type Result } from "../core/errors.ts";
import { checkFreshness } from "../core/freshness.ts";
import { readEffectiveView } from "../core/example-runs.ts";
import { resolveItemSource } from "../core/links.ts";
import { rankViews, type RankOutput } from "../core/registry.ts";
import { viewItems } from "../core/items.ts";
import { searchSession } from "../core/search.ts";
import { withStoredPages } from "../v1/pages.ts";
import type { Session, SessionReader, ViewKey } from "../core/session.ts";
import type { SearchHit, ViewerSource, ViewModel } from "./source.ts";

const sameEntity = (a: EntityRef, b: EntityRef): boolean => a.repository === b.repository && a.kind === b.kind && a.id === b.id;

export function createSessionSource(session: Session): ViewerSource {
  const viewsOf = async (read: SessionReader, entity: EntityRef, snapshotId: string) =>
    (await read.listViewIndex(snapshotId))
      .filter((view) => sameEntity(view.entity, entity))
      .map((view) => ({ key: { viewId: view.viewId, snapshotId: view.snapshotId }, definitionId: view.viewDefinitionId, completeness: view.completeness }));

  const getView = async (key: ViewKey): Promise<Result<ViewModel>> => {
    const read = await readEffectiveView(session, key);
    if (!read.ok) return read;
    const { recorded } = read.value;
    // a v1 list keeps its rows beyond the first page in stored pages; the viewer shows them all (S11)
    const envelope = await withStoredPages(session, read.value.envelope);
    const { contentHash } = read.value.stored;
    const freshness = await checkFreshness(envelope.freshness, await session.repositories());
    if (recorded !== undefined) {
      return ok({ envelope, freshness, contentHash, recordedRuns: { runs: [...recorded.byItemId].map(([itemId, run]) => ({ itemId, ...run })), notice: recorded.notice } });
    }
    if (envelope.component !== "notebook") return ok({ envelope, freshness, contentHash });
    const page = await session.notebookGet(envelope.id, undefined, envelope.snapshotId);
    return ok({ envelope, freshness, contentHash, notebookRevision: page.ok ? page.value.revision : 1 });
  };

  return {
    getEntity: (entity, snapshotId) => session.getEntity(entity, snapshotId),
    async applicableViews(entity, snapshotId, preferredViewDefinitionId): Promise<Result<RankOutput>> {
      const read = await session.snapshot(); // one manifest read for the entity, the definitions and the views
      const found: Result<Entity> = await read.getEntity(entity, snapshotId);
      if (!found.ok) return found;
      const { definitions } = await read.listDefinitions();
      const instances = (await viewsOf(read, entity, snapshotId)).map(({ definitionId, completeness }) => ({ definitionId, completeness }));
      return ok(rankViews({ entity: found.value, definitions, instances, ...(preferredViewDefinitionId === undefined ? {} : { preferredViewDefinitionId }) }));
    },
    async getViewFor(entity, snapshotId, definitionId) {
      const match = (await viewsOf(await session.snapshot(), entity, snapshotId)).find((view) => view.definitionId === definitionId);
      if (match === undefined) return err("NOT_FOUND", `no view of definition "${definitionId}" for ${entity.kind}/${entity.id} in snapshot "${snapshotId}"`);
      return getView(match.key);
    },
    getView,
    async findExample(exampleId, snapshotId) {
      for (const key of (await session.listViews()).filter((candidate) => candidate.snapshotId === snapshotId)) {
        const model = await getView(key);
        if (model.ok && model.value.envelope.component === "example" && (key.viewId === exampleId || viewItems(model.value.envelope).some((item) => item.id === exampleId))) return model;
      }
      return err("NOT_FOUND", `no example "${exampleId}" in snapshot "${snapshotId}"`);
    },
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
