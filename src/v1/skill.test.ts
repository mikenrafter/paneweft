// The shipped agent skill (spec section 6, "The agent skill to ship"). Prose cannot be proven; the tests pin what a reader acts on:
// the skill exists, its commands and tool names are real, and its loop covers discovery to explanation. IV22 (a fresh agent following it)
// is a separately recorded, scored exercise, not a red test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/helpers/v1-world.ts";
import { V1_COMMANDS } from "../cli/v1-commands.ts";
import { V1_REQUIRED_TOOL_NAMES, V1_TOOL_NAMES } from "./schemas.ts";

const skill = readFileSync(join(REPO_ROOT, "skills/paneweft-views/SKILL.md"), "utf8");

describe("[IV22 groundwork] skills/paneweft-views/SKILL.md", () => {
  // why: the skill is agentskills.io format (front matter with name and description) and names the six steps of the loop.
  // proves: CLAIM(IV22-recipe)
  it("has front matter and the loop", () => {
    expect(skill.startsWith("---\nname: paneweft-views\ndescription: ")).toBe(true);
    for (const step of ["list_types", "list_views_for_type", "list_examples", "scaffold_view", "collect", "view_result", "explain_failure"]) expect(skill, step).toContain(step);
    expect(skill).toMatch(/failing assertion|run it red/i);
    expect(skill).toContain("JSON");
  });

  // why: every snake_case tool the skill mentions is a real v1 tool (or a v0 tool of the JSON fallback), so the recipe cannot drift.
  // proves: CLAIM(IV22-recipe)
  it("names only real tools", () => {
    const v0 = ["list_components", "describe_component", "validate", "render"];
    const names = [...new Set(skill.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].filter((n) => !["build_loop"].includes(n));
    for (const name of names) expect([...V1_TOOL_NAMES, ...v0], name).toContain(name);
    for (const required of V1_REQUIRED_TOOL_NAMES) expect(skill, required).toContain(required);
  });

  // why: the commands in the skill's shell blocks use real v1 command words.
  // proves: CLAIM(IV22-recipe)
  it("shell commands use real paneweft commands", () => {
    const commands = [...skill.matchAll(/^\s*paneweft ([a-z]+(?: [a-z]+)?)/gm)].map((m) => m[1]!.split(" ")[0]);
    const known = new Set([...V1_COMMANDS.map((c) => c.words[0]), "adapter", "renderers", "repo", "catalogue", "serve", "components", "describe", "validate", "render"]);
    expect(commands.length).toBeGreaterThan(0);
    for (const word of commands) expect(known.has(word!), word).toBe(true);
  });
});
