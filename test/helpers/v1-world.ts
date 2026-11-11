// Test world for the v1 suites: collection fixtures, a fake qex on PATH, a registered fake-cargo adapter, tiny git repositories.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, assert } from "vitest";
import { openSession, type Session } from "../../src/core/session.ts";
import type { AdapterRecord } from "../../src/v1/adapters.ts";
import { createQexClient } from "../../src/v1/qex.ts";
import type { CollectionImport } from "../../src/v1/import.ts";
import { FIXTURES, REPO_ROOT, loadFixture } from "./fixtures.ts";
import { must } from "./must.ts";
import { useTempDirs } from "./tmp.ts";

export { loadFixture, REPO_ROOT, FIXTURES };

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as any)[k])])) : v);
/** An independent canonical JSON (sorted keys, no whitespace), deliberately not imported from src/. */
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));

export interface CollectionFixture { run: any; graphs: any[] }
export function collectionFixture(name: string): CollectionFixture {
  const dir = join(FIXTURES, "v1/collections", name);
  const files = readdirSync(dir);
  const graphs = files.filter((f) => f.startsWith("object-graph")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const runFile = files.find((f) => f.startsWith("test-run")) as string;
  return { run: JSON.parse(readFileSync(join(dir, runFile), "utf8")), graphs };
}
export function collectionImport(name: string, overrides: Partial<CollectionImport> = {}, which?: { graph?: string; run?: string }): CollectionImport {
  const dir = join(FIXTURES, "v1/collections", name);
  const graphFile = which?.graph ?? "object-graph.json";
  const runFile = which?.run ?? "test-run.json";
  const graph = JSON.parse(readFileSync(join(dir, graphFile), "utf8"));
  const run = JSON.parse(readFileSync(join(dir, runFile), "utf8"));
  return { repo: name === "containmarks-mapping" ? "cm" : "vg", runId: run.runId, jobId: null, origin: "host_collected", run, graphs: [graph], ...overrides };
}

export interface V1Env { session: Session; dir: string }
/** Call once per file. */
export function useV1Sessions(): () => Promise<V1Env> {
  const tmp = useTempDirs();
  const sessions: Session[] = [];
  afterEach(async () => { for (const session of sessions.splice(0)) await session.close().catch(() => {}); });
  return async () => {
    const dir = tmp("v1session");
    const session = must(await openSession(dir), "openSession");
    sessions.push(session);
    return { session, dir };
  };
}

// ---- fake qex ---------------------------------------------------------------------------------------------------------------------

export interface FakeQex {
  dir: string;
  /** PATH with the fake first: pass to createQexClient({env}). */
  env: NodeJS.ProcessEnv;
  client: ReturnType<typeof createQexClient>;
  control(patch: Record<string, unknown>): void;
  calls(): string[][];
  jobs(): any[];
  release(id: string): void;
  scenario(patch: Record<string, unknown>): string;
  executions(): string[];
  scenarioFile: string;
}

export function useFakeQex(): () => FakeQex {
  const tmp = useTempDirs();
  return () => {
    const dir = tmp("fakeqex");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeQex = join(FIXTURES, "v1/bin/qex");
    chmodSync(fakeQex, 0o755);
    execFileSync("ln", ["-s", fakeQex, join(bin, "qex")]);
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const scenarioFile = join(dir, "scenario.json");
    const countFile = join(dir, "executions.log");
    writeFileSync(scenarioFile, JSON.stringify({ mode: "pass", countFile }));
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_QEX_DIR: state, FAKE_RUNNER_SCENARIO: scenarioFile };
    const fake: FakeQex = {
      dir, env, scenarioFile,
      client: createQexClient({ env }),
      control: (patch) => writeFileSync(join(state, "control.json"), JSON.stringify({ ...(existsSync(join(state, "control.json")) ? JSON.parse(readFileSync(join(state, "control.json"), "utf8")) : {}), ...patch })),
      calls: () => (existsSync(join(state, "calls.jsonl")) ? readFileSync(join(state, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
      jobs: () => (existsSync(join(state, "jobs")) ? readdirSync(join(state, "jobs")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(state, "jobs", n), "utf8"))) : []),
      release: (id) => void execFileSync(join(bin, "qex"), ["__release", id], { env }),
      scenario: (patch) => { const next = { ...JSON.parse(readFileSync(scenarioFile, "utf8")), ...patch }; writeFileSync(scenarioFile, JSON.stringify(next)); return scenarioFile; },
      executions: () => (existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean) : []),
    };
    return fake;
  };
}

/** A registered cargo adapter whose executable is the fake cargo. */
export function fakeCargoAdapter(overrides: Partial<AdapterRecord> = {}): AdapterRecord {
  const executable = join(FIXTURES, "v1/runners/fake-cargo.mjs");
  chmodSync(executable, 0o755);
  return { schemaVersion: "paneweft.adapter/1", id: "cargo", kind: "cargo", grammar: "cargo-test/1", repo: "vg", executable, workspaceRoot: join(FIXTURES, "crates/watchfile"), entry: ".", features: ["paneweft"], supportedVersions: ["1.97"], limits: { timeoutMs: 60_000, logBytes: 65_536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB", tags: ["paneweft"] }, ...overrides } as AdapterRecord;
}

// ---- git ----------------------------------------------------------------------------------------------------------------------------

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
}
export function makeRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
export function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}
export { appendFileSync, assert };

// ---- a seeded v1 session (catalogue record + adapter + repo root) ---------------------------------------------------------------------

/** Writes the catalogue record, adapters.json and registers the root of a tiny git copy of the watchfile fixture. Independent of src/v1. */
export async function seedToolSession(sessionDir: string, session: Session, root: string, adapter: AdapterRecord): Promise<void> {
  const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
  const files = (args: string[]) => git(root, ...args).split("\n").filter(Boolean);
  const paths = [...new Set([...files(["ls-files"]), ...files(["ls-files", "--others", "--exclude-standard"])])].sort();
  const members = paths.map((p) => ({ path: p, sha256: sha256(readFileSync(join(root, p), "utf8")) }));
  mkdirSync(join(sessionDir, "catalogues", "vg"), { recursive: true });
  writeFileSync(join(sessionDir, "catalogues", "vg", "cargo.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "vg", adapter: "cargo", catalogue, fingerprint: { digest: sha256(members.map((m) => `${m.path}\0${m.sha256}\n`).join("")), members, declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" }));
  writeFileSync(join(sessionDir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
  must(await session.registerRepository({ id: "vg", root }), "register root");
}
