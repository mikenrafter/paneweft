// Vitest integration: exampleTest() registers an example as an ordinary test. The reporter that reconciles the final native outcomes (after hooks and
// teardown) into <staging>/reporter.json is ./vitest-reporter.ts; it is re-exported here for the entries that already name it, but a vitest config
// should list `@paneweft/sdk/vitest-reporter`: the reporter is loaded in Vitest's main process, where this module (it imports `vitest`) cannot load on Vitest 3.
// Supported: vitest 3 and 5.
import { test } from "vitest";
import { stagingFromEnv } from "./artifacts.ts";
import { runExample, type ExampleDefinition } from "./example.ts";
import { EXAMPLE_PREFIX } from "./vitest-reporter.ts";

export { example } from "./example.ts";
export { PaneweftReporter, default } from "./vitest-reporter.ts";

const PREFIX = EXAMPLE_PREFIX;

/** Registers `definition` as a vitest test named `example:<id>`. A failed example rethrows its error so the runner fails the test. */
export function exampleTest<T>(definition: ExampleDefinition<T>): void {
  test(`${PREFIX}${definition.id}`, async (context) => {
    const retries = (context.task.result as { retryCount?: number } | undefined)?.retryCount ?? 0;
    const base = stagingFromEnv()?.attempt ?? 1;
    const thrown = outcomeToThrow(await runExample(definition, { attempt: base + retries }));
    if (thrown !== undefined) throw thrown;
  });
}

/** What exampleTest throws for the outcome of an example: nothing for a pass, the original failure otherwise. A failure whose thrown value was
 * itself `undefined` becomes an Error, because a runner takes a thrown `undefined` for nothing at all (S18). */
export function outcomeToThrow(run: { failed: boolean; error?: unknown }): unknown {
  if (!run.failed) return undefined;
  return run.error === undefined ? new Error("the example threw undefined") : run.error;
}
