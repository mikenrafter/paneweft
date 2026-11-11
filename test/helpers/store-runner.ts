// Helpers for the runner / example suites (MC17): runner registry files, workspaces, output documents.
// The runner scripts are in fixtures/runners (plain node ESM, independent of src/).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerDefinition } from "../../src/core/runner.ts";
import type { ViewKey } from "../../src/core/session.ts";
import { FIXTURES } from "./fixtures.ts";

/** The example view of fixtures/components/all.bundle.json; its scenario names runnerId "vigil-one-write". */
export const EXAMPLE_KEY: ViewKey = { viewId: "vigil-one-write", snapshotId: "snap-1" };
export const SCENARIO_RUNNER_ID = "vigil-one-write";

export const runnerScript = (name: string): string => join(FIXTURES, "runners", name);

export interface RunnerOptions {
  /** extra argv after the output path (e.g. ["pid.txt", "30000"]) */
  extraArgv?: string[];
  timeoutMs?: number;
  parameterSchema?: Record<string, unknown>;
  id?: string;
  executable?: string;
}

/** A RunnerDefinition running `node <fixtures/runners/script> out.json ...extraArgv` in `workspace`. */
export function runnerDefinition(script: string, workspace: string, options: RunnerOptions = {}): RunnerDefinition {
  return {
    id: options.id ?? SCENARIO_RUNNER_ID,
    executable: options.executable ?? process.execPath,
    argv: [runnerScript(script), "out.json", ...(options.extraArgv ?? [])],
    workspaceRoot: workspace,
    parameterSchema: options.parameterSchema ?? { type: "object", additionalProperties: true },
    timeoutMs: options.timeoutMs ?? 20_000,
    outputBundlePath: "out.json",
  };
}

/** Writes `{ "runners": [...] }` (what the owner would write by hand) and returns the file path. */
export function writeRegistry(dir: string, runners: RunnerDefinition[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "runners.json");
  writeFileSync(file, JSON.stringify({ runners }, null, 2));
  return file;
}

export type Doc = Record<string, any>;
/** A valid paneweft.run/1 passing document for `runId` (same shape as fixtures/runners/_common.mjs). */
export function passOutput(runId: string): Doc {
  const result = { repository: "r", id: `result-${runId}`, kind: "json/value" };
  return {
    schemaVersion: "paneweft.run/1",
    run: {
      id: `run-${runId}`, runId, status: "passed", provenance: "read", evidence: ["s1"],
      assertions: [{ id: "a1", statement: "one write fires the first keepalive", passed: true, provenance: "read", evidence: ["s1"] }],
      result,
    },
    bundle: {
      schemaVersion: "paneweft.bundle/1",
      entities: [{ ...result, snapshotId: "snap-1", label: "recorded result", dataRoles: ["raw"], relations: [] }],
      definitions: [],
      views: [],
    },
  };
}
