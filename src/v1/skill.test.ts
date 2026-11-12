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
    // fenced blocks hold the target languages' identifiers and macros (`test_adapter`, `check_eq`), not tool names
    const prose = skill.replace(/```[a-z]*\n[\s\S]*?```/g, "");
    const names = [...new Set(prose.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].filter((n) => !["build_loop"].includes(n));
    for (const name of names) expect([...V1_TOOL_NAMES, ...v0], name).toContain(name);
    for (const required of V1_REQUIRED_TOOL_NAMES) expect(skill, required).toContain(required);
  });

  // why: the commands in the skill's shell blocks use real v1 command words.
  // proves: CLAIM(IV22-recipe)
  it("shell commands use real paneweft commands", () => {
    const commands = [...skill.matchAll(/^\s*paneweft ([a-z]+(?: [a-z]+)?)/gm)].map((m) => m[1]!.split(" ")[0]);
    const known = new Set([...V1_COMMANDS.map((c) => c.words[0]), "adapter", "renderers", "repo", "catalogue", "inventory", "serve", "components", "describe", "validate", "render"]);
    expect(commands.length).toBeGreaterThan(0);
    for (const word of commands) expect(known.has(word!), word).toBe(true);
  });

  // why: T4. The steps never send an agent to an owner-only catalogue step: on a fresh repository the first collect exports the catalogue, and a new
  // example needs no refresh. The owner's `catalogue refresh` is mentioned only as an owner command.
  // proves: CLAIM(T4-fresh-repo) CLAIM(IV22-recipe)
  it("needs no catalogue refresh on a fresh repository", () => {
    const steps = skill.slice(skill.indexOf("\n1. "), skill.indexOf("Command recipe"));
    expect(steps).not.toMatch(/refresh/i);
    expect(steps).toMatch(/exports the catalogue/i);
    expect(steps).toMatch(/no catalogue|not stored|fresh repo/i);
    expect(steps).toMatch(/source/);
    const recipe = skill.slice(skill.indexOf("Command recipe"));
    expect(recipe.match(/paneweft catalogue refresh/g)?.length ?? 0, "refresh appears at most as an owner command").toBeLessThanOrEqual(1);
  });

  // why: F12/F13/F30 and the field test's "skill steps that were unclear" (1-8). Each unclear step is now a statement a reader acts on; pinning them keeps a later
  // edit from dropping one. Spec section 6 promises Rust and TypeScript recipes: both exist, with the release check and the in-memory red test.
  // proves: CLAIM(F12-skill-steps)
  it("answers the field test's unclear steps and carries a Rust and a TypeScript recipe", () => {
    const steps = skill.slice(skill.indexOf("\n1. "), skill.indexOf("Command recipe"));
    expect(steps, "1-2: what wiring exists and who adds it").toMatch(/paneweft.views\.ts/);
    expect(steps).toMatch(/setup/);
    expect(steps, "3: the red test builds the view in memory").toMatch(/in memory/);
    expect(steps).toMatch(/TypeError/);
    expect(steps, "4: the release check").toMatch(/must not mention the SDK/);
    expect(steps, "5: the job advances on its own").toMatch(/advances by itself/);
    expect(steps, "6: result selectors and the viewer").toMatch(/--example/);
    expect(steps).toMatch(/paneweft serve/);
    expect(steps, "7: the inventory is written after the first collect").toMatch(/AFTER the first successful collect/);
    expect(steps, "8: the real diagnostic id").toMatch(/run-<job>:diag/);
    expect(skill).toMatch(/Rust recipe/);
    expect(skill).toMatch(/TypeScript recipe/);
    expect(skill, "the Rust recipe is the pinned git dependency").toContain("[dependencies.paneweft]\ngit = ");
    expect(skill).not.toContain("vendor-rust-sdk.mjs");
    expect(skill).toContain("@paneweft/sdk/vitest-reporter");
    expect(skill).toContain("mod paneweft_examples");
    expect(skill).toContain("cx.details()");
  });
});
