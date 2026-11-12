// Where a failed check is (F30c): the diagnostic of a failed TypeScript check pointed at the `example({` line (tests/fieldtest.paneweft.ts:15) and not at the failing
// check (line 17). The invocation record now carries the first stack frame of the failure that is not the SDK's and not a dependency's.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineType, example, runExample } from "./index.ts";

const Subject = defineType<{ tick: number }>({ id: "fixture::Sites", source: { path: "x.ts", symbol: "Subject" } });
const here = fileURLToPath(import.meta.url);
const repoPath = relative(process.cwd(), here).split("\\").join("/");
/** The line (1-based) of the first line that contains `marker`: an oracle that does not use the code under test. */
const lineOf = (marker: string): number => readFileSync(here, "utf8").split("\n").findIndex((line) => line.includes(marker)) + 1;

describe("[F30c] the site of a failed check", () => {
  // why: F30c. The failing `expect` is inside the callback of cx.check, many lines below `example({`; the record names that line in the repository-relative path, for an error thrown
  // synchronously, one thrown by an async assertion, and not for a passing check.
  // proves: CLAIM(F30c-check-site)
  it("records the line of the failing assertion in the author's file", async () => {
    const sites = example({ id: "sites.failing", type: Subject, claims: ["A", "B", "C"], async run(cx) {
      cx.check("A", () => { /* passes */ });
      cx.check("B", () => { throw new Error("sync failure"); }); // site-sync
      await cx.check("C", async () => { throw new Error("async failure"); }); // site-async
      return { tick: 1 };
    } });
    const run = await runExample(sites);
    const checks = run.invocation.checks as Array<{ claim: string; passed: boolean; source?: { path: string; line: number } }>;
    expect(checks.map((check) => [check.claim, check.passed])).toEqual([["A", true], ["B", false], ["C", false]]);
    expect(checks[0]?.source, "a passing check has no site").toBeUndefined();
    expect(checks[1]?.source).toEqual({ path: repoPath, line: lineOf("// site-sync") });
    expect(checks[2]?.source).toEqual({ path: repoPath, line: lineOf("// site-async") });
  });

  // why: F30c. An error whose stack holds no frame of the author's code (a rejection created inside a dependency) has no site; the record carries none rather than a frame of the SDK.
  // proves: CLAIM(F30c-check-site)
  it("records no site when the stack names only the SDK and dependencies", async () => {
    const bare = example({ id: "sites.bare", type: Subject, claims: ["A"], run(cx) {
      cx.check("A", () => { throw Object.assign(new Error("no frames"), { stack: "Error: no frames\n    at somewhere (/node_modules/dep/index.js:1:1)" }); });
      return { tick: 1 };
    } });
    const run = await runExample(bare);
    expect((run.invocation.checks as Array<{ source?: unknown }>)[0]?.source).toBeUndefined();
  });
});
