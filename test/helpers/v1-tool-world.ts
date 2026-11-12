// The tool world shared by the v1 tool suites: a session, a registered vigil-like git repository with a stored catalogue and a registered fake-cargo
// adapter, a job service on the fake qex, and the three ways to call a tool (JSON payload, must-succeed, text).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Session } from "../../src/core/session.ts";
import { createJobService } from "../../src/v1/jobs.ts";
import { executeV1Operation, type V1Context } from "../../src/v1/tools.ts";
import { FIXTURES, fakeCargoAdapter, git, loadFixture, makeRepo, write, type FakeQex, type V1Env } from "./v1-world.ts";
import { must } from "./must.ts";

export const watchfileCatalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
const catalogue = watchfileCatalogue;

/** An independent fingerprint of a repo directory (git ls-files + untracked), so the seed does not depend on the code under test. */
export function independentFingerprint(root: string) {
  const files = (args: string[]) => git(root, ...args).split("\n").filter(Boolean);
  const paths = [...new Set([...files(["ls-files"]), ...files(["ls-files", "--others", "--exclude-standard"])])].sort();
  const members = paths.map((p) => ({ path: p, sha256: createHash("sha256").update(readFileSync(join(root, p))).digest("hex") }));
  const digest = createHash("sha256").update(members.map((m) => `${m.path}\0${m.sha256}\n`).join("")).digest("hex");
  return { digest, members, declaredExtras: [], exclusions: [] };
}

export function makeToolWorld(hooks: { open: () => Promise<V1Env>; tmp: (name: string) => string; fake: () => FakeQex }) {
  const { open, tmp, fake } = hooks;
  return async function toolWorld(options: { registerRoot?: boolean; stale?: boolean } = {}) {
    const { session, dir } = await open();
    const root = tmp("vigilrepo");
    cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
    makeRepo(root, {});
    const fingerprint = independentFingerprint(root);
    mkdirSync(join(dir, "catalogues", "vg"), { recursive: true });
    writeFileSync(join(dir, "catalogues", "vg", "cargo.json"), JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo: "vg", adapter: "cargo", catalogue, fingerprint, collectedAt: "2026-11-11T12:00:00Z" }));
    const adapter = fakeCargoAdapter({ workspaceRoot: root });
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
    if (options.registerRoot !== false) must(await session.registerRepository({ id: "vg", root }), "register root");
    if (options.stale) write(root, "src/lib.rs", "// edited after the catalogue was compiled\n");
    const qex = fake();
    const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue });
    const context: V1Context = { session, sessionDir: dir, jobs };
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const outcome = await executeV1Operation(context, tool, { format: "json", ...args });
      return { outcome, payload: outcome.ok ? JSON.parse(outcome.body) : JSON.parse(outcome.body) };
    };
    const text = async (tool: string, args: Record<string, unknown> = {}) => executeV1Operation(context, tool, { format: "text", ...args });
    /** A call that must succeed: the assertion happens here, so a failing stub is an assertion failure and not a TypeError further down. */
    const okCall = async (tool: string, args: Record<string, unknown> = {}) => { const result = await call(tool, args); expect(result.outcome.ok, `${tool}: ${result.outcome.body.slice(0, 300)}`).toBe(true); return result; };
    return { session, dir, root, qex, call, okCall, text, context, fingerprint, adapter };
  };
}
