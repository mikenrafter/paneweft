// Reading imported collections: objects, backlinks, stored pages, run records (IV10, IV11).
import type { Result } from "../core/errors.ts";
import type { EntityRef } from "../core/wire.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { ObjectRecord, PageRecord } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { notImplemented } from "./stub.ts";

export interface ObjectKey {
  snapshotId: string;
  captureId: string;
  objectId: string;
}

export interface Backlink {
  from: ObjectKey;
  name: string;
  kind: "child" | "alias" | "cycle";
}

export interface StoredObject {
  key: ObjectKey;
  record: ObjectRecord;
  entity: EntityRef;
  views: ViewKey[];
  /** Aliases and cycles shown without duplicating the graph: who points here, and how. */
  backlinks: Backlink[];
}

export interface StoredRun {
  run: TestRun;
  origin: "host_collected" | "external_recorded" | "agent_submitted";
  snapshotId: string;
}

export interface V1Reader {
  object(key: ObjectKey): Promise<Result<StoredObject>>;
  /** A stored child page by content address; readable with no source process alive. */
  page(pageId: string): Promise<Result<PageRecord>>;
  run(runId: string): Promise<Result<StoredRun>>;
  runs(): Promise<Result<Array<{ runId: string; snapshotId: string; origin: StoredRun["origin"] }>>>;
}

export function openV1Reader(session: Session): V1Reader {
  const failure = <T>(what: string): Promise<Result<T>> => Promise.resolve(notImplemented(what));
  return { object: () => failure("object"), page: () => failure("page"), run: () => failure("run"), runs: () => failure("runs") };
}
