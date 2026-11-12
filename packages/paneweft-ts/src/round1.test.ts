// Fix round 1 (S8, S10, S18): capture isolation under concurrency, accessors on array indexes, and the failure of an example that throws undefined.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV, defineType, encodeValue, example, defaultLimits, inspect, runExample, takeInvocations } from "./index.ts";
import { outcomeToThrow } from "./vitest.ts";
import { callAsync } from "../test/support.ts";

const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); for (const name of Object.values(ENV)) delete process.env[name]; });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const Subject = defineType<{ name: string }>({ id: "fixture::Subject", source: { path: "x.ts", symbol: "Subject" } });
Subject.view({ id: "subject.details", title: "Subject", question: "Which?", priority: 1, component: "shape", render: (s, view) => { view.field("name", s.name); return view.details().field("name", s.name).done(); } });
const Extra = defineType<{ n: string }>({ id: "fixture::Extra", source: { path: "x.ts", symbol: "Extra" } });
Extra.view({ id: "extra.details", title: "Extra", question: "Which?", priority: 1, component: "shape", render: (s, view) => { view.field("n", s.n); return view.details().field("n", s.n).done(); } });

describe("[S8] a capture belongs to the call chain that started it", () => {
  // why: S8. The active collector was one process-wide stack, so with two async examples in flight A's inspect() went to B's capture
  // and B's later inspect() to A's (and each popped the other's capture). Rejects the module-global ACTIVE stack.
  // proves: CLAIM(S8-async-capture)
  it("keeps the inspections of concurrent examples in their own captures", async () => {
    takeInvocations();
    const dir = mkdtempSync(join(tmpdir(), "paneweft-ts-"));
    created.push(dir);
    Object.assign(process.env, { PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-c", PANEWEFT_STAGING_DIR: dir });
    const a = example({ id: "a", type: Subject, claims: ["A"], async run(cx) { await pause(30); inspect({ n: "inspected-by-a" }, Extra); await pause(30); cx.check("A", () => {}); return { name: "a" }; } });
    const b = example({ id: "b", type: Subject, claims: ["B"], async run(cx) { await pause(5); inspect({ n: "inspected-by-b" }, Extra); await pause(60); inspect({ n: "inspected-by-b-later" }, Extra); cx.check("B", () => {}); return { name: "b" }; } });
    await callAsync(() => Promise.all([runExample(a), runExample(b)]), "concurrent examples");
    const captures = readdirSync(join(dir, "captures")).map((file) => JSON.parse(readFileSync(join(dir, "captures", file), "utf8")));
    const byRoot = (root: string) => captures.find((c) => c.objects.some((o: any) => o.fields.name === root));
    const mine = (root: string): string[] => byRoot(root).objects.map((o: any) => o.fields.n ?? o.fields.name).sort();
    expect(mine("a")).toEqual(["a", "inspected-by-a"]);
    expect(mine("b")).toEqual(["b", "inspected-by-b", "inspected-by-b-later"]);
  });
});

describe("[S10] an accessor on an array index is not run", () => {
  // why: S10. Array.prototype.map read every index, so an accessor on an array element ran and its (secret) return value was captured, while
  // the same accessor on a record was refused. Rejects the encoder that walks arrays with map/for-of instead of inspecting descriptors.
  // proves: CLAIM(S10-no-getters)
  it("encodes an index accessor as unsupported and never calls it", () => {
    let calls = 0;
    const list: unknown[] = [1, 2, 3];
    Object.defineProperty(list, 1, { get() { calls += 1; return "the-secret"; }, enumerable: true });
    const encoded = encodeValue(list as never, defaultLimits());
    expect(calls, "the getter ran").toBe(0);
    expect(encoded).toEqual([1, { $paneweft: "unsupported", reason: "getter" }, 3]);
    expect(JSON.stringify(encoded)).not.toContain("the-secret");
  });

  // why: S10. The same holds for an accessor on a record (the control) and one nested inside an array of records.
  // proves: CLAIM(S10-no-getters)
  it("still refuses a record accessor and an accessor nested in an array", () => {
    let calls = 0;
    const record = { plain: 1, get secret() { calls += 1; return "s"; } };
    expect(encodeValue([record] as never, defaultLimits())).toEqual([{ plain: 1, secret: { $paneweft: "unsupported", reason: "getter" } }]);
    expect(calls).toBe(0);
  });
});

describe("[S18] an example that throws undefined has failed", () => {
  // why: S18. runExample signalled failure with `error !== undefined`, so `throw undefined` produced error=undefined: exampleTest treated it as a
  // pass and a parent that called it with cx.use passed. Failure now has its own discriminant.
  // proves: CLAIM(S18-failure-sentinel)
  it("reports failure for a thrown undefined, and blocks the parent", async () => {
    takeInvocations();
    const thrower = example({ id: "thrower", type: Subject, claims: ["T"], run() { throw undefined; } });
    const parent = example({ id: "parent", type: Subject, claims: ["P"], async run(cx) { await cx.use(thrower); cx.check("P", () => {}); return { name: "parent" }; } });
    const direct = await callAsync(() => runExample(thrower), "runExample");
    expect(direct.failed).toBe(true);
    expect(direct.invocation.native.outcome).toBe("error");
    takeInvocations();
    const nested = await callAsync(() => runExample(parent), "runExample");
    expect(nested.failed, "the parent passed although its child threw").toBe(true);
    expect(nested.invocation.native.outcome).toBe("blocked");
  });

  // why: S18. What exampleTest rethrows for a failed result is never undefined (vitest would take that for a pass); a passing result throws nothing.
  // proves: CLAIM(S18-failure-sentinel)
  it("exampleTest throws for every failed outcome and for nothing else", () => {
    expect(outcomeToThrow({ failed: false })).toBeUndefined();
    expect(outcomeToThrow({ failed: true, error: undefined })).toBeInstanceOf(Error);
    const original = new Error("boom");
    expect(outcomeToThrow({ failed: true, error: original })).toBe(original);
  });
});
