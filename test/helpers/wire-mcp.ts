// MCP helpers of the `wire` slice. The SDK client stays inside test/helpers/mcp-client.ts; this file adds
//   - a connection shared by the tests of one file (one spawned server instead of one per test),
//   - a RAW stdio child for the stdout-cleanliness claim (no SDK between the server and the assertion).
import { spawn } from "node:child_process";
import { assert } from "vitest";
import { REPO_ROOT } from "./fixtures.ts";
import { connectMcp, type McpConnection, type McpTextResult } from "./mcp-client.ts";
import { lazyShared } from "./wire-session.ts";

/** A connection opened at first use (the first user fails by assertion when the server cannot start) and closed after the file. */
export function sharedMcp(sessionDir: () => Promise<string | null>): () => Promise<McpConnection> {
  return lazyShared(async () => connectMcp(await sessionDir()), (connection) => connection.close());
}

/** tools/call that turns a protocol-level rejection into a failing assertion carrying the cause. */
export async function callTool(connection: McpConnection, name: string, args: Record<string, unknown>): Promise<McpTextResult> {
  try {
    return await connection.call(name, args);
  } catch (error) {
    return assert.fail(`tools/call ${name} was rejected at the protocol level: ${String(error)}`);
  }
}

export interface RawMcpChild {
  /** Writes one JSON-RPC message as a single line. */
  send(message: unknown): void;
  /** Every complete stdout line received so far. */
  readonly lines: string[];
  readonly stderr: () => string;
  /** Resolves with the first JSON-RPC response carrying `id`, or fails by assertion when the child exits/times out first. */
  response(id: number, timeoutMs?: number): Promise<Record<string, any>>;
  /** Closes stdin and resolves with the exit code, or fails by assertion after `timeoutMs`. */
  closeStdinAndWaitForExit(timeoutMs?: number): Promise<number | null>;
  kill(): void;
}

export function spawnRawMcp(sessionDir: string): RawMcpChild {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/bin.ts", "mcp", "--session", sessionDir], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let pendingText = "";
  let stderrText = "";
  let exited: { code: number | null } | null = null;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  child.stdout.on("data", (part: Buffer) => {
    pendingText += part.toString("utf8");
    let index: number;
    while ((index = pendingText.indexOf("\n")) >= 0) {
      lines.push(pendingText.slice(0, index));
      pendingText = pendingText.slice(index + 1);
    }
    wake();
  });
  child.stdout.on("end", () => {
    if (pendingText !== "") lines.push(pendingText);
    pendingText = "";
    wake();
  });
  child.stderr.on("data", (part: Buffer) => void (stderrText += part.toString("utf8")));
  child.on("exit", (code) => {
    exited = { code };
    wake();
  });
  child.stdin.on("error", () => {});
  const waitUntil = (done: () => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(done()), timeoutMs);
      const check = () => {
        if (done()) {
          clearTimeout(timer);
          resolve(true);
        } else waiters.push(check);
      };
      check();
    });
  return {
    send: (message) => void child.stdin.write(`${JSON.stringify(message)}\n`),
    lines,
    stderr: () => stderrText,
    async response(id, timeoutMs = 20000) {
      const find = (): Record<string, any> | undefined => {
        for (const line of lines) {
          let message: Record<string, any> | null = null;
          try { message = JSON.parse(line) as Record<string, any>; } catch { message = null; }
          if (message !== null && message.id === id && ("result" in message || "error" in message)) return message;
        }
        return undefined;
      };
      const ok = await waitUntil(() => find() !== undefined || exited !== null, timeoutMs);
      const found = find();
      if (!ok || found === undefined) {
        return assert.fail(`no JSON-RPC response with id ${id}; child exited: ${JSON.stringify(exited)}; stdout lines: ${JSON.stringify(lines)}; stderr: ${stderrText.slice(0, 400)}`);
      }
      return found;
    },
    async closeStdinAndWaitForExit(timeoutMs = 15000) {
      child.stdin.end();
      const ok = await waitUntil(() => exited !== null, timeoutMs);
      if (!ok) {
        child.kill("SIGKILL");
        return assert.fail("the MCP server did not exit within the timeout after stdin closed");
      }
      return (exited as { code: number | null } | null)?.code ?? null;
    },
    kill: () => void child.kill("SIGKILL"),
  };
}
