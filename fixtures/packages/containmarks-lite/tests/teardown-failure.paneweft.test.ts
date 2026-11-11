// SEEDED FAILURE (suite outcome, spec S6): the example passes, then afterAll throws. The host must show "suite failed after" on the
// example and a failed collection without changing the example's own result. Run only when selected by file.
import { afterAll } from "vitest";
import { exampleTest } from "@paneweft/sdk/vitest";
import { workMapping } from "./mappings.examples.ts";

afterAll(() => {
  throw new Error("teardown exploded");
});

exampleTest(workMapping);
