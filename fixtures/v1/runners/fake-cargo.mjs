#!/usr/bin/env node
// A deterministic stand-in for `cargo test` used as the registered cargo adapter executable in job-lifecycle tests.
// It never compiles anything. Steered by $FAKE_RUNNER_SCENARIO (a JSON file, re-read at start):
//   { "mode": "pass" | "fail" | "hang" | "heartbeat" , "heartbeatFile": path, "countFile": path }
// Each execution appends one line to countFile (so a test can prove ONE execution) and writes worker artifacts in the layout of
// docs/v1-red-contract.md section 7 when PANEWEFT_COLLECT=1. `hang` spawns a grandchild that appends to heartbeatFile.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const scenario = (() => { try { return JSON.parse(readFileSync(process.env.FAKE_RUNNER_SCENARIO ?? "", "utf8")); } catch { return { mode: "pass" }; } })();
if (scenario.countFile) appendFileSync(scenario.countFile, `${process.pid} ${process.env.PANEWEFT_RUN_ID ?? "-"}\n`);
const argv = process.argv.slice(2);
const exact = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1).filter((a) => !a.startsWith("--")) : [];
const names = exact.length > 0 ? exact : ["paneweft_example_watch_pending"];
const staging = process.env.PANEWEFT_STAGING_DIR;
const runId = process.env.PANEWEFT_RUN_ID ?? "run-none";
const T = "2026-11-11T12:00:00Z";

if (process.env.PANEWEFT_CATALOGUE === "1") {
  // catalogue mode: export the catalogue part of the reviewed watchfile fixture; run no example
  const catalogue = JSON.parse(readFileSync(join(new URL(".", import.meta.url).pathname, "../catalogues/watchfile.catalogue.json"), "utf8"));
  mkdirSync(join(staging, "catalogue"), { recursive: true });
  writeFileSync(join(staging, "catalogue", "fake-lib.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-part/1", source: "lib", types: catalogue.types, views: catalogue.views, examples: catalogue.examples }));
  process.exit(0);
}

if (scenario.mode === "hang" || scenario.mode === "heartbeat") {
  const beat = scenario.heartbeatFile;
  const grandchild = spawn(process.execPath, ["-e", `setInterval(() => require('fs').appendFileSync(${JSON.stringify(beat)}, 'x'), 20)`], { stdio: "ignore" });
  if (staging) { mkdirSync(join(staging, "invocations"), { recursive: true }); writeFileSync(join(staging, "invocations", "inv-1.started.json"), JSON.stringify({ id: "inv-1", exampleId: "watch.pending", attempt: 1, parent: null, startedAt: T })); }
  if (scenario.readyFile) writeFileSync(scenario.readyFile, String(grandchild.pid));
  setInterval(() => {}, 1000);
} else {
  const failing = scenario.mode === "fail";
  let index = 0;
  if (staging) {
    mkdirSync(join(staging, "invocations"), { recursive: true });
    mkdirSync(join(staging, "captures"), { recursive: true });
  }
  console.log(`running ${names.length} tests`);
  for (const name of names) {
    index += 1;
    const id = `inv-${index}`;
    // libtest paths carry the module (`tests::paneweft_example_x`); the SDK records the example id, never the module
    const exampleId = name.split("::").pop().replace(/^paneweft_example_/, "").replace(/_/g, ".");
    if (staging) {
      const captureId = id;
      writeFileSync(join(staging, "captures", `${captureId}.json`), JSON.stringify({ schemaVersion: "paneweft.object-graph/1", captureId, runId: scenario.graphRunId ?? runId, invocationId: id, roots: ["o1"], objects: [{ id: "o1", typeId: "fixture::watch::WatchFile", domainKey: null, label: "watch", fields: {}, edges: [], views: [], contentHash: createHash("sha256").update('{"domainKey":null,"fields":{},"label":"watch","typeId":"fixture::watch::WatchFile"}').digest("hex") }], views: [], pages: [], diagnostics: [], limits: { depth: 4, objects: 1000, references: 4000, rootBytes: 2097152, stringBytes: 16384, pageRows: 100, collectionBytes: 33554432, roots: 100, viewRows: 10000, viewBudgetMs: 100 }, completeness: { status: "complete" } }));
      writeFileSync(join(staging, "invocations", `${id}.started.json`), JSON.stringify({ id, exampleId, attempt: 1, parent: null, startedAt: T }));
      writeFileSync(join(staging, "invocations", `${id}.json`), JSON.stringify({ id, exampleId, attempt: 1, parent: null, native: failing ? { outcome: "failed", message: "check failed" } : { outcome: "passed" }, capture: { outcome: "captured", captureId, diagnostics: [] }, checks: [{ claim: "C", passed: !failing }], result: { captureId, object: "o1" }, startedAt: T, finishedAt: T }));
    }
    console.log(`test ${name} ... ${failing ? "FAILED" : "ok"}`);
  }
  console.log(`\ntest result: ${failing ? "FAILED" : "ok"}. ${failing ? 0 : names.length} passed; ${failing ? names.length : 0} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`);
  process.exit(failing ? 101 : 0);
}
