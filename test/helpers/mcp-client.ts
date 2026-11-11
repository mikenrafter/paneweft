// A real MCP client over stdio against `paneweft mcp`. The ONLY file importing the MCP client SDK, so a
// future SDK major (the @modelcontextprotocol/server + /client 2.x split exists) changes one file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assert } from "vitest";
import { REPO_ROOT } from "./fixtures.ts";

export interface McpTextResult { isError: boolean; text: string; blocks: number; raw: unknown }
export interface McpConnection {
  /** The `instructions` string the server returned in its initialize result, if any. */
  instructions(): string | undefined;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, any> }>>;
  call(name: string, args: Record<string, unknown>): Promise<McpTextResult>;
  close(): Promise<void>;
}

/** Connects or fails the calling test by assertion (stubs exit at once, so this never hangs). */
export async function connectMcp(sessionDir: string | null, options: { timeoutMs?: number } = {}): Promise<McpConnection> {
  const args = ["--import", "tsx", "src/cli/bin.ts", "mcp", ...(sessionDir === null ? [] : ["--session", sessionDir])];
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: REPO_ROOT, stderr: "pipe" });
  const client = new Client({ name: "paneweft-test", version: "0.0.0" }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("initialize timed out")), options.timeoutMs ?? 15_000);
      }),
    ]);
  } catch (error) {
    await transport.close().catch(() => {});
    assert.fail(`MCP server did not complete initialize: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    instructions: () => client.getInstructions(),
    async listTools() {
      const listed = await client.listTools();
      return listed.tools as Array<{ name: string; description?: string; inputSchema: Record<string, any> }>;
    },
    async call(name, callArguments) {
      const result: any = await client.callTool({ name, arguments: callArguments });
      const content: Array<{ type: string; text?: string }> = result.content ?? [];
      const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      return { isError: result.isError === true, text, blocks: content.length, raw: result };
    },
    close: () => client.close(),
  };
}
