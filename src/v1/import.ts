// Atomic, idempotent import of one collection into a session (spec section 8; amendment S3; IV20).
import type { Result } from "../core/errors.ts";
import type { EntityRef } from "../core/wire.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { notImplemented } from "./stub.ts";

export type Origin = "host_collected" | "external_recorded" | "agent_submitted";

export interface CollectionImport {
  repo: string;
  /** Must equal run.runId and the runId of every graph. */
  runId: string;
  jobId: string | null;
  /** Stamped by the HOST: session metadata, never read from the submitted payload. */
  origin: Origin;
  run: unknown;
  graphs: unknown[];
}

export interface ImportReceipt {
  runId: string;
  snapshotId: string;
  captureIds: string[];
  viewKeys: ViewKey[];
  entities: EntityRef[];
  /** true when the same run id with identical content was already imported (idempotent by run id). */
  alreadyImported: boolean;
}

export type ImportCrashPoint = "before-write" | "after-objects" | "after-manifest";

/** Validates everything first (no write on any fault), then writes under the session write lock: objects, then one atomic manifest
 * swap. STUB. */
export function importCollection(session: Session, input: CollectionImport, options: { crashAt?: (point: ImportCrashPoint) => void | Promise<void> } = {}): Promise<Result<ImportReceipt>> {
  return Promise.resolve(notImplemented("importCollection"));
}

export type { TestRun };
