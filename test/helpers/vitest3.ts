// A REAL Vitest 3 for the tests that must run under the version ContainMarks pins. paneweft's own suite runs Vitest 5, and every fixture that
// resolved `vitest` from the paneweft checkout hid the Vitest 3 failures of the field test (F1, F2): this helper installs `vitest@3.2.4`
// (fixtures/vitest3-deps, with its lockfile) once into node_modules/.cache and gives each test a repository whose `node_modules` is that install,
// with the SDK linked the way `npm i -D @paneweft/sdk@file:...` links it. Needs the network the first time; later runs reuse the install.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, REPO_ROOT } from "./fixtures.ts";

const CACHE = join(REPO_ROOT, "node_modules/.cache/paneweft-vitest3");
export const VITEST3_VERSION = "3.2.4";

/** The install of Vitest 3.2.4 (the directory that holds `node_modules`). Safe to call from parallel test files. */
export function installedVitest3(): string {
  const marker = join(CACHE, "node_modules/vitest/package.json");
  const installed = (): boolean => existsSync(marker) && (JSON.parse(readFileSync(marker, "utf8")) as { version: string }).version === VITEST3_VERSION;
  if (installed()) return CACHE;
  mkdirSync(join(REPO_ROOT, "node_modules/.cache"), { recursive: true });
  const staging = mkdtempSync(join(REPO_ROOT, "node_modules/.cache/paneweft-vitest3-"));
  cpSync(join(FIXTURES, "vitest3-deps/package.json"), join(staging, "package.json"));
  cpSync(join(FIXTURES, "vitest3-deps/package-lock.json"), join(staging, "package-lock.json"));
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, stdio: "pipe", timeout: 240_000 });
  try { renameSync(staging, CACHE); } catch { rmSync(staging, { recursive: true, force: true }); }
  if (!installed()) throw new Error(`vitest ${VITEST3_VERSION} could not be installed into ${CACHE}`);
  return CACHE;
}

/** What a repository under test is made of. Every member can be replaced to build a broken repository. */
export interface Vitest3Repo { root: string }

/** A ContainMarks-shaped repository in `directory` on Vitest 3.2.4: the containmarks-lite sources, a vitest config that lists the paneweft reporter
 * by its package entry, `node_modules` from the Vitest 3 install, `@paneweft/sdk` linked to the SDK package. Nothing is aliased to paneweft's source. */
export function makeVitest3Repo(directory: string, options: { reporter?: string } = {}): Vitest3Repo {
  const source = join(FIXTURES, "packages/containmarks-lite");
  // the passing mapping examples only: the fixture's other test files fail on purpose
  for (const entry of ["src", "paneweft.views.ts", "tests/mappings.examples.ts", "tests/mappings.paneweft.test.ts"]) cpSync(join(source, entry), join(directory, entry), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "containmarks-v3", private: true, type: "module", devDependencies: { vitest: VITEST3_VERSION } }));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", types: [], strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true },
    include: ["src", "tests", "paneweft.views.ts", "vitest.config.ts"],
  }));
  writeFileSync(join(directory, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"], reporters: ["default", ${JSON.stringify(options.reporter ?? "@paneweft/sdk/vitest-reporter")}] } });\n`);
  mkdirSync(join(directory, "node_modules/@paneweft"), { recursive: true });
  for (const name of readdirSync(join(installedVitest3(), "node_modules"))) symlinkSync(join(installedVitest3(), "node_modules", name), join(directory, "node_modules", name));
  symlinkSync(join(REPO_ROOT, "packages/paneweft-ts"), join(directory, "node_modules/@paneweft/sdk"));
  return { root: directory };
}
