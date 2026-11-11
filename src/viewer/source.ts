// What the browser needs from the core, as an interface so the same DOM code runs over a Session
// in-process (tests, server-side) and over HTTP in the browser.
import type { Entity, EntityRef, Envelope } from "../core/wire.ts";
import type { Result } from "../core/errors.ts";
import type { FreshnessResult } from "../core/freshness.ts";
import type { SourceOpening } from "../core/links.ts";
import type { NotebookPage, ViewKey } from "../core/session.ts";
import type { RankOutput } from "../core/registry.ts";

/** `notebookRevision` is present exactly on notebook views: the page revision the model was read at (N1). */
export interface ViewModel {
  envelope: Envelope; freshness: FreshnessResult; contentHash: string; notebookRevision?: number;
  /** Example views only: which run items of `envelope` were recorded (not written into the stored envelope), and why a recorded run was left out. */
  recordedRuns?: { runs: Array<{ itemId: string; runId: string; contentHash: string }>; notice: string | null };
}
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
  /** The example view a notebook example block names in `snapshotId`: the example view with that id, else the one whose item (its scenario) has that id. NOT_FOUND when none. */
  findExample(exampleId: string, snapshotId: string): Promise<Result<ViewModel>>;
  openItemSource(key: ViewKey, itemId: string): Promise<Result<SourceOpening>>;
  search(query: string, scope?: { entity: EntityRef; snapshotId: string }): Promise<Result<SearchHit[]>>;
  /** `snapshotId` names the page's snapshot; it may be omitted only while one snapshot holds the pageId. The viewer always sends it. */
  updateNotebook(pageId: string, expectedRevision: number, blocks: unknown[], snapshotId?: string): Promise<Result<NotebookPage>>;
}

export { createSessionSource } from "./session-source.ts";
export { createHttpSource } from "./http-source.ts";
