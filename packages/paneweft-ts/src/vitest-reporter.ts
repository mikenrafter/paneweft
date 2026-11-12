// The paneweft vitest reporter, alone. `reporters: ['default', '@paneweft/sdk/vitest-reporter']` makes Vitest load this module in its MAIN process,
// where importing `vitest` throws on Vitest 3 ("Vitest failed to access its internal state": its entry builds `expect` when it is imported). So this
// module, and everything it imports, never imports `vitest`: `exampleTest` (which needs `test`) lives in ./vitest.ts and re-exports the class from here.
// A reporter cannot recover local variables, so the value is captured inside the worker by exampleTest and the reporter only finalizes the outcome.
// Supported: vitest 3 and 5 reporter hooks (onTestRunEnd); reporter signatures move between majors, so pin the version you test.
import { isAbsolute, join, relative, sep } from "node:path";
import { stagingFromEnv, writeArtifact } from "./artifacts.ts";

export const EXAMPLE_PREFIX = "example:";

interface ReportedError {
  message?: string;
}
interface ReportedTest {
  name: string;
  result(): { state: string; errors?: ReadonlyArray<ReportedError> };
  diagnostic(): { retryCount?: number } | undefined;
}
interface ReportedModule {
  /** Vitest 5. */
  relativeModuleId?: string;
  /** Vitest 3 and 5: usually an absolute path. */
  moduleId?: string;
  /** Vitest 3 and 5: the project the module belongs to. */
  project?: { config?: { root?: string } };
  errors(): ReadonlyArray<ReportedError>;
  children: { allTests(): Iterable<ReportedTest>; allSuites(): Iterable<{ errors(): ReadonlyArray<ReportedError> }> };
}

/** The repository-relative, slash-separated file of a reported module. Vitest 3.2's TestModule has no `relativeModuleId`, so it is derived from
 * `moduleId` and the project root; "" when the module names no file (the host refuses such a record). */
export function moduleFile(entry: Pick<ReportedModule, "relativeModuleId" | "moduleId" | "project">): string {
  if (typeof entry.relativeModuleId === "string" && entry.relativeModuleId.length > 0) return entry.relativeModuleId;
  const id = entry.moduleId;
  if (typeof id !== "string" || id.length === 0) return "";
  const root = entry.project?.config?.root ?? process.cwd();
  const path = isAbsolute(id) ? relative(root, id) : id;
  return sep === "/" ? path : path.split(sep).join("/");
}

/** A vitest reporter. Pin supported vitest versions: reporter hook signatures move between majors. */
export class PaneweftReporter {
  onTestRunEnd(testModules: ReadonlyArray<unknown>, unhandledErrors: ReadonlyArray<unknown>, _reason?: string): void {
    const staging = stagingFromEnv();
    if (staging === null) return;
    const tests: Array<Record<string, unknown>> = [];
    const suites: Array<Record<string, unknown>> = [];
    for (const entry of testModules as ReportedModule[]) {
      const file = moduleFile(entry);
      const examples: string[] = [];
      let allRan = true;
      for (const reported of entry.children.allTests()) {
        if (!reported.name.startsWith(EXAMPLE_PREFIX)) continue;
        const result = reported.result();
        examples.push(reported.name.slice(EXAMPLE_PREFIX.length));
        if (result.state !== "passed" && result.state !== "failed") allRan = false;
        tests.push({ name: reported.name, file, state: result.state, errors: (result.errors ?? []).map((error) => error.message ?? "error"), retries: reported.diagnostic()?.retryCount ?? 0 });
      }
      const errors = [...entry.errors(), ...[...entry.children.allSuites()].flatMap((suite) => [...suite.errors()])];
      if (errors.length > 0) {
        // Errors outside any test: a hook that failed before the tests ran is `setup`, one that failed after they all ran is `teardown`.
        suites.push({ file, phase: allRan ? "teardown" : "setup", outcome: "failed", message: errors[0]?.message ?? "suite failed", examples });
      }
    }
    writeArtifact(join(staging.dir, "reporter.json"), {
      schemaVersion: "paneweft.vitest-report/1",
      runId: staging.runId,
      tests,
      suites,
      unhandledErrors: (unhandledErrors as ReportedError[]).map((error) => error.message ?? "unhandled error"),
    });
  }
}
export default PaneweftReporter;
