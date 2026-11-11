// T2 (tier-2 review S2): `bin` is a TypeScript file run by Node's own type stripping (package.json engines >= 22.18), so an operator who
// follows the README has no tsx. Every other process test in the repo starts the CLI with `--import tsx`; this file starts it the way the
// README says, as `node src/cli/bin.ts`, and proves the whole import graph loads and the commands work that way.
// The control run (type stripping switched off) fails, so a pass is down to Node's stripping and not to some loader the harness added.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();

interface Finished { exitCode: number | null; stdout: string; stderr: string }

/** `node [...nodeFlags] src/cli/bin.ts ...args`, no tsx, no NODE_OPTIONS (so no inherited `--import`). */
function bare(args: string[], options: { nodeFlags?: string[]; env?: Record<string, string> } = {}): Promise<Finished> {
  return new Promise((resolve) => {
    const { NODE_OPTIONS: _dropped, ...env } = process.env;
    const child = spawn(process.execPath, [...(options.nodeFlags ?? []), "src/cli/bin.ts", ...args], { cwd: REPO_ROOT, env: { ...env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
    child.stderr.on("data", (part: Buffer) => void (stderr += part.toString("utf8")));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("bin runs under plain node (no tsx)", () => {
  // why: the README tells operators to run `node src/cli/bin.ts`; if any module needs a loader (enum, parameter property, extensionless import)
  //   the first command fails with a syntax error that no tsx-based test can see.
  // proves: CLAIM(cli-runs-under-node)
  it("[T2] `node src/cli/bin.ts --help` exits 0 and prints the command list", async () => {
    const run = await bare(["--help"]);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^paneweft - portable moldable views for coding agents/);
    expect(run.stdout).toMatch(/^\s*render\b/m);
  });

  // why: --help imports only main.ts; a real command pulls in the schemas (JSON), the validator (ajv) and the operation layer.
  // proves: CLAIM(cli-runs-under-node)
  it("[T2] `components --format json` and a render + inspect round trip work without tsx", async () => {
    const components = await bare(["components", "--format", "json"]);
    expect(components.exitCode, components.stderr).toBe(0);
    expect((JSON.parse(components.stdout) as { schemaVersion: string }).schemaVersion).toBe("paneweft.components/1");

    const session = join(tmp("smoke"), "s");
    const rendered = await bare(["--session", session, "render", "--file", join(FIXTURES, "components", "all.bundle.json")]);
    expect(rendered.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain("stored: ");
    const inspected = await bare(["--session", session, "inspect", "--view", "modules", "--snapshot", "snap-1", "--format", "json"]);
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    expect((JSON.parse(inspected.stdout) as { view: { id: string } }).view.id).toBe("modules");
  });

  // why: `serve` loads viewer/server.ts lazily, so only starting it proves that module (and confined-read, session-source) strips cleanly.
  //   The viewer prints its URL, answers an authenticated API call, and SIGTERM stops it with exit 0 and removes server.json.
  // proves: CLAIM(cli-runs-under-node)
  it("[T2] `serve` starts under plain node, answers /api/index with its token, and stops on SIGTERM", async () => {
    const session = join(tmp("smoke-serve"), "s");
    const seeded = await bare(["--session", session, "render", "--file", join(FIXTURES, "components", "all.bundle.json")]);
    expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);

    const { NODE_OPTIONS: _dropped, ...env } = process.env;
    const child = spawn(process.execPath, ["src/cli/bin.ts", "--session", session, "serve", "--port", "0"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (part: Buffer) => void (stderr += part.toString("utf8")));
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no viewer URL after 20 s; stdout=${stdout} stderr=${stderr}`)), 20_000);
        child.once("close", () => reject(new Error(`serve exited early; stdout=${stdout} stderr=${stderr}`)));
        child.stdout.on("data", (part: Buffer) => {
          stdout += part.toString("utf8");
          const found = /paneweft viewer: (http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]+)/.exec(stdout);
          if (found !== null) { clearTimeout(timer); resolve(`${found[1]} ${found[2]}`); }
        });
      });
      const [origin, token] = url.split(" ") as [string, string];
      const response = await fetch(`${origin}/api/index`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const index = (await response.json()) as { views: Array<{ viewId: string }> };
      expect(index.views.map((view) => view.viewId)).toContain("modules");
      expect(existsSync(join(session, "server.json"))).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await closed).toBe(0);
    expect(existsSync(join(session, "server.json"))).toBe(false);
  });

  // why: negative control. With type stripping off the same entry must fail, so the three tests above cannot be passing because of a
  //   loader the harness or the environment quietly supplies.
  // proves: CLAIM(cli-runs-under-node)
  it("[T2] control: with --no-experimental-strip-types the entry does not run", async () => {
    const run = await bare(["--help"], { nodeFlags: ["--no-experimental-strip-types"] });
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe("");
  });
});
