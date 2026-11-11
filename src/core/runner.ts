// Owner-configured local runners (design section 5, owner question 4).
// CLAIM(no-payload-exec): runners come only from the owner's registry file; submitted documents
//   cannot install or execute one [design section 5; example.test.ts, MC17].
// A runner is spawned WITHOUT a shell: argv elements are literal; `{param:name}` inside an element
// is replaced by the parameter value; the run id is passed as env PANEWEFT_RUN_ID; the runner writes
// a paneweft.run/1 document to outputBundlePath (relative to workspaceRoot); a stale output file is
// removed before the run; exceeding timeoutMs kills the process.
//
// CLAIM(runner-timeout-kills-group): the runner is started as the leader of its own process group (`detached`), and a timeout or an abort
//   SIGKILLs the whole group, so helpers the runner started die with it [runner.process-group.test.ts, T12]. The cost of `detached`: a terminal's
//   Ctrl-C no longer reaches the runner, so the CLI turns SIGINT/SIGTERM into an abort.
//
// CLAIM(run-id-bound): the run id is generated here, handed to the runner, and the recorded output must carry exactly that id, so a
//   runner cannot record under another run's identity or replay a stale document [runner.test.ts, MC17].
// Errors (all Result values, never exceptions): RUNNER_NOT_FOUND, INVALID_ARGUMENT (parameters), RUNNER_TIMEOUT, RUNNER_FAILED
//   (details.exitCode / signal / spawn reason), RUNNER_OUTPUT_INVALID (the validation issues in `errors`).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Scalar } from "./wire.ts";
import type { RecordedRun, Session, ViewKey } from "./session.ts";
import type { OperationError, Result, ValidationIssue } from "./errors.ts";
import { validateAgainstOwnerSchema } from "./validate.ts";

export interface RunnerDefinition {
  id: string;
  executable: string;
  argv: string[];
  workspaceRoot: string;
  parameterSchema: Record<string, unknown>;
  timeoutMs: number;
  outputBundlePath: string;
}

const failure = (code: OperationError["code"], message: string, extra: { errors?: ValidationIssue[]; retryable?: boolean; details?: Record<string, unknown> } = {}): { ok: false; error: OperationError } => ({
  ok: false,
  error: { schemaVersion: "paneweft.error/1", code, message, errors: extra.errors ?? [], retryable: extra.retryable ?? false, ...(extra.details === undefined ? {} : { details: extra.details }) },
});

/** Registry file format: `{ "runners": RunnerDefinition[] }`. */
export async function loadRunnerRegistry(file: string): Promise<Result<RunnerDefinition[]>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return failure("RUNNER_NOT_FOUND", `the runner registry file "${file}" does not exist or cannot be read`);
  }
  try {
    const parsed = JSON.parse(text) as { runners?: unknown };
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.runners)) throw new Error('expected {"runners": [...]}');
    return { ok: true, value: parsed.runners as RunnerDefinition[] };
  } catch (error) {
    return failure("INVALID_ARGUMENT", `the runner registry file "${file}" is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RunExampleRequest {
  runnerRegistryFile: string;
  runnerId: string;
  parameters: Record<string, Scalar>;
  key: ViewKey;
  /** Aborting kills the runner's whole process group and answers RUNNER_FAILED (details.aborted). */
  signal?: AbortSignal;
}

/** Substitutes `{param:name}` in one pass. A placeholder naming a parameter that was not supplied is reported, not guessed. */
function substitute(argv: string[], parameters: Record<string, Scalar>): { argv: string[] } | { issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const result = argv.map((element) =>
    element.replace(/\{param:([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
      if (!Object.hasOwn(parameters, name)) {
        issues.push({ code: "REQUIRED", pointer: `/parameters/${name}`, constraint: `required: ${name}`, hint: `The runner's argv uses ${placeholder}; supply a value for "${name}".` });
        return placeholder;
      }
      return String(parameters[name]);
    }),
  );
  return issues.length > 0 ? { issues } : { argv: result };
}

type ProcessOutcome = { kind: "exited"; exitCode: number | null; signal: NodeJS.Signals | null } | { kind: "timeout" } | { kind: "aborted" } | { kind: "spawn-failed"; reason: string }

/** SIGKILL to the runner's whole process group (the runner leads it, so the group id is its pid); only the runner itself when that fails. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runProcess(runner: RunnerDefinition, argv: string[], runId: string, signal?: AbortSignal): Promise<ProcessOutcome> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const settle = (outcome: ProcessOutcome) => { if (!settled) { settled = true; resolveOutcome(outcome); } };
    // no shell: the executable and every argv element are literal
    const child = spawn(runner.executable, argv, { cwd: runner.workspaceRoot, env: { ...process.env, PANEWEFT_RUN_ID: runId }, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    let ended: "timeout" | "aborted" | null = null;
    const stop = (reason: "timeout" | "aborted") => { if (ended === null) { ended = reason; killGroup(child); } };
    const timer = setTimeout(() => stop("timeout"), runner.timeoutMs);
    const onAbort = () => stop("aborted");
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.once("error", (error) => { done(); settle({ kind: "spawn-failed", reason: error.message }); });
    child.once("exit", (exitCode, exitSignal) => { done(); settle(ended === "timeout" ? { kind: "timeout" } : ended === "aborted" ? { kind: "aborted" } : { kind: "exited", exitCode, signal: exitSignal }); });
  });
}

/** Runs the runner, validates its output, records the run. */
export async function runExample(session: Session, request: RunExampleRequest): Promise<Result<RecordedRun>> {
  const registry = await loadRunnerRegistry(request.runnerRegistryFile);
  if (!registry.ok) return registry;
  const runner = registry.value.find((candidate) => candidate.id === request.runnerId);
  if (runner === undefined) return failure("RUNNER_NOT_FOUND", `the owner's runner registry has no runner "${request.runnerId}"`);

  const parameterIssues = validateAgainstOwnerSchema(runner.parameterSchema, request.parameters, "/parameters");
  if (parameterIssues.length > 0) return failure("INVALID_ARGUMENT", `the parameters do not satisfy the parameter schema of runner "${runner.id}"`, { errors: parameterIssues });
  const substituted = substitute(runner.argv, request.parameters);
  if ("issues" in substituted) return failure("INVALID_ARGUMENT", `the argv of runner "${runner.id}" uses parameters that were not supplied`, { errors: substituted.issues });

  const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const outputPath = resolve(runner.workspaceRoot, runner.outputBundlePath);
  await rm(outputPath, { force: true }); // CLAIM(run-id-bound): nothing written before this run can be mistaken for its output

  const outcome = await runProcess(runner, substituted.argv, runId, request.signal);
  if (outcome.kind === "spawn-failed") return failure("RUNNER_FAILED", `runner "${runner.id}" could not be started: ${outcome.reason}`, { details: { reason: outcome.reason } });
  if (outcome.kind === "aborted") return failure("RUNNER_FAILED", `runner "${runner.id}" was stopped before it finished`, { details: { aborted: true } });
  if (outcome.kind === "timeout") return failure("RUNNER_TIMEOUT", `runner "${runner.id}" did not finish within ${runner.timeoutMs} ms and was killed`, { retryable: true, details: { timeoutMs: runner.timeoutMs } });
  if (outcome.exitCode !== 0) {
    return failure("RUNNER_FAILED", `runner "${runner.id}" ${outcome.exitCode === null ? `was terminated by ${outcome.signal}` : `exited with code ${outcome.exitCode}`}`, { details: { exitCode: outcome.exitCode, signal: outcome.signal } });
  }

  let text: string;
  try {
    text = await readFile(outputPath, "utf8");
  } catch {
    return failure("RUNNER_OUTPUT_INVALID", `runner "${runner.id}" finished without writing ${runner.outputBundlePath}`);
  }
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch (error) {
    return failure("RUNNER_OUTPUT_INVALID", `runner "${runner.id}" wrote output that is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reportedId = (output as { run?: { runId?: unknown } } | null)?.run?.runId;
  if (reportedId !== runId) {
    return failure("RUNNER_OUTPUT_INVALID", `runner "${runner.id}" reported run id ${JSON.stringify(reportedId)}, not the ${runId} it was given`, {
      errors: [{ code: "CONSTRAINT", pointer: "/run/runId", constraint: `const: ${JSON.stringify(runId)}`, hint: "Copy the PANEWEFT_RUN_ID environment variable into run.runId." }],
    });
  }
  const recorded = await session.recordExampleRun(request.key, output);
  if (!recorded.ok && recorded.error.code === "VALIDATION_FAILED") {
    return failure("RUNNER_OUTPUT_INVALID", `runner "${runner.id}" wrote output that failed validation: ${recorded.error.message}`, { errors: recorded.error.errors });
  }
  return recorded;
}
