// The environment of a job is pinned by its adapter record (F21). In the field test an MCP client that started the server with the SDK's default environment (HOME,
// LOGNAME, PATH, SHELL, TERM, USER) ran every cargo collect with qex's capture of THAT environment; the registered cargo was a rustup proxy that needs RUSTUP_HOME, which the
// CLI call (a login shell) had, so every MCP collect failed as "did not compile". The fakes hid it because a fake cargo needs nothing from its environment.
import { chmodSync, cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeV1Operation } from "./tools.ts";
import { buildQexSubmitArgv, createJobService } from "./jobs.ts";
import { createQexClient } from "./qex.ts";
import { FIXTURES, fakeCargoAdapter, makeRepo, seedToolSession, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const proxy = join(FIXTURES, "v1/runners/rustup-cargo.mjs");

/** The environment the MCP SDK's StdioClientTransport hands a server it starts without `env`, plus the switches of the fake qex (the world of the test). */
function bareMcpEnvironment(qexEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pick = (...names: string[]) => Object.fromEntries(names.filter((name) => qexEnv[name] !== undefined).map((name) => [name, qexEnv[name]]));
  return { ...pick("HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"), ...Object.fromEntries(Object.entries(qexEnv).filter(([name]) => name.startsWith("FAKE_"))) };
}

async function world(adapterOverrides: Record<string, unknown>) {
  chmodSync(proxy, 0o755);
  const { session, dir } = await open();
  const root = tmp("env-root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  const qex = fake();
  const adapter = fakeCargoAdapter({ executable: proxy, workspaceRoot: root, ...adapterOverrides });
  await seedToolSession(dir, session, root, adapter);
  // the MCP server was started with a bare environment, so the qex it spawns, and the job qex captures from it, have that environment and nothing else
  const bare = bareMcpEnvironment(qex.env);
  const service = createJobService({ session, sessionDir: dir, qex: createQexClient({ env: bare }), adapters: [adapter], env: bare });
  const finish = (id: string) => vi.waitFor(async () => { const s = must(await service.status(id, { waitSeconds: 5 }), "status"); expect(["succeeded", "failed", "cancelled"], JSON.stringify(s)).toContain(s.state); return s; }, { timeout: 60_000, interval: 100 });
  return { session, dir, service, finish, qex, adapter };
}

describe("[F21] the adapter pins the job environment", () => {
  // why: F21. The server was started with a bare environment (no RUSTUP_HOME). The adapter record fixes RUSTUP_HOME, so the collect runs the same job as from a login shell.
  // proves: CLAIM(F21-adapter-env)
  it("a bare submitting environment still runs the job the adapter describes", async () => {
    const w = await world({ env: { set: { RUSTUP_HOME: "/usr/local/rustup" } } });
    must(await w.service.collect({ requestId: "env-1", repo: "vg", adapter: "cargo", examples: ["watch.pending"] }), "collect");
    expect(await w.finish("env-1"), "RUSTUP_HOME comes from the adapter record").toMatchObject({ state: "succeeded" });
  }, 90_000);

  // why: F21. An adapter that pins nothing and a bare environment: the runner cannot start, and the diagnostic says that (category `runner`, not "the instrumentation did not
  // compile"), names the missing variable and the owner action that fixes it.
  // proves: CLAIM(F21-runner-not-started)
  it("a rustup proxy without RUSTUP_HOME is a runner that could not start, with the fix named", async () => {
    const w = await world({});
    must(await w.service.collect({ requestId: "env-2", repo: "vg", adapter: "cargo", examples: ["watch.pending"] }), "collect");
    const done = await w.finish("env-2");
    expect(done.state).toBe("failed");
    const diagnostic = JSON.parse((await executeV1Operation({ session: w.session, sessionDir: w.dir, jobs: w.service }, "explain_failure", { format: "json", diagnostic: done.diagnosticIds[0] })).body).items[0];
    expect(diagnostic.category).toBe("runner");
    expect(diagnostic.message).toMatch(/could not start/);
    expect(diagnostic.message).toMatch(/rustup could not choose a version/);
    expect(diagnostic.nextAction).toMatch(/RUSTUP_HOME/);
    expect(diagnostic.nextAction).toMatch(/paneweft adapter add/);
  }, 90_000);

  // why: F21, "CLI and MCP behave the same". The vector handed to qex is the same whatever the submitting process holds, for every name the adapter fixes; only a passthrough
  // name the submitter has differs, and the default passthrough list is the documented one.
  // proves: CLAIM(F21-same-job)
  it("the submit vector does not depend on the submitting environment for names the adapter fixes", () => {
    const adapter = fakeCargoAdapter({ env: { set: { RUSTUP_HOME: "/usr/local/rustup", CARGO_HOME: "/usr/local/cargo" }, passthrough: ["MY_TOOL_HOME"] } });
    const spec = { executable: adapter.executable, argv: ["test"], cwd: adapter.workspaceRoot, env: { ...adapter.env!.set, PANEWEFT_RUN_ID: "run-a" } };
    const bare = buildQexSubmitArgv(adapter, "a", spec, "/s/jobs/a", 60_000, "k", "qex.id", { PATH: "/usr/bin", HOME: "/home/u" });
    const login = buildQexSubmitArgv(adapter, "a", spec, "/s/jobs/a", 60_000, "k", "qex.id", { PATH: "/usr/bin", HOME: "/home/u", RUSTUP_HOME: "/elsewhere", CARGO_HOME: "/elsewhere/cargo", SECRET_TOKEN: "x", TERM: "xterm" });
    const envOf = (argv: string[]) => argv.flatMap((arg, at) => (argv[at - 1] === "--env" ? [arg] : []));
    expect(bare).toContain("--env-capture");
    expect(argvAfter(bare, "--env-capture")).toBe("minimal");
    expect(envOf(bare)).toEqual(["CARGO_HOME=/usr/local/cargo", "PANEWEFT_RUN_ID=run-a", "RUSTUP_HOME=/usr/local/rustup"]);
    expect(envOf(login), "the fixed names win; SECRET_TOKEN is not in the default or declared list; TERM is a default passthrough").toEqual(["CARGO_HOME=/usr/local/cargo", "PANEWEFT_RUN_ID=run-a", "RUSTUP_HOME=/usr/local/rustup", "TERM=xterm"]);
  });
});

const argvAfter = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
