import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Cross-cutting suites live under test/; unit suites sit beside their module
// in src/ (test-quality §2). DOM suites opt in with a
// `// @vitest-environment jsdom` docblock on the first line.
// v1: the SDK package under packages/ keeps its tests beside its modules, resolved by the same alias the fixture packages use.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@paneweft/sdk/vitest-reporter", replacement: fileURLToPath(new URL("./packages/paneweft-ts/src/vitest-reporter.ts", import.meta.url)) },
      { find: "@paneweft/sdk/vitest", replacement: fileURLToPath(new URL("./packages/paneweft-ts/src/vitest.ts", import.meta.url)) },
      { find: "@paneweft/sdk", replacement: fileURLToPath(new URL("./packages/paneweft-ts/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
