// Vitest integration: exampleTest() registers an example as an ordinary test; PaneweftReporter reconciles the final native
// outcomes (after hooks and teardown) into <staging>/reporter.json. A reporter cannot recover local variables, so the value is
// captured inside the worker by exampleTest and the reporter only finalizes the outcome.
// Supported: vitest 3 and 5 reporter hooks (onTestRunEnd); reporter signatures move between majors, so pin the version you test.
import { join } from "node:path";
import { test } from "vitest";
import { stagingFromEnv, writeArtifact } from "./artifacts.ts";
import { runExample, type ExampleDefinition } from "./example.ts";

export { example } from "./example.ts";

const PREFIX = "example:";

/** Registers `definition` as a vitest test named `example:<id>`. A failed example rethrows its error so the runner fails the test. */
export function exampleTest<T>(definition: ExampleDefinition<T>): void {
  test(`${PREFIX}${definition.id}`, async (context) => {
    const retries = (context.task.result as { retryCount?: number } | undefined)?.retryCount ?? 0;
    const base = stagingFromEnv()?.attempt ?? 1;
    const { error } = await runExample(definition, { attempt: base + retries });
    if (error !== undefined) throw error;
  });
}

interface ReportedError {
  message?: string;
}
interface ReportedTest {
  name: string;
  result(): { state: string; errors?: ReadonlyArray<ReportedError> };
  diagnostic(): { retryCount?: number } | undefined;
}
interface ReportedModule {
  relativeModuleId: string;
  errors(): ReadonlyArray<ReportedError>;
  children: { allTests(): Iterable<ReportedTest>; allSuites(): Iterable<{ errors(): ReadonlyArray<ReportedError> }> };
}

/** A vitest reporter. Pin supported vitest versions: reporter hook signatures move between majors. */
export class PaneweftReporter {
  onTestRunEnd(testModules: ReadonlyArray<unknown>, unhandledErrors: ReadonlyArray<unknown>, _reason?: string): void {
    const staging = stagingFromEnv();
    if (staging === null) return;
    const tests: Array<Record<string, unknown>> = [];
    const suites: Array<Record<string, unknown>> = [];
    for (const entry of testModules as ReportedModule[]) {
      const file = entry.relativeModuleId;
      const examples: string[] = [];
      let allRan = true;
      for (const reported of entry.children.allTests()) {
        if (!reported.name.startsWith(PREFIX)) continue;
        const result = reported.result();
        examples.push(reported.name.slice(PREFIX.length));
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
