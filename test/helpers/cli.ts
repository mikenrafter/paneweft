import { spawn } from "node:child_process";
import { runCli } from "../../src/cli/main.ts";
import { REPO_ROOT } from "./fixtures.ts";

export interface CliRun { exitCode: number; stdout: string; stderr: string }

/** In-process: fast, used for argument-handling tests. */
export async function runCliInProcess(argv: string[], options: { stdin?: string | null; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    stdin: options.stdin ?? null,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    env: options.env ?? {},
    cwd: options.cwd ?? REPO_ROOT,
  });
  return { exitCode, stdout, stderr };
}

/** Real process: the bin entry the user runs. Used for parity and stdio tests. */
export function spawnPaneweft(args: string[], options: { stdin?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/bin.ts", ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
    child.stderr.on("data", (part: Buffer) => void (stderr += part.toString("utf8")));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}
