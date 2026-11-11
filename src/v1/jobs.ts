// Collection jobs: two-phase submission, durable lifecycle, recovery and cancellation through qex (S2, S3, N1, N2; IV17).
// Job id == request id. Layout under the session: jobs/<id>/{intent.json, qex.id, state.json, staging/<runId>/, quarantine/}.
import type { Result } from "../core/errors.ts";
import type { Session } from "../core/session.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { AdapterRecord, ProcessSpec } from "./adapters.ts";
import type { QexClient } from "./qex.ts";
import { notImplemented } from "./stub.ts";

export type JobStateName = "intent" | "submitted" | "queued" | "running" | "importing" | "succeeded" | "failed" | "cancelled" | "indeterminate";
export const TERMINAL_JOB_STATES: ReadonlyArray<JobStateName> = ["succeeded", "failed", "cancelled"];

export interface CollectRequest {
  requestId: string;
  repo: string;
  adapter: string;
  examples: string[];
  views?: string[];
  limits?: Record<string, number>;
}

export interface JobView {
  requestId: string;
  state: JobStateName;
  qexId: string | null;
  runId: string | null;
  /** true when this call created the job; false when it returned an existing one. */
  created: boolean;
  snapshotIds: string[];
  diagnosticIds: string[];
  collectionStatus?: "succeeded" | "failed" | "cancelled" | "timed-out" | "incomplete";
  indeterminate?: { evidence: string[] };
  counts?: Record<string, number>;
  /** log slice for collection_status. */
  log?: { text: string; cursor: string | null };
}

export interface CancelResult {
  outcome: "cancelled" | "cancel-too-late" | "already-terminal" | "indeterminate";
  state: JobStateName;
  qexActions: Array<"cancel" | "kill">;
  collectionStatus?: JobView["collectionStatus"];
}

/** Test seam: a crash is injected by throwing from this callback. A fresh service on the same session must recover. */
export type CrashPoint = "after-intent" | "after-qex-submit" | "after-id-file" | "after-submitted-state" | "import:before-write" | "import:after-objects" | "import:after-manifest" | "import:before-terminal-state";

export interface JobServiceDeps {
  session: Session;
  sessionDir: string;
  qex: QexClient;
  /** Owner-configured adapters, by id. */
  adapters: AdapterRecord[];
  catalogueFor?: (repo: string, adapter: string) => Promise<Catalogue | null>;
  crashAt?: (point: CrashPoint) => void | Promise<void>;
  clock?: () => Date;
  /** Bounded wait for qex to reach a terminal state after cancel/kill (milliseconds). */
  cancelWaitMs?: number;
}

export interface JobService {
  collect(request: CollectRequest): Promise<Result<JobView>>;
  /** Catalogue mode (spec section 2): runs ONLY the reserved export tests of the adapter's target, as a queue job with the same
   * lifecycle, and on success stores `catalogues/<repo>/<adapter>.json` (catalogue + input fingerprint). CLI: `paneweft catalogue
   * refresh` (owner/developer command, not an MCP tool). */
  refreshCatalogue(request: { requestId: string; repo: string; adapter: string }): Promise<Result<JobView>>;
  /** Reads (and, when needed, recovers/advances) the job. waitSeconds is 0-30; more is INVALID_ARGUMENT. */
  status(jobId: string, options?: { waitSeconds?: number; logCursor?: string; maxLogBytes?: number }): Promise<Result<JobView>>;
  cancel(jobId: string): Promise<Result<CancelResult>>;
}

export function createJobService(deps: JobServiceDeps): JobService {
  const fail = <T>(what: string): Promise<Result<T>> => Promise.resolve(notImplemented(what));
  return { collect: () => fail("collect"), refreshCatalogue: () => fail("refreshCatalogue"), status: () => fail("status"), cancel: () => fail("cancel") };
}

/** The exact `qex submit` argument vector (no shell). Pure. STUB: []. */
export function buildQexSubmitArgv(adapter: AdapterRecord, requestId: string, process: ProcessSpec, jobDirectory: string, timeoutMs: number): string[] {
  return [];
}
