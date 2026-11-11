// Owner-configured local runners (design section 5, owner question 4).
// CLAIM(no-payload-exec): runners come only from the owner's registry file; submitted documents
//   cannot install or execute one [design section 5; example.test.ts, MC17].
// A runner is spawned WITHOUT a shell: argv elements are literal; `{param:name}` inside an element
// is replaced by the parameter value; the run id is passed as env PANEWEFT_RUN_ID; the runner writes
// a paneweft.run/1 document to outputBundlePath (relative to workspaceRoot); a stale output file is
// removed before the run; exceeding timeoutMs kills the process.
import type { Scalar } from "./wire.ts";
import type { RecordedRun, Session, ViewKey } from "./session.ts";
import { notImplementedResult, type Result } from "./errors.ts";

export interface RunnerDefinition {
  id: string;
  executable: string;
  argv: string[];
  workspaceRoot: string;
  parameterSchema: Record<string, unknown>;
  timeoutMs: number;
  outputBundlePath: string;
}

/** Registry file format: `{ "runners": RunnerDefinition[] }`. STUB. */
export async function loadRunnerRegistry(_file: string): Promise<Result<RunnerDefinition[]>> {
  return notImplementedResult("loadRunnerRegistry");
}

export interface RunExampleRequest {
  runnerRegistryFile: string;
  runnerId: string;
  parameters: Record<string, Scalar>;
  key: ViewKey;
}
/** Runs the runner, validates its output, records the run. Errors: RUNNER_NOT_FOUND, RUNNER_TIMEOUT, RUNNER_OUTPUT_INVALID, RUNNER_FAILED, VALIDATION_FAILED, INVALID_ARGUMENT. STUB. */
export async function runExample(_session: Session, _request: RunExampleRequest): Promise<Result<RecordedRun>> {
  return notImplementedResult("runExample");
}
