// The TypeScript SDK in a STRICT consumer (field test F4). The package shipped `.ts` sources whose imports end in `.ts`; the consumer's own `tsc --noEmit` then
// failed with 27 x TS5097 until the consumer enabled `allowImportingTsExtensions`, a setting ContainMarks had to commit as a workaround, and the vitest adapter ran that typecheck
// first, so no collect passed. The consumer below is a repository that links the SDK the way `npm i -D @paneweft/sdk@file:` does and compiles with the REAL TypeScript
// (the project's pinned version) under strict settings and without that option.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers/fixtures.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const TSC = join(REPO_ROOT, "node_modules/typescript/lib/tsc.js");

const PROBE = `import { defineManifest, defineType, example, Capture, type ObjectRef } from "@paneweft/sdk";
import { exampleTest } from "@paneweft/sdk/vitest";
import { PaneweftReporter } from "@paneweft/sdk/vitest-reporter";

interface Backup { name: string; index: number }
export const BackupToken = defineType<Backup>({ id: "demo::Backup", source: { path: "src/backup.ts", symbol: "Backup" } });
BackupToken.view({ id: "backup.details", title: "Backup", question: "What is in this backup?", priority: 1, component: "shape", render: (backup, view) => view.details().field("name", backup.name).field("index", backup.index).done() });
export const backupExample = example({ id: "backup.work", type: BackupToken, claims: ["B1"], run(cx) { cx.check("B1", () => {}); return { name: "Work", index: 1 }; } });
export const manifest = defineManifest({ runners: ["vitest"], modules: [{ path: "src/probe.ts", types: [BackupToken], examples: [backupExample] }] });
exampleTest(backupExample);
export const reporter: PaneweftReporter = new PaneweftReporter();
export const capture: Capture = new Capture({});
export const ref: ObjectRef = { object: "o1" };
`;

/** A repository with the SDK in node_modules (a link, as `file:` makes) and the root's dev tooling; `options` are the consumer's own compiler settings. */
function consumer(options: Record<string, unknown>): string {
  const root = tmp("sdk-consumer");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules/@paneweft"), { recursive: true });
  for (const name of readdirSync(join(REPO_ROOT, "node_modules"))) if (name !== ".cache" && name !== ".bin") symlinkSync(join(REPO_ROOT, "node_modules", name), join(root, "node_modules", name));
  symlinkSync(join(REPO_ROOT, "packages/paneweft-ts"), join(root, "node_modules/@paneweft/sdk"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  writeFileSync(join(root, "src/probe.ts"), PROBE);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023", strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, isolatedModules: true, noEmit: true, skipLibCheck: true, types: ["node"], ...options }, include: ["src"] }));
  return root;
}
const typecheck = (root: string): { status: number | null; output: string } => {
  const run = spawnSync(process.execPath, [TSC, "--pretty", "false", "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
};

describe("[F4] a strict consumer typechecks the SDK without allowImportingTsExtensions", () => {
  // why: F4. `npx tsc --noEmit` in ContainMarks: 27 x error TS5097 in ../paneweft/packages/paneweft-ts/src/*.ts. Both resolution modes a consumer may use.
  // proves: CLAIM(F4-consumer-typechecks)
  it.each([
    ["NodeNext", { module: "NodeNext", moduleResolution: "NodeNext" }],
    ["bundler", { module: "ESNext", moduleResolution: "Bundler" }],
  ])("compiles a probe of the whole SDK surface under %s", (_name, options) => {
    const result = typecheck(consumer(options));
    expect(result.output).not.toContain("TS5097");
    expect(result.output, "no error at all").toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  // why: F4. A consumer that does not skip library checks reads the declarations themselves: no error may come from a file of the SDK (the declarations
  // used to keep `.ts` specifiers, which that consumer reports as TS5097 in every declaration file).
  // proves: CLAIM(F4-consumer-typechecks)
  it("reports nothing in the SDK's declarations when library checks are on", () => {
    const result = typecheck(consumer({ module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: false }));
    expect(result.output.split("\n").filter((line) => line.includes("paneweft-ts")), "errors from the SDK's files").toEqual([]);
  }, 120_000);

  // why: F4. The control that the probe really exercises the SDK's types: a wrong use of the API is an error, so a pass is not an empty program.
  // proves: CLAIM(F4-consumer-typechecks)
  it("still reports a misuse of the SDK (the types are real)", () => {
    const root = consumer({ module: "NodeNext", moduleResolution: "NodeNext" });
    writeFileSync(join(root, "src/misuse.ts"), `import { defineType } from "@paneweft/sdk";\nexport const bad = defineType<{ n: number }>({ id: 3, source: { path: "x", symbol: "y" } });\n`);
    const result = typecheck(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("src/misuse.ts");
    expect(result.output).not.toContain("TS5097");
  }, 120_000);

  // why: F4. The declarations the consumer reads are committed and generated from the sources; a stale file would let the probe pass against yesterday's API.
  // proves: CLAIM(F4-declarations-current)
  it("the committed declarations are the ones the sources produce", () => {
    expect(() => execFileSync(process.execPath, [join(REPO_ROOT, "scripts/gen-types-sdk.mjs"), "--check"], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" })).not.toThrow();
  }, 120_000);
});
