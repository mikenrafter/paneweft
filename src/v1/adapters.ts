// Registered collection adapters: selection safety, argv grammars, reconciliation of native results (IV16, IV17; amendments S6, N4).
// An adapter record is owner configuration (CLI-only registration). Selectors are data; the grammar is code.
import { fileURLToPath } from "node:url";
import type { Result } from "../core/errors.ts";
import type { Adapter } from "../generated/v1/Adapter.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { notImplemented } from "./stub.ts";

export type AdapterRecord = Adapter;

/** The host-owned script that runs `tsc --noEmit` and then vitest as ONE queue job (the repository cannot replace it). */
export const VITEST_COLLECT_SCRIPT = fileURLToPath(new URL("../../scripts/collect-vitest.mjs", import.meta.url));

/** Writes `<sessionDir>/adapters.json` atomically. CLI-only: no MCP tool calls it. STUB. */
export function registerAdapter(sessionDir: string, record: unknown): Promise<Result<AdapterRecord>> {
  return Promise.resolve(notImplemented("registerAdapter"));
}

export function loadAdapters(sessionDir: string): Promise<Result<AdapterRecord[]>> {
  return Promise.resolve(notImplemented("loadAdapters"));
}

export type ExampleSelector = Catalogue["examples"][number]["selector"];
export interface Selection {
  examples: Array<{ id: string; selector: ExampleSelector }>;
  views: string[];
}

/** Validates a collect request's selectors BEFORE anything runs: ids are `^[a-z0-9][a-z0-9._-]{0,127}$`; every id must be in the
 * catalogue when one exists; unknown ids list candidates; argv-shaped ids, shell metacharacters, path separators and unknown
 * request members (executable, argv, runner, root) are refused with INVALID_ARGUMENT/FORBIDDEN_PROPERTY issues. STUB. */
export function selectExamples(adapter: AdapterRecord, catalogue: Catalogue | null, request: Record<string, unknown>): Result<Selection> {
  return notImplemented("selectExamples");
}

export interface ProcessSpec {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Runtime {
  runId: string;
  stagingDir: string;
  attempt: number;
}

/** cargo-test/1 and vitest-run/1 (docs/v1-red-contract.md section 9). Pure; no shell; literal elements. STUB. */
export function buildProcess(adapter: AdapterRecord, selection: Selection, mode: "run" | "catalogue", runtime: Runtime): Result<ProcessSpec> {
  return notImplemented("buildProcess");
}

export interface ReconcileInput {
  runId: string;
  selected: string[];
  testNames: Record<string, string>;
  exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean };
  compile: "ok" | "failed";
  skipped: string[];
  filtered: string[];
  invocations: Array<{ started: Record<string, unknown> | null; completed: Record<string, unknown> | null }>;
  /** cargo: the stdout text. vitest: the reporter.json document, or {typecheck: {...}} when the typecheck step failed. */
  native: unknown;
}

/** Builds the TestRun (S6 levels) from worker artifacts and the runner's own result. Derives `verified`, counts, priorFailures,
 * suiteFailedAfter and the collection status; synthesizes records for examples that never completed. STUB. */
export function reconcile(kind: "cargo" | "vitest", input: ReconcileInput): Result<TestRun> {
  return notImplemented("reconcile");
}

/** Compiles/typechecks the instrumentation with the declared features (`cargo check --features ...` / `tsc --noEmit -p`). The
 * diagnostics point at the author's file and line. STUB. */
export function checkInstrumentation(adapter: AdapterRecord): Promise<Result<{ ok: boolean; diagnostics: Diagnostic[] }>> {
  return Promise.resolve(notImplemented("checkInstrumentation"));
}
