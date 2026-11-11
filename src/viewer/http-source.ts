// ViewerSource over the viewer server's HTTP API, for the browser bundle. Nothing here imports a Node module.
import type { Entity, EntityRef } from "../core/wire.ts";
import { err, ok, type OperationError, type Result } from "../core/errors.ts";
import type { SourceOpening } from "../core/links.ts";
import type { NotebookPage, ViewKey } from "../core/session.ts";
import type { RankOutput } from "../core/registry.ts";
import type { SearchHit, ViewerSource, ViewModel } from "./source.ts";

interface IndexBody { views: Array<{ viewId: string; snapshotId: string; viewDefinitionId: string; entity: EntityRef }> }
interface SourceBody {
  currency: "current" | "stale" | "unknown";
  numberedLines: Array<{ n: number; text: string }>;
  highlight: [number, number];
  revision: string | null;
  repository: string;
  path: string;
  viewId: string;
  snapshotId: string;
  recordedSha256: string | null;
  currentSha256: string | null;
}

const isOperationError = (body: unknown): body is OperationError =>
  typeof body === "object" && body !== null && (body as { schemaVersion?: unknown }).schemaVersion === "paneweft.error/1";

export function createHttpSource(baseUrl: string, token: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): ViewerSource {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<Result<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (error) {
      return err("STORAGE_FAILED", `the viewer server could not be reached: ${String(error)}`, { retryable: true });
    }
    let body: unknown;
    try { body = await response.json(); } catch { return err("INTERNAL", `the viewer server answered ${response.status} with a body that is not JSON`); }
    if (response.ok) return ok(body as T);
    return isOperationError(body) ? { ok: false, error: body } : err("INTERNAL", `the viewer server answered ${response.status}`);
  }

  const entityQuery = (entity: EntityRef, snapshotId: string) =>
    `snapshot=${encodeURIComponent(snapshotId)}&repository=${encodeURIComponent(entity.repository)}&id=${encodeURIComponent(entity.id)}&kind=${encodeURIComponent(entity.kind)}`;
  const viewQuery = (key: ViewKey) => `viewId=${encodeURIComponent(key.viewId)}&snapshotId=${encodeURIComponent(key.snapshotId)}`;

  return {
    async getEntity(entity, snapshotId) {
      const read = await call<{ entity: Entity }>(`/api/entity?${entityQuery(entity, snapshotId)}`);
      return read.ok ? ok(read.value.entity) : read;
    },
    async applicableViews(entity, snapshotId, preferredViewDefinitionId) {
      const preferred = preferredViewDefinitionId === undefined ? "" : `&preferred=${encodeURIComponent(preferredViewDefinitionId)}`;
      const read = await call<{ views: RankOutput }>(`/api/entity?${entityQuery(entity, snapshotId)}${preferred}`);
      return read.ok ? ok(read.value.views) : read;
    },
    async getViewFor(entity, snapshotId, definitionId) {
      const index = await call<IndexBody>("/api/index");
      if (!index.ok) return index;
      const match = index.value.views.find((view) => view.snapshotId === snapshotId && view.viewDefinitionId === definitionId
        && view.entity.repository === entity.repository && view.entity.kind === entity.kind && view.entity.id === entity.id);
      if (match === undefined) return err("NOT_FOUND", `no view of definition "${definitionId}" for ${entity.kind}/${entity.id} in snapshot "${snapshotId}"`);
      return call<ViewModel>(`/api/view?${viewQuery(match)}`);
    },
    getView: (key) => call<ViewModel>(`/api/view?${viewQuery(key)}`),
    async openItemSource(key, itemId): Promise<Result<SourceOpening>> {
      const read = await call<SourceBody>(`/api/source?${viewQuery(key)}&itemId=${encodeURIComponent(itemId)}`);
      if (!read.ok) {
        return read.error.code === "UNRESOLVED_TARGET" ? ok({ status: "unresolved", code: "UNRESOLVED_TARGET", message: read.error.message }) : read;
      }
      const body = read.value;
      return ok({
        status: "resolved",
        repository: body.repository,
        revision: body.revision,
        path: body.path,
        highlight: body.highlight,
        stored: { viewId: body.viewId, snapshotId: body.snapshotId, lines: body.numberedLines.filter((line) => line.n >= body.highlight[0] && line.n <= body.highlight[1]) },
        currency: { state: body.currency === "current" ? "fresh" : body.currency, recordedSha256: body.recordedSha256, currentSha256: body.currentSha256 },
      });
    },
    async search(query, scope) {
      const where = scope === undefined ? "" : `&${entityQuery(scope.entity, scope.snapshotId)}`;
      const read = await call<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}${where}`);
      return read.ok ? ok(read.value.hits) : read;
    },
    updateNotebook: (pageId, expectedRevision, blocks, snapshotId) =>
      call<NotebookPage>(`/api/notebooks/${encodeURIComponent(pageId)}/revisions`, { method: "POST", body: { ...(snapshotId === undefined ? {} : { snapshotId }), expectedRevision, blocks } }),
  };
}
