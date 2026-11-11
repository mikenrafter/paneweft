// What the browser needs from the core, as an interface so the same DOM code runs over a Session
// in-process (tests, server-side) and over HTTP in the browser.
import type { Entity, EntityRef, Envelope } from "../core/wire.ts";
import type { Result } from "../core/errors.ts";
import type { FreshnessResult } from "../core/freshness.ts";
import type { SourceOpening } from "../core/links.ts";
import type { NotebookPage, Session, ViewKey } from "../core/session.ts";
import type { RankOutput } from "../core/registry.ts";
import { notImplementedResult } from "../core/errors.ts";

export interface ViewModel { envelope: Envelope; freshness: FreshnessResult; contentHash: string }
export interface SearchHit {
  type: "entity" | "view" | "example" | "claim";
  id: string;
  text: string;
  snapshotId: string;
  viewId?: string;
  itemId?: string;
  entity?: EntityRef;
}

export interface ViewerSource {
  getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>>;
  applicableViews(entity: EntityRef, snapshotId: string, preferredViewDefinitionId?: string): Promise<Result<RankOutput>>;
  /** The view instance of `definitionId` for the entity at the snapshot. */
  getViewFor(entity: EntityRef, snapshotId: string, definitionId: string): Promise<Result<ViewModel>>;
  getView(key: ViewKey): Promise<Result<ViewModel>>;
  openItemSource(key: ViewKey, itemId: string): Promise<Result<SourceOpening>>;
  search(query: string, scope?: { entity: EntityRef; snapshotId: string }): Promise<Result<SearchHit[]>>;
  updateNotebook(pageId: string, expectedRevision: number, blocks: unknown[]): Promise<Result<NotebookPage>>;
}

/** STUB. */
export function createSessionSource(_session: Session): ViewerSource {
  const stub = <T>(what: string) => async (): Promise<Result<T>> => notImplementedResult<T>(`ViewerSource.${what}`);
  return {
    getEntity: stub("getEntity"), applicableViews: stub("applicableViews"), getViewFor: stub("getViewFor"),
    getView: stub("getView"), openItemSource: stub("openItemSource"), search: stub("search"), updateNotebook: stub("updateNotebook"),
  };
}

/** Browser-side source over the viewer's HTTP API. STUB. */
export function createHttpSource(_baseUrl: string, _token: string, _fetchImpl?: typeof fetch): ViewerSource {
  return createSessionSource(undefined as unknown as Session);
}
