import { assert } from "vitest";
import type { Result } from "../../src/core/errors.ts";

/** Unwraps a Result, failing the test by assertion (not by thrown stub error) when it is an error. */
export function must<T>(result: Result<T>, context = "operation"): T {
  if (!result.ok) {
    assert.fail(`${context} failed: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.errors)}`);
  }
  return result.value;
}

/** Unwraps a Result expected to be an error. */
export function mustFail<T>(result: Result<T>, context = "operation") {
  if (result.ok) assert.fail(`${context} unexpectedly succeeded`);
  return result.error;
}
