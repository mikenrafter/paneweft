// Registered with `--import` by the catalogue mode of collect-vitest.mjs (F2). The catalogue export imports the repository's manifest, which imports its example
// modules, and an example module imports the test runner at its top level (`import { expect } from "vitest"`, spec section 3). Outside a worker Vitest 3
// throws when its entry is imported ("Vitest failed to access its internal state": the entry builds `expect` from the worker state). The export never
// runs an example body, so it does not need a runner: the bare specifier `vitest` resolves to an inert module that exports every name the runner's entry has
// in Vitest 3 and 5. Each name is a value that can be called, read, chained and awaited and does nothing. A repository that works through `vitest/config` or
// any other subpath is untouched; so is a module loaded with `require`.
import { register } from "node:module";

register("./catalogue-vitest-stub-hooks.mjs", import.meta.url);
