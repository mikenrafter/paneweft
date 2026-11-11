import { defineConfig } from "vitest/config";

// Cross-cutting suites live under test/; unit suites sit beside their module
// in src/ (test-quality §2). DOM suites opt in with a
// `// @vitest-environment jsdom` docblock on the first line.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
