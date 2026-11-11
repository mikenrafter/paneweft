#!/usr/bin/env node
// The host-owned vitest collection script (spec section 6, "Keeping views current"): typecheck first, then vitest, as ONE queue job so
// that one kill stops both. The repository cannot replace it: the registered adapter names THIS file, and the arguments below are the
// whole grammar (docs/v1-red-contract.md section 9). Nothing here evaluates a shell.
//
//   collect-vitest.mjs --staging DIR --root DIR --tsconfig FILE --vitest FILE --config FILE --name-pattern REGEX     run mode
//   collect-vitest.mjs --staging DIR --root DIR --tsconfig FILE --catalogue --manifest FILE                          catalogue mode
//
// Run mode writes <staging>/typecheck.json ({exitCode, output}); a failed typecheck stops BEFORE vitest (vitest's own transform does
// not typecheck), exits 2, and the host reports a compile failure with the tsc diagnostics. Vitest then runs with the collector's
// environment (PANEWEFT_*); the repository's vitest config lists the paneweft reporter, which writes <staging>/reporter.json.
// Catalogue mode imports the repository's explicit manifest under tsx (so tsconfig paths apply) and writes
// <staging>/catalogue/manifest.json; it never runs an example.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const flag = (name) => args.includes(name);
const fail = (message, code = 70) => { console.error(`collect-vitest: ${message}`); process.exit(code); };

if (flag("--catalogue-child")) {
  // Re-executed under tsx: import the manifest, compile its catalogue, write the part.
  const manifestPath = resolve(option("--manifest") ?? fail("--manifest is required"));
  const staging = resolve(option("--staging") ?? fail("--staging is required"));
  const loaded = await import(pathToFileURL(manifestPath).href);
  const manifest = loaded.manifest ?? loaded.default;
  const compile = manifest?.[Symbol.for("paneweft.compile")];
  if (typeof compile !== "function") fail(`${manifestPath} does not export a manifest made with defineManifest(...)`, 3);
  const result = compile();
  mkdirSync(join(staging, "catalogue"), { recursive: true });
  if (!result.ok) {
    console.error(`collect-vitest: the manifest has problems: ${JSON.stringify(result.problems)}`);
    process.exit(3);
  }
  writeFileSync(join(staging, "catalogue", "manifest.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-part/1", source: "manifest", ...result.catalogue }));
  process.exit(0);
}

const staging = resolve(option("--staging") ?? fail("--staging is required", 64));
const root = resolve(option("--root") ?? fail("--root is required", 64));
const tsconfig = option("--tsconfig") ?? "tsconfig.json";
mkdirSync(staging, { recursive: true });

const run = (command, argv, options = {}) => new Promise((done) => {
  const child = spawn(command, argv, { stdio: "inherit", ...options });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => done(code ?? (signal === "SIGTERM" ? 143 : 137)));
  child.on("error", (error) => { console.error(`collect-vitest: cannot start ${command}: ${error.message}`); done(127); });
});

if (flag("--catalogue")) {
  const tsx = import.meta.resolve("tsx/esm");
  const manifest = join(root, option("--manifest") ?? "paneweft.views.ts");
  process.exit(await run(process.execPath, ["--import", tsx, fileURLToPath(import.meta.url), "--catalogue-child", "--manifest", manifest, "--staging", staging], { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, tsconfig) } }));
}

// run mode: typecheck, then vitest
const local = join(root, "node_modules/typescript/lib/tsc.js");
const tsc = existsSync(local) ? local : createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
const check = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(root, tsconfig), "--pretty", "false"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const output = `${check.stdout ?? ""}${check.stderr ?? ""}`;
writeFileSync(join(staging, "typecheck.json"), JSON.stringify({ exitCode: check.status ?? 1, output: output.slice(-16000) }));
if (check.status !== 0) {
  process.stderr.write(output);
  fail("the instrumentation does not typecheck; vitest was not started", 2);
}
// The adapter names `<root>/node_modules/vitest/vitest.mjs`; a package inside a workspace has its dependencies in an ancestor's
// node_modules, which is where node itself would resolve them from, so walk up before giving up.
function findVitest(given) {
  if (existsSync(given)) return given;
  for (let at = root; ; at = dirname(at)) {
    const candidate = join(at, "node_modules/vitest/vitest.mjs");
    if (existsSync(candidate)) return candidate;
    if (dirname(at) === at) return fail(`vitest is not installed for ${root} (looked for ${given} and in every parent directory)`, 127);
  }
}
const vitest = findVitest(resolve(option("--vitest") ?? fail("--vitest is required", 64)));
const config = join(root, option("--config") ?? "vitest.config.ts");
const pattern = option("--name-pattern") ?? fail("--name-pattern is required", 64);
process.exit(await run(process.execPath, [vitest, "run", "--root", root, "--config", config, "-t", pattern], { cwd: root }));
void here;
