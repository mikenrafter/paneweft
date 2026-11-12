// The fixture package's own vitest config: the SDK is resolved from the monorepo source (the production dependency is a dev
// dependency here, exactly as in ContainMarks), and the paneweft reporter finalizes outcomes after hooks and teardown.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const sdk = (path: string) => fileURLToPath(new URL(`../../../packages/paneweft-ts/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: "@paneweft/sdk/vitest-reporter", replacement: sdk("vitest-reporter.ts") }, { find: "@paneweft/sdk/vitest", replacement: sdk("vitest.ts") }, { find: "@paneweft/sdk", replacement: sdk("index.ts") }] },
  test: {
    include: ["tests/**/*.test.ts"],
    reporters: ["default", sdk("vitest-reporter.ts")],
  },
});
