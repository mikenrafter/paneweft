// Vitest integration: exampleTest() registers an example as an ordinary test; PaneweftReporter reconciles the final native
// outcomes (after hooks and teardown) into <staging>/reporter.json. A reporter cannot recover local variables, so the value is
// captured inside the worker by exampleTest and the reporter only finalizes the outcome.
import type { ExampleDefinition } from "./example.ts";

export { example } from "./example.ts";

/** Registers `definition` as a vitest test named `example:<id>`. STUB: registers nothing. */
export function exampleTest<T>(definition: ExampleDefinition<T>): void {}

/** A vitest reporter. Pin supported vitest versions: reporter hook signatures move between majors. STUB: records nothing. */
export class PaneweftReporter {
  onTestRunEnd(_testModules: ReadonlyArray<unknown>, _unhandledErrors: ReadonlyArray<unknown>, _reason: string): void {}
}
export default PaneweftReporter;
