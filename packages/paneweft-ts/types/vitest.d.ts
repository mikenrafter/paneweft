import { type ExampleDefinition } from "./example.js";
export { example } from "./example.js";
export { PaneweftReporter, default } from "./vitest-reporter.js";
/** Registers `definition` as a vitest test named `example:<id>`. A failed example rethrows its error so the runner fails the test. */
export declare function exampleTest<T>(definition: ExampleDefinition<T>): void;
/** What exampleTest throws for the outcome of an example: nothing for a pass, the original failure otherwise. A failure whose thrown value was
 * itself `undefined` becomes an Error, because a runner takes a thrown `undefined` for nothing at all (S18). */
export declare function outcomeToThrow(run: {
    failed: boolean;
    error?: unknown;
}): unknown;
