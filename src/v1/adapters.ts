// Registered collection adapters: selection safety, argv grammars, reconciliation of native results (IV16, IV17, IV18; amendments S6, N4).
// An adapter record is owner configuration (CLI-only registration). Selectors are data; the grammar is code. Nothing here spawns a shell.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareCodeUnits } from "../core/canonical.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Adapter } from "../generated/v1/Adapter.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { validateAgainstV1 } from "./schemas.ts";

const run = promisify(execFile);

export type AdapterRecord = Adapter;

/** The host-owned script that runs `tsc --noEmit` and then vitest as ONE queue job (the repository cannot replace it). */
export const VITEST_COLLECT_SCRIPT = fileURLToPath(new URL("../../scripts/collect-vitest.mjs", import.meta.url));

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// ---- registration (CLI-only) ------------------------------------------------------------------------------------------------------

const adaptersFile = (sessionDir: string): string => join(sessionDir, "adapters.json");

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

export async function loadAdapters(sessionDir: string): Promise<Result<AdapterRecord[]>> {
  let text: string;
  try {
    text = await readFile(adaptersFile(sessionDir), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err("STORAGE_FAILED", `adapters.json is unreadable: ${(cause as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as { adapters?: unknown };
    if (!Array.isArray(parsed.adapters)) return err("STORAGE_CORRUPT", "adapters.json has no adapters array");
    return ok(parsed.adapters as AdapterRecord[]);
  } catch {
    return err("STORAGE_CORRUPT", "adapters.json is not valid JSON");
  }
}

/** Writes `<sessionDir>/adapters.json` atomically. CLI-only: no MCP tool calls it. A record replaces the one with its id. */
export async function registerAdapter(sessionDir: string, record: unknown): Promise<Result<AdapterRecord>> {
  const issues = validateAgainstV1("urn:paneweft:schema:v1:adapter:1", record);
  if (issues.length > 0) return err("VALIDATION_FAILED", "the adapter record does not match paneweft.adapter/1", { errors: issues });
  const adapter = record as AdapterRecord;
  const entry = normalize(adapter.entry);
  if (isAbsolute(adapter.entry) || entry === ".." || entry.startsWith("../") || entry.split("/").includes("..")) {
    return err("INVALID_ARGUMENT", `the adapter entry "${adapter.entry}" must stay inside the workspace root`, { errors: [{ code: "CONSTRAINT", pointer: "/entry", constraint: "relative to workspaceRoot, no .. segment", hint: "Use a directory below the workspace root, or register another root." }] });
  }
  const existing = await loadAdapters(sessionDir);
  if (!existing.ok) return existing;
  const adapters = [...existing.value.filter((candidate) => candidate.id !== adapter.id), adapter].sort((a, b) => compareCodeUnits(a.id, b.id));
  await writeAtomically(adaptersFile(sessionDir), `${JSON.stringify({ adapters }, null, 2)}\n`);
  return ok(adapter);
}

// ---- selection --------------------------------------------------------------------------------------------------------------------

export type ExampleSelector = Catalogue["examples"][number]["selector"];
export interface Selection {
  examples: Array<{ id: string; selector: ExampleSelector }>;
  views: string[];
}

/** Request members that could install a runner, change the root or smuggle a command. They are refused by name. */
const FORBIDDEN_MEMBERS = ["executable", "argv", "runner", "workspaceRoot", "cwd", "env", "shell", "command"] as const;
const ALLOWED_MEMBERS = new Set(["examples", "views", "requestId", "repo", "adapter", "limits"]);

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const held = row[j] as number;
      row[j] = Math.min(held + 1, (row[j - 1] as number) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = held;
    }
  }
  return row[b.length] as number;
}

/** Validates a collect request's selectors BEFORE anything runs: ids are `^[a-z0-9][a-z0-9._-]{0,127}$`; every id must be in the
 * catalogue when one exists; unknown ids list candidates; argv-shaped ids, shell metacharacters, path separators and unknown
 * request members (executable, argv, runner, root) are refused with INVALID_ARGUMENT/FORBIDDEN_PROPERTY issues. */
export function selectExamples(adapter: AdapterRecord, catalogue: Catalogue | null, request: Record<string, unknown>): Result<Selection> {
  const checked = checkCollectRequest(request);
  if (!checked.ok) return checked;
  const { examples: ids, views } = checked.value;
  const selected: Selection["examples"] = [];
  for (const id of ids) {
    const declared = catalogue?.examples.find((candidate) => candidate.id === id);
    if (declared !== undefined) {
      selected.push({ id, selector: declared.selector });
      continue;
    }
    if (catalogue === null && adapter.kind === "vitest") {
      selected.push({ id, selector: { runner: "vitest", name: `example:${id}` } });
      continue;
    }
    if (catalogue === null) return err("NOT_FOUND", `no catalogue is stored for repository "${adapter.repo}" and adapter "${adapter.id}", so "${id}" cannot be resolved to a test`);
    const known = catalogue.examples.map((candidate) => candidate.id);
    const candidates = known.map((candidate) => ({ candidate, d: distance(id, candidate) })).sort((a, b) => a.d - b.d || compareCodeUnits(a.candidate, b.candidate)).slice(0, 5).map((entry) => entry.candidate);
    return err("NOT_FOUND", `the example "${id}" is not declared in the catalogue (catalogue ${catalogue.digest.slice(0, 12)}, target ${catalogue.target.target ?? "all"}); pick one of the candidates, or declare the example in the repository and collect again (a collection exports the catalogue itself)`, { details: { candidates, unknown: id } });
  }
  const targets = new Set(selected.map((entry) => `${entry.selector.package ?? ""}\u0000${entry.selector.target ?? ""}`));
  if (targets.size > 1) return err("INVALID_ARGUMENT", "these examples belong to different targets and cannot share one process in week one: collect each target separately", { details: { targets: [...targets].map((target) => target.replace("\u0000", " / ")) } });
  if (catalogue !== null) {
    const declared = new Set(catalogue.views.map((view) => view.id));
    const unknownView = views.find((view) => !declared.has(view));
    if (unknownView !== undefined) return err("NOT_FOUND", `the view "${unknownView}" is not declared in the catalogue`, { details: { candidates: [...declared].sort(compareCodeUnits).slice(0, 8) } });
  }
  return ok({ examples: selected, views });
}

/** The shape of a collect request, decided before anything runs and without any catalogue: member names and id patterns (CLAIM(T4-run-exports)). Returns the
 * sorted, de-duplicated example ids and the sorted view ids. */
export function checkCollectRequest(request: Record<string, unknown>): Result<{ examples: string[]; views: string[] }> {
  const issues: ValidationIssue[] = [];
  for (const member of Object.keys(request)) {
    if ((FORBIDDEN_MEMBERS as readonly string[]).includes(member)) issues.push({ code: "FORBIDDEN_PROPERTY", pointer: `/${member}`, constraint: "the owner's adapter fixes the executable, argv, runner, root and environment", hint: "Remove it. Select declared example ids; register adapters with the CLI." });
    else if (!ALLOWED_MEMBERS.has(member)) issues.push({ code: "UNKNOWN_PROPERTY", pointer: `/${member}`, constraint: "a collect request names examples, views, limits", hint: "Remove the unknown member." });
  }
  const examples = request.examples;
  if (!Array.isArray(examples) || examples.length === 0) issues.push({ code: "REQUIRED", pointer: "/examples", constraint: "a non-empty array of example ids", hint: "Select at least one declared example; a collection with nothing selected demonstrates nothing." });
  else examples.forEach((id, index) => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) issues.push({ code: "PATTERN", pointer: `/examples/${index}`, constraint: `pattern: ${ID_PATTERN.source}`, hint: "An example id is a lowercase catalogue id (letters, digits, dots, dashes); it is data, never argv or a path." });
  });
  const views = request.views === undefined ? [] : request.views;
  if (!Array.isArray(views)) issues.push({ code: "TYPE", pointer: "/views", constraint: "type: array", hint: "views is an array of view ids." });
  else views.forEach((id, index) => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) issues.push({ code: "PATTERN", pointer: `/views/${index}`, constraint: `pattern: ${ID_PATTERN.source}`, hint: "A view id is a lowercase catalogue id." });
  });
  if (issues.length > 0) return err("INVALID_ARGUMENT", `the collect request is not acceptable (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues });
  return ok({ examples: [...new Set(examples as string[])].sort(compareCodeUnits), views: [...(views as string[])].sort(compareCodeUnits) });
}

// ---- argv grammars ----------------------------------------------------------------------------------------------------------------

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
  /** Limit overrides handed to the SDK in the worker (they can only lower a bound). */
  limits?: Record<string, number>;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** cargo-test/1 and vitest-run/1 (docs/v1-red-contract.md section 9). Pure; no shell; literal elements. */
export function buildProcess(adapter: AdapterRecord, selection: Selection, mode: "run" | "catalogue", runtime: Runtime): Result<ProcessSpec> {
  const root = adapter.workspaceRoot;
  const packageDir = normalize(join(root, adapter.entry));
  const env: Record<string, string> = { PANEWEFT_ATTEMPT: String(runtime.attempt), PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: runtime.runId, PANEWEFT_STAGING_DIR: runtime.stagingDir };
  if (runtime.limits !== undefined && Object.keys(runtime.limits).length > 0) env.PANEWEFT_LIMITS = JSON.stringify(runtime.limits);
  if (mode === "catalogue") env.PANEWEFT_CATALOGUE = "1";
  if (adapter.grammar === "cargo-test/1") {
    const argv = ["test", "--manifest-path", join(packageDir, "Cargo.toml")];
    if (adapter.features.length > 0) argv.push("--features", adapter.features.join(","));
    if (mode === "catalogue") argv.push("--lib", "--tests", "--", "paneweft_catalogue_export", "--test-threads=1");
    else {
      const target = selection.examples[0]?.selector.target;
      if (selection.examples.length === 0) return err("INVALID_ARGUMENT", "a cargo collection selects at least one example");
      argv.push(...(target === undefined || target === "lib" ? ["--lib"] : ["--test", target]), "--");
      for (const example of selection.examples) argv.push("--exact", example.selector.name);
      argv.push("--test-threads=1");
    }
    return ok({ executable: adapter.executable, argv, cwd: root, env: { CARGO_TERM_COLOR: "never", ...env } });
  }
  const argv = [VITEST_COLLECT_SCRIPT, "--staging", runtime.stagingDir, "--root", packageDir, "--tsconfig", "tsconfig.json"];
  if (mode === "catalogue") argv.push("--catalogue", "--manifest", "paneweft.views.ts");
  else {
    if (selection.examples.length === 0) return err("INVALID_ARGUMENT", "a vitest collection selects at least one example");
    argv.push("--vitest", join(packageDir, "node_modules/vitest/vitest.mjs"), "--config", "vitest.config.ts", "--name-pattern", selection.examples.map((example) => `^${escapeRegex(example.selector.name)}$`).join("|"));
  }
  return ok({ executable: adapter.executable, argv, cwd: packageDir, env });
}

/** libtest accepts `--exact` ONCE ("Option 'exact' given more than once") and then any number of test names, whereas the cargo-test/1
 * grammar states one `--exact <name>` pair per example. The pure grammar keeps its pairs; this folds them into the single form the real
 * binary takes, at the moment a process is handed to the queue. */
export function foldExactFilters(argv: string[]): string[] {
  const split = argv.indexOf("--");
  if (split < 0) return argv;
  const head = argv.slice(0, split + 1);
  const names: string[] = [];
  const rest: string[] = [];
  const tail = argv.slice(split + 1);
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] === "--exact" && index + 1 < tail.length) {
      names.push(tail[index + 1] as string);
      index += 1;
    } else rest.push(tail[index] as string);
  }
  return names.length === 0 ? argv : [...head, "--exact", ...names, ...rest];
}

// ---- reconciliation (S6) ----------------------------------------------------------------------------------------------------------

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

type Invocation = TestRun["invocations"][number];
type Outcome = TestRun["examples"][number]["outcome"];
type Suite = TestRun["suites"][number];

const FAILING: ReadonlyArray<Outcome> = ["failed", "error", "blocked"];

interface ReportedTest { name: string; state: string; errors?: string[]; retries?: number }
interface VitestReport { tests?: ReportedTest[]; suites?: Array<{ file?: string; phase: Suite["phase"]; outcome: string; message?: string; examples?: string[] }>; unhandledErrors?: string[] }

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

function synthetic(id: string, exampleId: string, outcome: Outcome, message: string | undefined, startedAt?: string): Invocation {
  return { id, exampleId, attempt: 1, parent: null, native: message === undefined ? { outcome } : { outcome, message }, capture: { outcome: "none", diagnostics: [] }, checks: [], verified: false, ...(startedAt === undefined ? {} : { startedAt }), finishedAt: null } as Invocation;
}

/** Builds the TestRun (S6 levels) from worker artifacts and the runner's own result. Derives `verified`, counts, priorFailures,
 * suiteFailedAfter and the collection status; synthesizes records for examples that never completed. The runner version, features and
 * input fingerprint are placeholders here: the job service, which knows them, overwrites them. */
export function reconcile(kind: "cargo" | "vitest", input: ReconcileInput): Result<TestRun> {
  const report: VitestReport = kind === "vitest" && input.native !== null && typeof input.native === "object" ? (input.native as VitestReport) : {};
  const invocations: Invocation[] = [];
  const byExample = new Map<string, Invocation[]>();
  const missing: string[] = [];
  const add = (invocation: Invocation): void => {
    invocations.push(invocation);
    byExample.set(invocation.exampleId, [...(byExample.get(invocation.exampleId) ?? []), invocation]);
  };
  const cut = input.exit.timedOut || input.exit.cancelled;
  const cutOutcome: Outcome = "cancelled";
  const completedIds = new Set<string>();
  for (const entry of input.invocations) {
    const source = entry.completed ?? entry.started;
    if (source === null) continue;
    const exampleId = String(source.exampleId);
    if (entry.completed !== null) {
      const completed = pick(entry.completed, ["id", "exampleId", "attempt", "parent", "native", "capture", "checks", "expectedFailure", "result", "startedAt", "finishedAt"]) as Record<string, unknown>;
      const checks = (completed.checks as Array<{ claim: string; passed: boolean }> | undefined) ?? [];
      const nativeOutcome = (completed.native as { outcome: Outcome }).outcome;
      const capture = (completed.capture as { outcome: string } | undefined) ?? { outcome: "none" };
      const verified = nativeOutcome === "passed" && checks.length > 0 && checks.every((check) => check.passed) && capture.outcome === "captured";
      add({ ...completed, checks, verified } as unknown as Invocation);
      completedIds.add(exampleId);
    } else {
      add(synthetic(String(entry.started?.id), exampleId, cut ? cutOutcome : "error", cut ? undefined : "worker aborted before completion", String(entry.started?.startedAt ?? "")));
      missing.push(exampleId);
    }
  }
  const skipped = new Set(input.skipped);
  const filtered = new Set(input.filtered);
  const selected = [...new Set(input.selected)];
  for (const id of selected) {
    if (byExample.has(id)) continue;
    if (skipped.has(id)) add(synthetic(`skipped-${id}`.slice(0, 128), id, "skipped", undefined));
    else if (filtered.has(id)) add(synthetic(`filtered-${id}`.slice(0, 128), id, "filtered", undefined));
    else if (input.compile === "failed") {
      add(synthetic(`not-run-${id}`.slice(0, 128), id, "error", "not run: compile failed"));
      missing.push(id);
    } else {
      const reported = [...(report.tests ?? [])].reverse().find((test) => test.name === input.testNames[id]);
      if (reported?.state === "skipped") add(synthetic(`skipped-${id}`.slice(0, 128), id, "skipped", undefined));
      else {
        add(synthetic(`not-run-${id}`.slice(0, 128), id, cut ? cutOutcome : "error", cut ? undefined : "worker aborted before completion"));
        missing.push(id);
      }
    }
  }
  // vitest: the reporter has the FINAL native result after hooks; a test it calls failed while the body passed is an error.
  if (kind === "vitest") {
    for (const [exampleId, attempts] of byExample) {
      const last = attempts[attempts.length - 1] as Invocation;
      if (last.native.outcome !== "passed") continue;
      const reported = [...(report.tests ?? [])].reverse().find((test) => test.name === input.testNames[exampleId]);
      if (reported?.state === "failed") {
        last.native = { outcome: "error", message: `the test failed after the example body returned: ${(reported.errors ?? ["unknown failure"]).join("; ")}`.slice(0, 2000) };
        last.verified = false;
      }
    }
  }
  const suites: Suite[] = [];
  const suiteId = (phase: string): string => {
    const base = `suite-${phase}`;
    let id = base;
    for (let n = 2; suites.some((suite) => suite.id === id); n += 1) id = `${base}-${n}`;
    return id;
  };
  const finalOf = (id: string): Invocation => (byExample.get(id) as Invocation[]).slice(-1)[0] as Invocation;
  const exampleIds = [...byExample.keys()];
  if (missing.length > 0 && !cut && input.compile === "ok") suites.push({ id: suiteId("binary"), phase: "binary", outcome: "aborted", message: "the test process ended before every selected example completed", examples: [...new Set(missing)] });
  for (const reported of report.suites ?? []) suites.push({ id: suiteId(reported.phase), phase: reported.phase, outcome: "failed", ...(reported.message === undefined ? {} : { message: reported.message }), examples: reported.examples ?? [] });
  if ((report.unhandledErrors ?? []).length > 0) suites.push({ id: suiteId("run"), phase: "run", outcome: "failed", message: (report.unhandledErrors as string[])[0] as string, examples: exampleIds.filter((id) => finalOf(id).native.outcome === "passed") as Suite["examples"] });
  const explained = exampleIds.some((id) => FAILING.includes(finalOf(id).native.outcome as Outcome)) || missing.length > 0 || cut || input.compile === "failed" || suites.length > 0;
  const unexplainedSignal = input.exit.signal !== null && !cut && input.compile === "ok" && missing.length === 0;
  if (unexplainedSignal || !explained && input.exit.code !== null && input.exit.code !== 0) suites.push({ id: suiteId("binary"), phase: "binary", outcome: "failed", message: input.exit.signal !== null ? `the test process was terminated by ${input.exit.signal} after every example had finished` : `the test process exited with status ${input.exit.code} after every example had finished`, examples: exampleIds.filter((id) => finalOf(id).native.outcome === "passed") });
  const examples: TestRun["examples"] = [];
  for (const id of [...selected, ...exampleIds.filter((candidate) => !selected.includes(candidate))]) {
    const attempts = byExample.get(id) as Invocation[];
    const final = attempts[attempts.length - 1] as Invocation;
    const failedAfter = suites.filter((suite) => suite.outcome === "failed" && suite.examples.includes(id)).map((suite) => suite.id);
    if (failedAfter.length > 0) final.verified = false;
    examples.push({ id, attempts: attempts.map((attempt) => attempt.id) as TestRun["examples"][number]["attempts"], final: final.id, outcome: final.native.outcome as Outcome, verified: final.verified, priorFailures: attempts.slice(0, -1).filter((attempt) => FAILING.includes(attempt.native.outcome as Outcome)).map((attempt) => attempt.id), suiteFailedAfter: failedAfter });
  }
  const chosen = examples.filter((example) => selected.includes(example.id));
  const count = (outcome: Outcome): number => chosen.filter((example) => example.outcome === outcome).length;
  const finals = chosen.map((example) => ({ example, invocation: finalOf(example.id) }));
  const missingCount = new Set(missing).size;
  const captureFailed = finals.some(({ invocation }) => invocation.native.outcome === "passed" && invocation.capture.outcome === "failed");
  const selectedFailed = chosen.some((example) => FAILING.includes(example.outcome) || example.outcome === "cancelled");
  let status: TestRun["collection"]["status"];
  if (input.compile === "failed") status = "failed";
  else if (input.exit.timedOut) status = "timed-out";
  else if (input.exit.cancelled) status = "cancelled";
  else if (missingCount > 0) status = "incomplete";
  else if (selectedFailed || captureFailed || suites.some((suite) => suite.outcome === "failed") || selected.length === 0) status = "failed";
  else status = "succeeded";
  const document: TestRun = {
    schemaVersion: "paneweft.test-run/1",
    runId: input.runId,
    collectionId: null,
    runner: { id: kind, version: "unknown", features: [] },
    inputFingerprint: { digest: "0".repeat(64), memberCount: 0, sampledConsistency: "unverified" },
    collection: {
      status,
      exitCode: input.exit.code,
      signal: input.exit.signal,
      timedOut: input.exit.timedOut,
      cancelled: input.exit.cancelled,
      compile: input.compile,
      complete: missingCount === 0 && input.compile === "ok",
      missingInvocations: missingCount,
      counts: {
        selected: selected.length,
        passed: count("passed"),
        failed: count("failed"),
        error: count("error"),
        skipped: count("skipped"),
        filtered: count("filtered"),
        cancelled: count("cancelled"),
        blocked: count("blocked"),
        verified: chosen.filter((example) => example.verified).length,
        exploratory: finals.filter(({ example, invocation }) => example.outcome === "passed" && invocation.checks.length === 0).length,
      },
    },
    suites,
    examples,
    invocations,
  };
  return ok(document);
}

/** The cargo-specific lists `reconcile` needs, read from libtest's stdout: an `ignored` line is skipped; a selected example with no line,
 * no worker record and a clean exit was filtered out before the runner reached it. */
export function parseCargoLists(stdout: string, input: { selected: string[]; testNames: Record<string, string>; started: Set<string>; exitCode: number | null; compile: "ok" | "failed" }): { skipped: string[]; filtered: string[] } {
  const skipped: string[] = [];
  const filtered: string[] = [];
  for (const id of input.selected) {
    const name = input.testNames[id];
    if (name === undefined) continue;
    const lines = stdout.split("\n").filter((line) => line.startsWith("test ") && line.includes(name));
    if (lines.some((line) => line.trimEnd().endsWith("ignored") || / ignored(,|$)/.test(line))) skipped.push(id);
    else if (lines.length === 0 && !input.started.has(id) && input.exitCode === 0 && input.compile === "ok") filtered.push(id);
  }
  return { skipped, filtered };
}

// ---- instrumentation checks (IV18) ------------------------------------------------------------------------------------------------

async function execute(executable: string, argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(executable, argv, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(cause) };
  }
}

const MAX_DIAGNOSTICS = 50;

/** Compiles/typechecks the instrumentation with the declared features (`cargo check --features ...` / `tsc --noEmit -p`). The
 * diagnostics point at the author's file and line. */
export async function checkInstrumentation(adapter: AdapterRecord): Promise<Result<{ ok: boolean; diagnostics: Diagnostic[] }>> {
  const packageDir = normalize(join(adapter.workspaceRoot, adapter.entry));
  const diagnostics: Diagnostic[] = [];
  if (adapter.grammar === "cargo-test/1") {
    const argv = ["check", "--manifest-path", join(packageDir, "Cargo.toml"), ...(adapter.features.length > 0 ? ["--features", adapter.features.join(",")] : []), "--lib", "--tests", "--message-format", "json", "--color", "never"];
    const result = await execute(adapter.executable, argv, adapter.workspaceRoot);
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let message: { reason?: string; message?: { level?: string; message?: string; rendered?: string; spans?: Array<{ file_name: string; line_start: number; column_start: number; is_primary: boolean }> } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.reason !== "compiler-message" || message.message?.level !== "error") continue;
      const span = message.message.spans?.find((candidate) => candidate.is_primary) ?? message.message.spans?.[0];
      const path = span === undefined ? undefined : isAbsolute(span.file_name) ? relative(packageDir, span.file_name) : span.file_name;
      diagnostics.push({ id: `diag-compiler-${diagnostics.length + 1}`, category: "compiler", message: String(message.message.message ?? "compiler error").slice(0, 2000), ...(span === undefined || path === undefined ? {} : { source: { path, line: span.line_start, column: span.column_start } }), stderrSlice: String(message.message.rendered ?? "").slice(0, 4000), nextAction: "Fix the named field or type in the view source, then run the collection again; the compiler error points at the line to change." } as Diagnostic);
      if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    }
    if (result.code !== 0 && diagnostics.length === 0) diagnostics.push({ id: "diag-compiler-1", category: "compiler", message: `cargo check failed (exit ${result.code}) without a compiler message`, stderrSlice: result.stderr.slice(-4000), nextAction: "Read the stderr slice; the build could not start." } as Diagnostic);
    return ok({ ok: result.code === 0 && diagnostics.length === 0, diagnostics });
  }
  const local = join(packageDir, "node_modules/typescript/lib/tsc.js");
  const tsc = await readFile(local).then(() => local, () => fileURLToPath(new URL("../../node_modules/typescript/lib/tsc.js", import.meta.url)));
  const result = await execute(adapter.executable, [tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], packageDir);
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (match === null) continue;
    diagnostics.push({ id: `diag-typecheck-${diagnostics.length + 1}`, category: "typecheck", message: `${match[4]}: ${match[5]}`.slice(0, 2000), source: { path: (match[1] as string).replace(/\\/g, "/"), line: Number(match[2]), column: Number(match[3]) }, nextAction: "Fix the named property or type in the view source, then run the collection again." } as Diagnostic);
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  if (result.code !== 0 && diagnostics.length === 0) diagnostics.push({ id: "diag-typecheck-1", category: "typecheck", message: `tsc failed (exit ${result.code}) without a located error`, stderrSlice: `${result.stdout}${result.stderr}`.slice(-4000), nextAction: "Read the stderr slice; the typecheck could not run." } as Diagnostic);
  return ok({ ok: result.code === 0 && diagnostics.length === 0, diagnostics });
}
