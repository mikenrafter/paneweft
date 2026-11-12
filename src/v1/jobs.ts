// Collection jobs: two-phase submission, durable lifecycle, recovery and cancellation through qex (S2, S3, N1, N2; IV17).
// Job id == request id. Layout under the session: jobs/<id>/{intent.json, qex.id, state.json, staging/<runId>/, quarantine/, .write.lock}.
//
// qex is the supervisor that outlives MCP clients: a job record is the only memory this service needs, so a later instance (another
// MCP session, another process) can status, finish or cancel a job from the files alone.
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { canonicalJson } from "../core/canonical.ts";
import { WriteLockError, withWriteLock } from "../core/write-lock.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Session } from "../core/session.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";
import type { Inventory } from "../generated/v1/Inventory.ts";
import { validateAgainstV1 } from "./schemas.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { buildProcess, foldExactFilters, parseCargoLists, reconcile, selectExamples, type AdapterRecord, type ProcessSpec, type Selection } from "./adapters.ts";
import { validateObjectGraph } from "./capture.ts";
import { checkInventory, mergeCatalogue, type CataloguePart, type InventoryProblem } from "./catalogue.ts";
import { qualifyDiagnosticId } from "./diagnostic-id.ts";
import { compareFingerprints, computeFingerprint, sampleConsistency, type Fingerprint } from "./fingerprint.ts";
import { importCollection } from "./import.ts";
import { resolveRequestedLimits, type LimitsReport } from "./limits.ts";
import { QEX_TERMINAL_STATES, type QexClient, type QexJob } from "./qex.ts";
import { snapshotOfRun } from "./read.ts";

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
  /** The capture bounds the job runs under: what was requested, what is in force for every bound, and which requests were clamped (S3). */
  limits?: LimitsReport;
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

/** The exact `qex submit` argument vector (no shell). Pure. */
export function buildQexSubmitArgv(adapter: AdapterRecord, requestId: string, process: ProcessSpec, jobDirectory: string, timeoutMs: number): string[] {
  const argv = ["submit", "--dedupe-key", `paneweft:${requestId}`, "--dedupe-window", "24h", "--id-file", join(jobDirectory, "qex.id"), "--cwd", process.cwd, "--name", `paneweft-${requestId}`, "--cpu", adapter.queue.cpu, "--mem", adapter.queue.mem];
  for (const tag of adapter.queue.tags ?? []) argv.push("--tag", tag);
  argv.push("--timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
  for (const key of Object.keys(process.env).sort()) argv.push("--env", `${key}=${process.env[key]}`);
  argv.push("--", process.executable, ...process.argv);
  return argv;
}

// ---- files -------------------------------------------------------------------------------------------------------------------------

async function writeDurably(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" || cause instanceof SyntaxError) return undefined;
    throw cause;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Params { repo: string; adapter: string; examples: string[]; views?: string[]; limits?: Record<string, number>; mode?: "run" | "catalogue" }
interface Intent {
  schemaVersion: "paneweft.job-intent/1";
  requestId: string;
  dedupeKey: string;
  params: Params;
  createdAt: string;
  resolved?: { selection: Selection; process: ProcessSpec; timeoutMs: number; runId: string; stagingDir: string; limits?: LimitsReport };
}
interface State {
  schemaVersion: "paneweft.job/1";
  requestId: string;
  state: JobStateName;
  qexId: string | null;
  runId: string | null;
  history: Array<{ state: string; at: string; evidence?: string }>;
  indeterminate?: { evidence: string[] };
  terminal?: { collectionStatus: NonNullable<JobView["collectionStatus"]>; snapshotIds: string[]; diagnosticIds: string[]; counts?: Record<string, number> };
  cancel?: { outcome: CancelResult["outcome"]; qexActions?: Array<"cancel" | "kill"> };
}

function normalizeParams(request: { repo: string; adapter: string; examples: string[]; views?: string[]; limits?: Record<string, number> }, mode: "run" | "catalogue"): Params {
  const sorted = (list: string[]): string[] => [...new Set(list)].sort();
  return { repo: request.repo, adapter: request.adapter, examples: sorted(request.examples), ...(request.views === undefined || request.views.length === 0 ? {} : { views: sorted(request.views) }), ...(request.limits === undefined || Object.keys(request.limits).length === 0 ? {} : { limits: request.limits }), ...(mode === "catalogue" ? { mode } : {}) };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Where a failed example lives: the panic location in the log ("panicked at tests/seeded.rs:12:5") when the log has one, else the declaration. */
function panicLocation(log: string, declared: { source: { path: string; line: number } } | undefined): { path: string; line: number } | undefined {
  const hits = [...log.matchAll(/panicked at ([^:\s]+):(\d+):\d+/g)];
  const named = hits.find((hit) => declared !== undefined && (hit[1] as string).endsWith(declared.source.path)) ?? hits[0];
  if (named !== undefined) return { path: named[1] as string, line: Number(named[2]) };
  return declared === undefined ? undefined : { path: declared.source.path, line: declared.source.line };
}

/** The catalogue the owner's last `catalogue refresh` stored for a repository and adapter (`catalogues/<repo>/<adapter>.json`). */
async function storedCatalogue(sessionDir: string, repo: string, adapter: string): Promise<Catalogue | null> {
  try {
    return (JSON.parse(await readFile(join(sessionDir, "catalogues", repo, `${adapter}.json`), "utf8")) as { catalogue: Catalogue }).catalogue;
  } catch {
    return null;
  }
}

/** The repository's checked-in `paneweft.inventory.json` (S15): absent is fine, present must be a valid inventory. */
async function loadInventory(root: string): Promise<{ ok: true; value: Inventory | undefined } | { ok: false; message: string }> {
  const text = await readFile(join(root, "paneweft.inventory.json"), "utf8").catch(() => undefined);
  if (text === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: `paneweft.inventory.json is not JSON: ${(cause as Error).message}` };
  }
  const faults = validateAgainstV1("urn:paneweft:schema:v1:inventory:1", parsed);
  return faults.length > 0 ? { ok: false, message: `paneweft.inventory.json is not a paneweft.inventory/1 document: ${faults[0]?.pointer} ${faults[0]?.constraint}` } : { ok: true, value: parsed as Inventory };
}

function inventoryMessage(problem: InventoryProblem): string {
  switch (problem.kind) {
    case "missing-module": return `the module "${problem.module}" is declared in paneweft.inventory.json but contributes none of its ${problem.ids.length} id(s) (${problem.ids.join(", ")}) to the compiled catalogue: its import was removed or it is no longer linked`;
    case "removed-view": return `the view "${problem.id}" of module "${problem.module}" is declared in paneweft.inventory.json but is not in the compiled catalogue`;
    case "removed-example": return `the example "${problem.id}" of module "${problem.module}" is declared in paneweft.inventory.json but is not in the compiled catalogue`;
    case "unlisted": return `"${problem.id}" of module "${problem.module}" is in the compiled catalogue but not in paneweft.inventory.json`;
    case "return-type-changed": return `the example "${problem.id}" returns ${problem.actual} but paneweft.inventory.json declares ${problem.expected}`;
    case "duplicate-id": return `the id "${problem.id}" is declared twice in the compiled catalogue`;
  }
}

export function createJobService(rawDeps: JobServiceDeps): JobService {
  const deps: JobServiceDeps = { ...rawDeps, catalogueFor: rawDeps.catalogueFor ?? ((repo, adapter) => storedCatalogue(rawDeps.sessionDir, repo, adapter)) };
  const now = (): string => (deps.clock?.() ?? new Date()).toISOString();
  const crash = async (point: CrashPoint): Promise<void> => void (await deps.crashAt?.(point));
  // S1: a job id from a caller names a directory only after it matched REQUEST_ID (no separators, no dot-only names); anything else is
  // "no such job", never a path.
  const jobDir = (id: string): string => {
    if (!REQUEST_ID.test(id)) throw new RangeError(`"${id}" is not a job id`);
    return join(deps.sessionDir, "jobs", id);
  };
  const cancelWaitMs = deps.cancelWaitMs ?? 10_000;

  const readIntent = async (id: string): Promise<Intent | undefined> => {
    const intent = await readJson<Intent>(join(jobDir(id), "intent.json"));
    return intent?.schemaVersion === "paneweft.job-intent/1" ? intent : undefined;
  };
  const readState = async (id: string): Promise<State | undefined> => readJson<State>(join(jobDir(id), "state.json"));
  const writeState = async (id: string, patch: Partial<State> & { state: JobStateName }, evidence?: string): Promise<State> => {
    const previous = (await readState(id)) ?? { schemaVersion: "paneweft.job/1" as const, requestId: id, state: "intent" as JobStateName, qexId: null, runId: null, history: [] };
    const history = previous.state === patch.state && evidence === undefined ? previous.history : [...previous.history, { state: patch.state, at: now(), ...(evidence === undefined ? {} : { evidence }) }];
    const next: State = { ...previous, ...patch, history };
    await writeDurably(join(jobDir(id), "state.json"), JSON.stringify(next));
    return next;
  };

  const view = (id: string, intent: Intent, state: State | undefined, created: boolean): JobView => ({
    requestId: id,
    state: state?.state ?? "intent",
    qexId: state?.qexId ?? null,
    runId: intent.resolved?.runId ?? state?.runId ?? null,
    created,
    snapshotIds: state?.terminal?.snapshotIds ?? [],
    diagnosticIds: state?.terminal?.diagnosticIds ?? [],
    ...(state?.terminal === undefined ? {} : { collectionStatus: state.terminal.collectionStatus }),
    ...(state?.indeterminate === undefined ? {} : { indeterminate: state.indeterminate }),
    ...(state?.terminal?.counts === undefined ? {} : { counts: state.terminal.counts }),
    ...(intent.resolved?.limits === undefined ? {} : { limits: intent.resolved.limits }),
  });

  const adapterFor = (params: Params): AdapterRecord | undefined => deps.adapters.find((candidate) => candidate.id === params.adapter && candidate.repo === params.repo);

  // ---- phase 1: the intent (one creator at a time, published whole) ----------------------------------------------------------------

  /** The intent is created under the job directory's write lock (a kernel flock: the lock of a dead process is gone with it, so a live
   * writer is never mistaken for an abandoned one) and published by rename, so a reader finds no intent or a whole one (S6). An
   * unreadable intent file can only be a leftover of a crash or of a disk fault; it is replaced under the lock. */
  async function createIntent(id: string, params: Params, resolved: Intent["resolved"]): Promise<Result<{ intent: Intent; created: boolean }>> {
    try {
      await mkdir(jobDir(id), { recursive: true });
      return await withWriteLock(jobDir(id), { waitMs: 15_000 }, async (): Promise<Result<{ intent: Intent; created: boolean }>> => {
        const existing = await readIntent(id);
        if (existing !== undefined) {
          if (canonicalJson(existing.params) !== canonicalJson(params)) return err("CONFLICT", `the request id "${id}" already names a collection with different parameters; use a new request id for a deliberate rerun`, { details: { requestId: id } });
          return ok({ intent: existing, created: false });
        }
        const intent: Intent = { schemaVersion: "paneweft.job-intent/1", requestId: id, dedupeKey: `paneweft:${id}`, params, createdAt: now(), ...(resolved === undefined ? {} : { resolved }) };
        await writeDurably(join(jobDir(id), "intent.json"), JSON.stringify(intent));
        return ok({ intent, created: true });
      });
    } catch (cause) {
      if (cause instanceof WriteLockError) return err(cause.kind === "contended" ? "CONFLICT" : "STORAGE_FAILED", `the job "${id}" is being created by another caller: ${cause.message}`, { retryable: cause.kind === "contended" });
      return err("STORAGE_FAILED", `cannot create the job intent: ${(cause as Error).message}`);
    }
  }

  // ---- phase 2: submission and recovery -------------------------------------------------------------------------------------------

  /** Brings an intent to a submitted job: id file, else qex list by dedupe key (adopt), else submit once when absence is PROVEN. */
  async function ensureSubmitted(id: string, intent: Intent): Promise<Result<State>> {
    const known = await readState(id);
    if (known?.qexId) return ok(known);
    // Submission is one caller's business at a time (the job's write lock): two callers that both found the job unsubmitted would
    // otherwise both ask qex, and both write the id file and the state (S6).
    try {
      await mkdir(jobDir(id), { recursive: true });
      return await withWriteLock(jobDir(id), { waitMs: 15_000 }, () => submitOnce(id, intent));
    } catch (cause) {
      if (cause instanceof WriteLockError) return err(cause.kind === "contended" ? "CONFLICT" : "STORAGE_FAILED", `the job "${id}" is being submitted by another caller: ${cause.message}`, { retryable: cause.kind === "contended" });
      throw cause;
    }
  }

  async function submitOnce(id: string, intent: Intent): Promise<Result<State>> {
    const state = await readState(id);
    if (state?.qexId) return ok(state);
    const idFile = join(jobDir(id), "qex.id");
    let qexId = (await readFile(idFile, "utf8").catch(() => "")).trim();
    let how = "the id file";
    if (qexId.length === 0) {
      const listed = await deps.qex.list();
      if (!listed.ok) {
        const evidence = [`qex list failed (${listed.error.message}), so the absence of a job with the dedupe key ${intent.dedupeKey} cannot be proven; the intent is unsubmitted and will not be resubmitted automatically`];
        return ok({ schemaVersion: "paneweft.job/1", requestId: id, state: "indeterminate", qexId: null, runId: intent.resolved?.runId ?? null, history: state?.history ?? [], indeterminate: { evidence } });
      }
      const found = listed.value.find((job) => job.dedupe_key === intent.dedupeKey);
      if (found !== undefined) {
        qexId = found.id;
        how = "qex list by the dedupe key";
      } else {
        const resolved = intent.resolved;
        const adapter = adapterFor(intent.params);
        if (resolved === undefined || adapter === undefined) return err("INTERNAL", `job "${id}" has no resolved process to submit`);
        const submitted = await deps.qex.submit(buildQexSubmitArgv(adapter, id, resolved.process, jobDir(id), resolved.timeoutMs));
        if (!submitted.ok) return submitted;
        qexId = submitted.value.id;
        how = "qex submit";
        await crash("after-qex-submit");
      }
    }
    if ((await readFile(idFile, "utf8").catch(() => "")).trim() !== qexId) await writeDurably(idFile, `${qexId}\n`);
    await crash("after-id-file");
    const next = await writeState(id, { state: "submitted", qexId, runId: intent.resolved?.runId ?? null, indeterminate: undefined }, `submitted to qex as ${qexId} (${how})`);
    await crash("after-submitted-state");
    return ok(next);
  }

  // ---- finishing: reconcile, import, terminal state ------------------------------------------------------------------------------

  /** Ids whose lease THIS service instance holds (re-entrant: the waiter that holds it also performs the import). */
  const held = new Set<string>();

  /** Creates the lease file unless a LIVE other process holds it; a lease of a dead process is stolen. */
  async function takeLease(id: string): Promise<boolean> {
    const path = join(jobDir(id), "import.lease");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
        await handle.close();
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      const holder = await readJson<{ pid: number }>(path);
      if (holder !== undefined && typeof holder.pid === "number" && alive(holder.pid)) return false;
      if (holder === undefined) {
        // created but not yet written by its owner: give it a moment rather than stealing a lease that is being taken
        await sleep(10);
        if ((await readJson<{ pid: number }>(path)) === undefined && attempt === 2) await unlink(path).catch(() => undefined);
        continue;
      }
      await unlink(path).catch(() => undefined);
    }
    return false;
  }

  async function leaseIsLive(id: string): Promise<boolean> {
    const holder = await readJson<{ pid: number }>(join(jobDir(id), "import.lease"));
    return holder !== undefined && typeof holder.pid === "number" && alive(holder.pid);
  }

  /** Runs `body` as the follower of the job: the lease is held for the whole body, so no other instance advances or imports meanwhile. */
  async function withLease<T>(id: string, body: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
    if (held.has(id)) return { held: true, value: await body() };
    if (!(await takeLease(id))) return { held: false };
    held.add(id);
    try {
      return { held: true, value: await body() };
    } finally {
      held.delete(id);
      await unlink(join(jobDir(id), "import.lease")).catch(() => undefined);
    }
  }

  async function readStaging(stagingDir: string): Promise<{ invocations: Array<{ started: Record<string, unknown> | null; completed: Record<string, unknown> | null }>; captures: Map<string, { document: unknown; file: string }>; reporter: unknown; typecheck: { exitCode: number; output: string } | undefined; parts: Array<{ name: string; document: Record<string, unknown> }> }> {
    const list = async (sub: string): Promise<string[]> => (await readdir(join(stagingDir, sub)).catch(() => [])).sort();
    const started = new Map<string, Record<string, unknown>>();
    const completed = new Map<string, Record<string, unknown>>();
    for (const name of await list("invocations")) {
      const document = await readJson<Record<string, unknown>>(join(stagingDir, "invocations", name));
      if (document === undefined || typeof document.id !== "string") continue;
      if (name.endsWith(".started.json")) started.set(document.id, document);
      else completed.set(document.id, document);
    }
    const ids = [...new Set([...started.keys(), ...completed.keys()])];
    const timeOf = (id: string): string => String((started.get(id) ?? completed.get(id))?.startedAt ?? "");
    const natural = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
    ids.sort((a, b) => (timeOf(a) < timeOf(b) ? -1 : timeOf(a) > timeOf(b) ? 1 : natural(a, b)));
    const captures = new Map<string, { document: unknown; file: string }>();
    for (const name of await list("captures")) {
      const document = await readJson<unknown>(join(stagingDir, "captures", name));
      if (document !== undefined) captures.set(name.replace(/\.json$/, ""), { document, file: join(stagingDir, "captures", name) });
    }
    const parts: Array<{ name: string; document: Record<string, unknown> }> = [];
    for (const name of await list("catalogue")) {
      const document = await readJson<Record<string, unknown>>(join(stagingDir, "catalogue", name));
      if (document !== undefined) parts.push({ name: name.replace(/\.json$/, ""), document });
    }
    return { invocations: ids.map((id) => ({ started: started.get(id) ?? null, completed: completed.get(id) ?? null })), captures, reporter: await readJson<unknown>(join(stagingDir, "reporter.json")), typecheck: await readJson<{ exitCode: number; output: string }>(join(stagingDir, "typecheck.json")), parts };
  }

  function compileDiagnostics(log: string, typecheck: { output: string } | undefined, kind: "cargo" | "vitest"): Diagnostic[] {
    const found: Diagnostic[] = [];
    if (kind === "cargo") {
      const pattern = /error(?:\[(E\d+)\])?: ([^\n]+)\n\s*--> ([^:\n]+):(\d+):(\d+)/g;
      for (const match of log.matchAll(pattern)) {
        found.push({ id: `diag-compile-${found.length + 1}`, category: "compiler", message: `${match[1] === undefined ? "" : `${match[1]}: `}${match[2]}`.slice(0, 2000), source: { path: match[3] as string, line: Number(match[4]), column: Number(match[5]) }, nextAction: "Fix the named field or type in the view source at the span, then run the collection again." } as Diagnostic);
      }
    } else if (typecheck !== undefined) {
      for (const line of typecheck.output.split("\n")) {
        const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
        if (match !== null) found.push({ id: `diag-compile-${found.length + 1}`, category: "typecheck", message: `${match[4]}: ${match[5]}`.slice(0, 2000), source: { path: match[1] as string, line: Number(match[2]), column: Number(match[3]) }, nextAction: "Fix the named property or type in the view source, then run the collection again." } as Diagnostic);
      }
    }
    if (found.length === 0) found.push({ id: "diag-compile-1", category: kind === "cargo" ? "compiler" : "typecheck", message: "the instrumentation did not compile", stderrSlice: (typecheck?.output ?? log).slice(-3500), nextAction: "Read the stderr slice; fix the first error, then run the collection again." } as Diagnostic);
    return found.slice(0, 20);
  }

  async function locateFailure(log: string, exampleId: string, adapter: AdapterRecord): Promise<{ path: string; line: number } | undefined> {
    const declared = (await deps.catalogueFor?.(adapter.repo, adapter.id))?.examples.find((example) => example.id === exampleId);
    return panicLocation(log, declared);
  }

  async function packageName(adapter: AdapterRecord): Promise<string> {
    const root = normalize(join(adapter.workspaceRoot, adapter.entry));
    if (adapter.kind === "cargo") {
      const text = await readFile(join(root, "Cargo.toml"), "utf8").catch(() => "");
      return /^\s*name\s*=\s*"([^"]+)"/m.exec(text.slice(text.indexOf("[package]") < 0 ? 0 : text.indexOf("[package]")))?.[1] ?? "package";
    }
    const text = await readFile(join(root, "package.json"), "utf8").catch(() => "{}");
    return (JSON.parse(text) as { name?: string }).name ?? "package";
  }

  async function finalizeCatalogue(id: string, intent: Intent, adapter: AdapterRecord, qexJob: QexJob, log: string): Promise<{ status: NonNullable<JobView["collectionStatus"]>; snapshotIds: string[]; diagnostics: Diagnostic[] }> {
    const resolved = intent.resolved as NonNullable<Intent["resolved"]>;
    const staging = await readStaging(resolved.stagingDir);
    const diagnostics: Diagnostic[] = [];
    const name = await packageName(adapter);
    const parts: CataloguePart[] = [];
    const scope: string[] = [];
    for (const { name: file, document } of staging.parts) {
      const stem = file.replace(/-[0-9a-f]{16}$/, "").replace(/_/g, "-");
      const target = adapter.kind === "cargo" ? (stem === name.replace(/_/g, "-") ? "lib" : stem) : "all";
      const selectorTarget = (example: Record<string, unknown>): Record<string, unknown> => adapter.kind === "cargo" ? { ...(example.selector as object), package: name, target } : (example.selector as Record<string, unknown>);
      parts.push({ source: file, types: (document.types as Catalogue["types"]) ?? [], views: (document.views as Catalogue["views"]) ?? [], examples: ((document.examples as Array<Record<string, unknown>>) ?? []).map((example) => ({ ...example, selector: selectorTarget(example) })) as unknown as Catalogue["examples"] });
      scope.push(adapter.kind === "cargo" ? `${name} (${target === "lib" ? "lib" : `test ${target}`})` : `${name} (${file})`);
    }
    if (parts.length === 0 || qexJob.exit_code !== 0) {
      const compile = compileDiagnostics(log, staging.typecheck, adapter.kind);
      diagnostics.push(...(qexJob.exit_code !== 0 && /error(\[E\d+\])?: /.test(log) ? compile : [{ id: "diag-catalogue-1", category: "registration", message: parts.length === 0 ? "the catalogue export wrote no part: no test binary registered `paneweft::test_adapter!()` (cargo) or the manifest was not exported (vitest)" : `the catalogue export exited with status ${qexJob.exit_code}`, stderrSlice: log.slice(-3500), nextAction: "Add `paneweft::test_adapter!();` to each participating test module, build with the declared features, then refresh again." } as Diagnostic]));
      return { status: "failed", snapshotIds: [], diagnostics };
    }
    const merged = mergeCatalogue(parts, { runner: adapter.kind, package: name, ...(adapter.kind === "cargo" ? {} : {}), features: adapter.features }, scope.sort());
    if (!merged.ok) {
      const duplicates = ((merged.error.details as { duplicates?: Array<{ id: string; kind: string; sources: Array<{ path: string; line: number }> }> } | undefined)?.duplicates) ?? [];
      for (const [index, duplicate] of duplicates.entries()) diagnostics.push({ id: `diag-registration-${index + 1}`, category: "registration", message: `the ${duplicate.kind} id "${duplicate.id}" is declared twice: ${duplicate.sources.map((source) => `${source.path}:${source.line}`).join(" and ")}`, source: { path: duplicate.sources[0]?.path ?? "", line: duplicate.sources[0]?.line ?? 1 }, invariant: "a view or example id is declared once per catalogue", nextAction: "Rename one declaration or remove the duplicate registration, then refresh the catalogue." } as Diagnostic);
      if (diagnostics.length === 0) diagnostics.push({ id: "diag-registration-1", category: "registration", message: merged.error.message, nextAction: "Fix the registration named in the message, then refresh the catalogue." } as Diagnostic);
      return { status: "failed", snapshotIds: [], diagnostics };
    }
    const root = normalize(join(adapter.workspaceRoot, adapter.entry));
    // S15: the repository's checked-in inventory is compared with what was just compiled. A removed import (a declared module that exports
    // nothing any more), a removed or unlisted id, a changed return type or a duplicate fails the refresh and leaves the stored catalogue as it was.
    const inventory = await loadInventory(root);
    if (!inventory.ok) {
      diagnostics.push({ id: "diag-inventory-1", category: "registration", message: inventory.message, nextAction: "Fix paneweft.inventory.json (a paneweft.inventory/1 document), then refresh the catalogue again." } as Diagnostic);
      return { status: "failed", snapshotIds: [], diagnostics };
    }
    if (inventory.value !== undefined) {
      const checked = checkInventory(merged.value, inventory.value);
      if (!checked.ok) {
        for (const [index, problem] of checked.problems.entries()) diagnostics.push({ id: `diag-inventory-${index + 1}`, category: "registration", message: inventoryMessage(problem).slice(0, 2000), invariant: "the compiled catalogue matches the checked-in inventory", nextAction: "If the removal or addition is intended, update paneweft.inventory.json in the same reviewed change; otherwise restore the import or the declaration, then refresh the catalogue." } as Diagnostic);
        return { status: "failed", snapshotIds: [], diagnostics };
      }
    }
    // S14: the record holds the sources the job STARTED from, with the consistency of the sample before and the sample after; a source edited while
    // the export ran leaves a mixed sample, which is never fresh.
    const before = await readJson<Fingerprint>(join(jobDir(id), "fingerprint.before.json"));
    const after = await computeFingerprint({ root, declaredExtras: before?.declaredExtras ?? [], exclusions: before?.exclusions ?? [] });
    let fingerprint: Record<string, unknown>;
    if (before !== undefined && after.ok) {
      const sample = sampleConsistency(before, after.value);
      fingerprint = { ...before, sampledConsistency: sample.status, ...(sample.status === "mixed-input" ? { sampleNote: sample.note, changedDuringExport: sample.changed } : {}) };
    } else if (after.ok) fingerprint = { ...after.value, sampledConsistency: "unverified", unverified: "no sample was taken before the export ran" };
    else fingerprint = { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [], sampledConsistency: "unverified", unverified: after.error.message };
    const record = { schemaVersion: "paneweft.catalogue-record/1", repo: adapter.repo, adapter: adapter.id, catalogue: merged.value, fingerprint, ...(inventory.value === undefined ? {} : { inventory: inventory.value }), collectedAt: now() };
    await writeDurably(join(deps.sessionDir, "catalogues", adapter.repo, `${adapter.id}.json`), JSON.stringify(record));
    return { status: "succeeded", snapshotIds: [], diagnostics };
  }

  async function finalizeRun(id: string, intent: Intent, adapter: AdapterRecord, qexJob: QexJob, log: string, cancelRequested: boolean): Promise<{ status: NonNullable<JobView["collectionStatus"]>; snapshotIds: string[]; diagnostics: Diagnostic[]; counts: Record<string, number> }> {
    const resolved = intent.resolved as NonNullable<Intent["resolved"]>;
    const runId = resolved.runId;
    const finalizedPath = join(jobDir(id), "finalized.json");
    let finalized = await readJson<{ run: TestRun; graphs: unknown[]; diagnostics: Diagnostic[] }>(finalizedPath);
    if (finalized === undefined) {
      const staging = await readStaging(resolved.stagingDir);
      const diagnostics: Diagnostic[] = [];
      const quarantine = async (name: string, from: string, why: Diagnostic): Promise<void> => {
        await mkdir(join(jobDir(id), "quarantine", "captures"), { recursive: true });
        await rename(from, join(jobDir(id), "quarantine", "captures", `${name}.json`)).catch(() => undefined);
        diagnostics.push(why);
      };
      const graphs: unknown[] = [];
      const rejected = new Map<string, string>();
      for (const [captureId, { document, file }] of staging.captures) {
        const checked = validateObjectGraph(document, { expectedRunId: runId });
        if (checked.ok) {
          graphs.push(document);
          continue;
        }
        const foreign = checked.error.errors.some((fault) => fault.pointer === "/runId");
        const diagnosticId = `diag-${captureId}`;
        rejected.set(captureId, diagnosticId);
        const first = checked.error.errors[0];
        await quarantine(captureId, file, { id: diagnosticId, category: foreign ? "runner" : "output-schema", message: foreign ? `the capture ${captureId} was recorded by another run (${String((document as { runId?: unknown }).runId)}), not by this run (${runId}); it was quarantined and cannot satisfy this run` : `the capture ${captureId} is not admissible: ${checked.error.message}`.slice(0, 2000), ...(first === undefined ? {} : { pointer: first.pointer, invariant: first.constraint }), nextAction: foreign ? "Recollect: a stale artifact in the staging directory was ignored. If this repeats, the runner is not using the PANEWEFT_RUN_ID it was given." : "Fix the view or the SDK usage named by the pointer, then recollect." } as Diagnostic);
      }
      const names = Object.fromEntries(resolved.selection.examples.map((example) => [example.id, example.selector.name]));
      const typecheck = staging.typecheck;
      const compile: "ok" | "failed" = (typecheck !== undefined && typecheck.exitCode !== 0) || (adapter.kind === "cargo" && qexJob.exit_code !== 0 && staging.invocations.length === 0 && /error(\[E\d+\])?: could not compile|error\[E\d+\]/.test(log)) ? "failed" : "ok";
      const selected = resolved.selection.examples.map((example) => example.id);
      const started = new Set(staging.invocations.flatMap((entry) => (entry.started === null ? [] : [String(entry.started.exampleId)])));
      const lists = adapter.kind === "cargo" ? parseCargoLists(log, { selected, testNames: names, started, exitCode: qexJob.exit_code, compile }) : { skipped: [] as string[], filtered: [] as string[] };
      // a capture that was rejected makes the invocation that published it a failed capture, not a captured one
      const invocations = staging.invocations.map((entry) => {
        const completed = entry.completed;
        const captureId = (completed?.capture as { captureId?: string } | undefined)?.captureId;
        if (completed === null || captureId === undefined || !rejected.has(captureId)) return entry;
        return { started: entry.started, completed: { ...completed, capture: { outcome: "failed", captureId, diagnostics: [rejected.get(captureId)] }, result: undefined } };
      });
      const exit = { code: qexJob.exit_code, signal: qexJob.signal, timedOut: qexJob.state === "timeout", cancelled: cancelRequested };
      const native = adapter.kind === "cargo" ? log : typecheck !== undefined && typecheck.exitCode !== 0 ? { typecheck } : (staging.reporter ?? {});
      const reconciled = reconcile(adapter.kind, { runId, selected, testNames: adapter.kind === "cargo" ? names : Object.fromEntries(selected.map((example) => [example, `example:${example}`])), exit, compile, skipped: lists.skipped, filtered: lists.filtered, invocations: invocations as never, native });
      if (!reconciled.ok) throw new Error(reconciled.error.message);
      const run = reconciled.value;
      const before = await readJson<Fingerprint>(join(jobDir(id), "fingerprint.before.json"));
      const root = normalize(join(adapter.workspaceRoot, adapter.entry));
      const after = before === undefined ? undefined : await computeFingerprint({ root, declaredExtras: before.declaredExtras, exclusions: before.exclusions });
      run.collectionId = id;
      run.runner = { id: adapter.kind, version: (await readJson<{ version?: string }>(join(jobDir(id), "runner.json")))?.version ?? adapter.supportedVersions[0] ?? "unknown", ...(resolved.selection.examples[0]?.selector.target === undefined ? {} : { target: resolved.selection.examples[0].selector.target }), features: adapter.features };
      if (before !== undefined && after?.ok === true) {
        const sample = sampleConsistency(before, after.value);
        run.inputFingerprint = { digest: before.digest, memberCount: before.members.length, sampledConsistency: sample.status, members: before.members };
      }
      if (compile === "failed") diagnostics.push(...compileDiagnostics(log, typecheck, adapter.kind));
      for (const invocation of run.invocations) {
        const outcome = invocation.native.outcome;
        if (outcome === "failed" || outcome === "error" || outcome === "blocked") {
          const message = "message" in invocation.native && invocation.native.message !== undefined ? invocation.native.message : `blocked by ${(invocation.native as { blockedBy?: string }).blockedBy ?? "a child example"}`;
          const claims = invocation.checks.filter((check) => !check.passed).map((check) => check.claim);
          const where = await locateFailure(log, invocation.exampleId, adapter);
          diagnostics.push({ id: `diag-${invocation.id}`, category: outcome === "failed" ? "assertion" : "runner", message: String(message).slice(0, 2000), exampleId: invocation.exampleId, ...(where === undefined ? {} : { source: where }), nextAction: outcome === "failed" ? `Fix the code or the expectation behind the failed claim${claims.length === 1 ? "" : "s"} ${claims.join(", ") || "of the example"} (example ${invocation.exampleId}), then recollect.` : "Read the message and the captured log, fix the failing code, then recollect." } as Diagnostic);
        }
      }
      for (const entry of graphs) for (const diagnostic of ((entry as { diagnostics?: Diagnostic[] }).diagnostics ?? [])) diagnostics.push(diagnostic);
      await writeDurably(join(jobDir(id), "job.log"), log.slice(-adapter.limits.logBytes));
      await writeDurably(join(jobDir(id), "diagnostics.json"), JSON.stringify(diagnostics));
      finalized = { run, graphs, diagnostics };
      await writeDurably(finalizedPath, JSON.stringify(finalized));
    }
    const imported = await importCollection(deps.session, { repo: adapter.repo, runId, jobId: id, origin: "host_collected", run: finalized.run, graphs: finalized.graphs }, { crashAt: (point) => crash(`import:${point}` as CrashPoint) });
    if (!imported.ok) throw new Error(`import of ${runId} failed: ${imported.error.message}`);
    await crash("import:before-terminal-state");
    const counts = finalized.run.collection.counts as unknown as Record<string, number>;
    return { status: finalized.run.collection.status, snapshotIds: [snapshotOfRun(runId)], diagnostics: finalized.diagnostics, counts };
  }

  /** Imports (or, for a catalogue job, stores) the results of a qex job that stopped, then writes the terminal state. */
  async function finish(id: string, intent: Intent, adapter: AdapterRecord, qexJob: QexJob): Promise<void> {
    const cancelRequested = (await readJson<{ requested?: boolean }>(join(jobDir(id), "cancel.json")))?.requested === true;
    const neverRan = qexJob.state === "cancelled" || qexJob.state === "skipped";
    const leased = await withLease(id, async () => {
      // the lease first: whoever sees `importing` on disk can also see who holds it, so a second instance never imports concurrently
      await writeState(id, { state: "importing" }, `qex job ${qexJob.id} is ${qexJob.state}`);
      let log = await readFile(join(jobDir(id), "job.log"), "utf8").catch(() => undefined);
      if (log === undefined) {
        const fetched = neverRan ? ok("") : await deps.qex.logs(qexJob.id);
        log = fetched.ok ? fetched.value : "";
        await writeDurably(join(jobDir(id), "job.log"), log.slice(-adapter.limits.logBytes));
      }
      let outcome: { status: NonNullable<JobView["collectionStatus"]>; snapshotIds: string[]; diagnostics: Diagnostic[]; counts?: Record<string, number> };
      if (neverRan) outcome = { status: "cancelled", snapshotIds: [], diagnostics: [] };
      else if (intent.params.mode === "catalogue") outcome = await finalizeCatalogue(id, intent, adapter, qexJob, log);
      else outcome = await finalizeRun(id, intent, adapter, qexJob, log, cancelRequested || qexJob.state === "killed" && cancelRequested);
      const finalState: JobStateName = outcome.status === "succeeded" ? "succeeded" : outcome.status === "cancelled" ? "cancelled" : "failed";
      // every diagnostic of a job is stored with the job (a catalogue refresh included), and the ids handed out are qualified by the run (S13)
      if (intent.params.mode === "catalogue") await writeDurably(join(jobDir(id), "diagnostics.json"), JSON.stringify(outcome.diagnostics));
      const runId = intent.resolved?.runId ?? `run-${id}`;
      await writeState(id, { state: finalState, terminal: { collectionStatus: outcome.status, snapshotIds: outcome.snapshotIds, diagnosticIds: outcome.diagnostics.map((diagnostic) => qualifyDiagnosticId(runId, diagnostic.id)), ...(outcome.counts === undefined ? {} : { counts: outcome.counts }) } }, `collection ${outcome.status}`);
    });
    void leased;
  }

  /** One step of the lifecycle: recover, observe qex, import when it stopped. Idempotent; safe to call from any instance. */
  async function advance(id: string, known?: QexJob): Promise<Result<{ intent: Intent; state: State | undefined }>> {
    const intent = await readIntent(id);
    if (intent === undefined) return err("NOT_FOUND", `no collection job "${id}" in this session`);
    const adapter = adapterFor(intent.params);
    let state = await readState(id);
    if (state !== undefined && TERMINAL_JOB_STATES.includes(state.state)) return ok({ intent, state });
    if (!held.has(id) && (await leaseIsLive(id))) return ok({ intent, state }); // another live instance follows this job: observe, do not interfere
    if (adapter === undefined) return err("NOT_FOUND", `the adapter "${intent.params.adapter}" of job "${id}" is not registered any more`, { errors: [{ code: "CONSTRAINT", pointer: "/adapter", constraint: "a registered adapter", hint: "Register it again with: paneweft adapter add (owner action)" }] });
    const submitted = await ensureSubmitted(id, intent);
    if (!submitted.ok) return submitted;
    state = submitted.value;
    if (state.state === "indeterminate" || state.qexId === null) return ok({ intent, state });
    const queried = known !== undefined && known.id === state.qexId ? ok(known) : await deps.qex.status(state.qexId);
    if (!queried.ok) {
      if (state.state === "importing") {
        const stopped: QexJob = { id: state.qexId, state: "failed", exit_code: null, signal: null, dedupe_key: intent.dedupeKey };
        await finish(id, intent, adapter, stopped);
        return ok({ intent, state: await readState(id) });
      }
      return ok({ intent, state: await writeState(id, { state: "indeterminate", indeterminate: { evidence: [`qex status ${state.qexId} failed: ${queried.error.message}`] } }) });
    }
    const job = queried.value;
    if (QEX_TERMINAL_STATES.includes(job.state)) {
      await finish(id, intent, adapter, job);
      return ok({ intent, state: await readState(id) });
    }
    const mapped: JobStateName = job.state === "queued" ? "queued" : "running";
    if (state.state !== mapped) state = await writeState(id, { state: mapped, indeterminate: undefined }, `qex job ${job.id} is ${job.state}`);
    return ok({ intent, state });
  }

  // ---- requests -------------------------------------------------------------------------------------------------------------------

  async function begin(mode: "run" | "catalogue", request: CollectRequest | { requestId: string; repo: string; adapter: string }, raw: Record<string, unknown>): Promise<Result<JobView>> {
    if (!REQUEST_ID.test(request.requestId)) return err("INVALID_ARGUMENT", `"${request.requestId}" is not a request id (letters, digits, dot, dash, underscore; at most 64)`, { errors: [{ code: "PATTERN", pointer: "/requestId", constraint: `pattern: ${REQUEST_ID.source}`, hint: "Use a fresh short id; the same id with the same parameters returns the same job." }] });
    const examples = "examples" in request ? request.examples : [];
    // S3: the bounds the job runs under are min(operator ceiling, SDK default) for EVERY bound, lowered further only by the request; they are
    // resolved BEFORE they are recorded or handed to the worker, and the reply reports what was clamped
    const limits = resolveRequestedLimits("limits" in request ? request.limits : undefined, adapterFor({ repo: request.repo, adapter: request.adapter, examples: [] })?.limitCeilings);
    if (!limits.ok) return limits;
    const params = normalizeParams({ repo: request.repo, adapter: request.adapter, examples, ...("views" in request ? { views: request.views } : {}), limits: limits.value.env }, mode);
    const id = request.requestId;
    const existing = await readIntent(id);
    if (existing !== undefined) {
      if (canonicalJson(existing.params) !== canonicalJson(params)) return err("CONFLICT", `the request id "${id}" already names a collection with different parameters; use a new request id for a deliberate rerun`, { details: { requestId: id } });
      const advanced = await advance(id);
      if (!advanced.ok) return advanced;
      return ok(view(id, advanced.value.intent, advanced.value.state, false));
    }
    const adapter = adapterFor(params);
    if (adapter === undefined) {
      const issue: ValidationIssue = { code: "CONSTRAINT", pointer: "/adapter", constraint: `a registered adapter "${params.adapter}" for repository "${params.repo}"`, hint: `Registering an adapter is an owner action on the command line, never over MCP: paneweft adapter add --session <dir> --file <adapter.json> (or: paneweft adapter list to see what is registered).` };
      return err("NOT_FOUND", `no adapter "${params.adapter}" is registered for repository "${params.repo}"`, { errors: [issue] });
    }
    const catalogue = (await deps.catalogueFor?.(adapter.repo, adapter.id)) ?? null;
    let selection: Selection = { examples: [], views: [] };
    if (mode === "run") {
      const selected = selectExamples(adapter, catalogue, { ...raw, examples: params.examples, ...(params.views === undefined ? {} : { views: params.views }) });
      if (!selected.ok) return selected;
      selection = selected.value;
    }
    const runId = `run-${id}`;
    const stagingDir = join(jobDir(id), "staging", runId);
    const built = buildProcess(adapter, selection, mode, { runId, stagingDir, attempt: 1, ...(params.limits === undefined ? {} : { limits: params.limits }) });
    if (!built.ok) return built;
    const timeoutMs = adapter.limits.timeoutMs;
    const process = adapter.grammar === "cargo-test/1" ? { ...built.value, argv: foldExactFilters(built.value.argv) } : built.value;
    const created = await createIntent(id, params, { selection, process, timeoutMs, runId, stagingDir, limits: limits.value.report });
    if (!created.ok) return created;
    if (!created.value.created) {
      const advanced = await advance(id);
      return advanced.ok ? ok(view(id, advanced.value.intent, advanced.value.state, false)) : advanced;
    }
    await crash("after-intent");
    await mkdir(stagingDir, { recursive: true });
    const root = normalize(join(adapter.workspaceRoot, adapter.entry));
    const fingerprint = await computeFingerprint({ root });
    if (fingerprint.ok) await writeDurably(join(jobDir(id), "fingerprint.before.json"), JSON.stringify(fingerprint.value));
    const submitted = await ensureSubmitted(id, created.value.intent);
    if (!submitted.ok) return submitted;
    return ok(view(id, created.value.intent, submitted.value, true));
  }

  return {
    collect: (request) => begin("run", request, request as unknown as Record<string, unknown>),
    refreshCatalogue: (request) => begin("catalogue", request, {}),

    async status(id, options = {}) {
      if (!REQUEST_ID.test(id)) return err("NOT_FOUND", `no collection job "${id}" in this session`);
      const wait = options.waitSeconds ?? 0;
      if (!Number.isInteger(wait) || wait < 0 || wait > 30) return err("INVALID_ARGUMENT", `waitSeconds must be an integer from 0 to 30 (got ${String(wait)}): a status wait is bounded to 30 seconds`, { errors: [{ code: "OUT_OF_RANGE", pointer: "/waitSeconds", constraint: "maximum: 30", hint: "Call again to keep waiting." }] });
      const deadline = Date.now() + wait * 1000;
      let stopped: QexJob | undefined;
      // A status that waits FOLLOWS the job: it holds the lease for the whole wait, is woken by qex the moment the job stops, and performs
      // the import itself. Other instances that look meanwhile observe the persisted state and never race it.
      const following = wait > 0 && !held.has(id) && (await readIntent(id)) !== undefined && (await takeLease(id));
      if (following) held.add(id);
      try {
      for (;;) {
        if (wait > 0 && !held.has(id) && (await leaseIsLive(id))) {
          // somebody else follows this job: read what they persist
          const intent = await readIntent(id);
          const state = await readState(id);
          if (intent === undefined) return err("NOT_FOUND", `no collection job "${id}" in this session`);
          if ((state !== undefined && TERMINAL_JOB_STATES.includes(state.state)) || Date.now() >= deadline) return ok(view(id, intent, state, false));
          await sleep(100);
          continue;
        }
        const advanced = await advance(id, stopped);
        stopped = undefined;
        if (!advanced.ok) return advanced;
        const { intent, state } = advanced.value;
        if ((state !== undefined && TERMINAL_JOB_STATES.includes(state.state)) || state?.state === "indeterminate" || Date.now() >= deadline) {
          const result = view(id, intent, state, false);
          if (options.maxLogBytes !== undefined || options.logCursor !== undefined) {
            const text = await readFile(join(jobDir(id), "job.log"), "utf8").catch(async () => (state?.qexId ? ((await deps.qex.logs(state.qexId)).ok ? ((await deps.qex.logs(state.qexId)) as { value: string }).value : "") : ""));
            const from = Number(options.logCursor ?? 0);
            const bytes = Buffer.from(text, "utf8");
            const size = options.maxLogBytes ?? 4096;
            const slice = bytes.subarray(Number.isFinite(from) ? from : 0, (Number.isFinite(from) ? from : 0) + size);
            result.log = { text: slice.toString("utf8"), cursor: (Number.isFinite(from) ? from : 0) + size < bytes.length ? String((Number.isFinite(from) ? from : 0) + size) : null };
          }
          return ok(result);
        }
        // Event driven where qex offers it: the instance that waits is woken the moment the job stops and claims the import before any
        // poller could, so the waiter is the one that follows its job to the end.
        const qexId = state?.qexId;
        const remaining = deadline - Date.now();
        if (qexId !== null && qexId !== undefined && state?.state !== "importing" && remaining > 0) {
          const woken = await deps.qex.wait(qexId, Math.min(remaining, 5000));
          if (woken.ok && woken.value !== undefined && QEX_TERMINAL_STATES.includes(woken.value.state)) {
            stopped = woken.value;
            continue;
          }
        }
        await sleep(100);
      }
      } finally {
        if (following) {
          held.delete(id);
          await unlink(join(jobDir(id), "import.lease")).catch(() => undefined);
        }
      }
    },

    async cancel(id) {
      if (!REQUEST_ID.test(id)) return err("NOT_FOUND", `no collection job "${id}" in this session`);
      const intent = await readIntent(id);
      if (intent === undefined) return err("NOT_FOUND", `no collection job "${id}" in this session`);
      let state = await readState(id);
      if (state !== undefined && TERMINAL_JOB_STATES.includes(state.state)) return ok({ outcome: "already-terminal", state: state.state, qexActions: [], ...(state.terminal === undefined ? {} : { collectionStatus: state.terminal.collectionStatus }) });
      if (state?.state === "importing") {
        const lease = await readJson<{ pid: number }>(join(jobDir(id), "import.lease"));
        if (lease !== undefined && alive(lease.pid)) return ok({ outcome: "cancel-too-late", state: "importing", qexActions: [] });
      }
      const adapter = adapterFor(intent.params);
      if (adapter === undefined) return err("NOT_FOUND", `the adapter of job "${id}" is not registered any more`);
      const submitted = await ensureSubmitted(id, intent);
      if (!submitted.ok) return submitted;
      state = submitted.value;
      if (state.qexId === null) return ok({ outcome: "indeterminate", state: state.state, qexActions: [] });
      const qexId = state.qexId;
      const queried = await deps.qex.status(qexId);
      if (queried.ok && QEX_TERMINAL_STATES.includes(queried.value.state)) {
        await finish(id, intent, adapter, queried.value);
        const after = await readState(id);
        return ok({ outcome: after?.state === "cancelled" ? "cancelled" : "cancel-too-late", state: after?.state ?? "importing", qexActions: [], ...(after?.terminal === undefined ? {} : { collectionStatus: after.terminal.collectionStatus }) });
      }
      await writeDurably(join(jobDir(id), "cancel.json"), JSON.stringify({ requested: true, at: now() }));
      const actions: Array<"cancel" | "kill"> = ["cancel"];
      const cancelled = await deps.qex.cancel(qexId);
      if (!cancelled.ok) {
        actions.push("kill");
        const killed = await deps.qex.kill(qexId);
        if (!killed.ok) {
          const again = await deps.qex.status(qexId);
          if (!(again.ok && QEX_TERMINAL_STATES.includes(again.value.state))) return err("RUNNER_FAILED", `neither qex cancel nor qex kill stopped job ${qexId}: ${killed.error.message}`, { retryable: true });
        }
      }
      const deadline = Date.now() + cancelWaitMs;
      let final: QexJob | undefined;
      while (Date.now() < deadline) {
        const check = await deps.qex.status(qexId);
        if (check.ok && QEX_TERMINAL_STATES.includes(check.value.state)) {
          final = check.value;
          break;
        }
        await sleep(50);
      }
      if (final === undefined) return ok({ outcome: "indeterminate", state: "running", qexActions: actions });
      await finish(id, intent, adapter, final);
      const after = await readState(id);
      const result: CancelResult = { outcome: "cancelled", state: after?.state ?? "cancelled", qexActions: actions, ...(after?.terminal === undefined ? {} : { collectionStatus: after.terminal.collectionStatus }) };
      await writeState(id, { state: result.state, cancel: { outcome: result.outcome, qexActions: actions } });
      return ok(result);
    },
  };
}

export { rm, writeFile };
