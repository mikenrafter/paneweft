// T11: MCP clients show a server's `instructions` string to the model, so the workflow and the cursor rule reach an agent that has never read
// the README. The string is advertised in the initialize result; the unused first parameter of runMcpStdio is gone.
import { describe, expect, it } from "vitest";
import { connectMcp } from "../../test/helpers/mcp-client.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { runMcpStdio } from "./server.ts";
import { join } from "node:path";

const tmp = useTempDirs();

describe("mcp: instructions (T11)", () => {
  // why: advertised over the real stdio protocol, not read from a constant: the client SDK got it in the initialize result. It must name the
  //   workflow tools in order and say how paging works, because those are the two things a model cannot guess.
  // proves: CLAIM(mcp-instructions)
  it("[T11] initialize carries instructions naming the workflow in order, the byte budget and the cursor rule", async () => {
    const mcp = await connectMcp(join(tmp("mcp-instr"), "s"));
    try {
      const text = mcp.instructions();
      expect(text, "no instructions in the initialize result").toBeTypeOf("string");
      const at = (word: string) => (text as string).indexOf(word);
      const workflow = ["list_components", "describe_component", "validate", "render", "inspect_view"];
      workflow.forEach((word, position) => {
        expect(at(word), `${word} is not mentioned`).toBeGreaterThanOrEqual(0);
        if (position > 0) expect(at(word), `${word} comes before ${workflow[position - 1]}`).toBeGreaterThan(at(workflow[position - 1] as string));
      });
      expect(text).toContain("maxBytes");
      expect(text).toContain("cursor");
      expect(text).toContain("SAME request");
      expect((text as string).length).toBeLessThan(2000);
    } finally {
      await mcp.close();
    }
  });

  // why: every tool the instructions name must exist (a renamed tool must not leave the instructions pointing at nothing).
  // proves: CLAIM(mcp-instructions)
  it("[T11] every snake_case tool name in the instructions is an advertised tool", async () => {
    const mcp = await connectMcp(null);
    try {
      const advertised = new Set((await mcp.listTools()).map((tool) => tool.name));
      const named = ((mcp.instructions() ?? "").match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((word) => !["snake_case"].includes(word));
      expect(named.length).toBeGreaterThan(5);
      expect(named.filter((name) => !advertised.has(name))).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  // why: the first parameter of runMcpStdio was never read; the function takes the session only.
  // proves: CLAIM(mcp-instructions)
  it("[T11] runMcpStdio takes one parameter (the session)", () => {
    expect(runMcpStdio.length).toBe(1);
  });
});
