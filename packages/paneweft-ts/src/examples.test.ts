// Examples at invocation level: composition and parent edges (IV7), checks and the zero-check rule (IV6), the outcome vocabulary
// (S6) and expectFailure (N4), without a runner. The vitest integration is in vitest.integration.test.ts.
import { describe, expect, it } from "vitest";
import { defineType, example, expectFailure, anyFailure, messageContains, runExample, takeInvocations, type InvocationRecord } from "./index.ts";
import { callAsync } from "../test/support.ts";

const Subject = defineType<{ tick: number }>({ id: "fixture::Subject", source: { path: "x.ts", symbol: "Subject" } });
Subject.view({ id: "subject.details", title: "Subject", question: "Which tick?", priority: 10, component: "shape", render: (s, view) => view.details().field("tick", s.tick).done() });

const pending = example({ id: "subject.pending", type: Subject, claims: ["S1"], run(cx) { cx.check("S1", () => { if (1 + 1 !== 2) throw new Error("arithmetic"); }); return { tick: 0 }; } });
const cancelled = example({ id: "subject.cancelled", type: Subject, claims: ["S2", "S2-empty"], async run(cx) {
  const base = await cx.use(pending);
  cx.check("S2", () => {});
  cx.check("S2-empty", () => {});
  return { ...base, tick: 1 };
} });
const zero = example({ id: "subject.zero", type: Subject, claims: [], run: () => ({ tick: 2 }) });
const failing = example({ id: "subject.failing", type: Subject, claims: ["F1"], run(cx) { cx.check("F1", () => { throw new Error("expected 1 to equal 2"); }); return { tick: 3 }; } });
const throwing = example({ id: "subject.throwing", type: Subject, claims: [], run() { throw new Error("boom"); } });
const parent = example({ id: "subject.parent", type: Subject, claims: [], async run(cx) { await cx.use(throwing); return { tick: 4 }; } });
const deadEnd = example({ id: "subject.dead-end", type: Subject, claims: ["DE"], kind: "dead-end", async run() {
  await expectFailure(messageContains("lock held"), () => { throw new Error("userspace lock held by dead pid"); });
  return { tick: 5 };
} });
const unexpectedSuccess = example({ id: "subject.unexpected-success", type: Subject, claims: [], kind: "dead-end", async run() { await expectFailure(anyFailure, () => {}); return { tick: 6 }; } });
const unrelated = example({ id: "subject.unrelated", type: Subject, claims: [], kind: "dead-end", async run() { await expectFailure(messageContains("lock held"), () => { throw new Error("disk full"); }); return { tick: 7 }; } });
const a: ReturnType<typeof example<{ tick: number }>> = example({ id: "subject.a", type: Subject, claims: [], async run(cx) { await cx.use(b); return { tick: 8 }; } });
const b: ReturnType<typeof example<{ tick: number }>> = example({ id: "subject.b", type: Subject, claims: [], async run(cx) { await cx.use(a); return { tick: 9 }; } });

const byId = (records: InvocationRecord[], id: string): InvocationRecord => {
  const found = records.find((r) => r.exampleId === id);
  expect(found, `no invocation of ${id} in ${JSON.stringify(records.map((r) => r.exampleId))}`).toBeDefined();
  return found as InvocationRecord;
};

describe("[IV5][IV7] composed examples", () => {
  // why: IV7. cx.use records a parent edge (cancelled -> pending) in start order, both passed with their own checks, verified.
  // proves: CLAIM(IV7) CLAIM(IV5)
  it("records parent edges and checks", async () => {
    takeInvocations();
    const result = await callAsync(() => runExample(cancelled), "runExample");
    expect(result.value).toEqual({ tick: 1 });
    const records = takeInvocations();
    expect(records.map((r) => r.exampleId)).toEqual(["subject.cancelled", "subject.pending"]);
    expect(records[0]!.parent).toBeNull();
    expect(records[1]!.parent).toBe(records[0]!.id);
    expect(records.map((r) => r.native)).toEqual([{ outcome: "passed" }, { outcome: "passed" }]);
    expect(records[0]!.checks).toEqual([{ claim: "S2", passed: true }, { claim: "S2-empty", passed: true }]);
    expect(records[1]!.checks).toEqual([{ claim: "S1", passed: true }]);
    expect(records.every((r) => r.verified)).toBe(true);
  });

  // why: IV7. No memoization: two uses build two values; the second invocation is a second record.
  // proves: CLAIM(IV7)
  it("each use builds a fresh value", async () => {
    takeInvocations();
    const first = await callAsync(() => runExample(pending), "first");
    const second = await callAsync(() => runExample(pending), "second");
    expect(first.value).not.toBe(second.value);
    expect(takeInvocations()).toHaveLength(2);
  });

  // why: IV7. Recursion stops with the invocation path as a bounded error instead of hanging.
  // proves: CLAIM(IV7)
  it("a recursive call stops with its path", async () => {
    takeInvocations();
    const result = await callAsync(() => runExample(a), "runExample");
    const records = takeInvocations();
    expect(records.length).toBeLessThanOrEqual(8);
    const message = records.map((r) => (r.native.outcome === "error" ? r.native.message : "")).find((m) => m.includes("recursive"));
    expect(message, JSON.stringify(result.invocation)).toContain("subject.a -> subject.b -> subject.a");
  });
});

describe("[S6] outcomes", () => {
  // why: IV6. Without an executed recorded check an invocation passes but is exploratory, never verified.
  // proves: CLAIM(IV6) CLAIM(S6-outcomes)
  it("a zero-check invocation passes but is not verified", async () => {
    takeInvocations();
    const { invocation } = await callAsync(() => runExample(zero), "runExample");
    expect(invocation.native).toEqual({ outcome: "passed" });
    expect(invocation.checks).toEqual([]);
    expect(invocation.verified).toBe(false);
  });

  // why: S6. A failing recorded check is `failed` (not `error`), records the claim as failed, and the error is returned so the
  // runner can still fail the test.
  // proves: CLAIM(S6-outcomes) CLAIM(IV5)
  it("a failing check is failed and the error is kept", async () => {
    takeInvocations();
    const result = await callAsync(() => runExample(failing), "runExample");
    expect(result.invocation.native).toEqual({ outcome: "failed", message: "expected 1 to equal 2" });
    expect(result.invocation.checks, "F30c: the failed check also names where it failed").toEqual([{ claim: "F1", passed: false, source: { path: "packages/paneweft-ts/src/examples.test.ts", line: expect.any(Number) } }]);
    expect(result.invocation.verified).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  // why: S6. A thrown non-check is an `error`.
  // proves: CLAIM(S6-outcomes)
  it("a thrown error that is not a check is an error", async () => {
    takeInvocations();
    const { invocation } = await callAsync(() => runExample(throwing), "runExample");
    expect(invocation.native).toEqual({ outcome: "error", message: "boom" });
  });

  // why: S6. A failed child blocks its parent: the parent is `blocked` by the child's invocation id, not `failed`.
  // proves: CLAIM(S6-outcomes) CLAIM(IV7)
  it("a failed child blocks its parent", async () => {
    takeInvocations();
    await callAsync(() => runExample(parent), "runExample");
    const records = takeInvocations();
    const child = byId(records, "subject.throwing");
    expect(child.native.outcome).toBe("error");
    expect(byId(records, "subject.parent").native).toEqual({ outcome: "blocked", blockedBy: child.id });
  });
});

describe("[N4] expectFailure", () => {
  // why: N4 control 1. A matched failure is captured (not propagated as blocked), the dead end passes, the reproduced failure keeps a
  // diagnostic id.
  // proves: CLAIM(N4-expected-failure) CLAIM(S8-dead-end)
  it("passes only when the failure matches", async () => {
    takeInvocations();
    const { invocation, value } = await callAsync(() => runExample(deadEnd), "runExample");
    expect(value).toEqual({ tick: 5 });
    expect(invocation.native).toEqual({ outcome: "passed" });
    expect(invocation.expectedFailure?.matched).toBe(true);
    expect(invocation.expectedFailure?.diagnosticId).toBeTruthy();
  });

  // why: N4 control 2. Unexpected success fails the example: a dead end that no longer fails is a stale claim.
  // proves: CLAIM(N4-expected-failure)
  it("fails on unexpected success", async () => {
    takeInvocations();
    const { invocation } = await callAsync(() => runExample(unexpectedSuccess), "runExample");
    expect(invocation.native.outcome).toBe("failed");
    expect(invocation.native.outcome === "failed" ? invocation.native.message : "").toContain("unexpected success");
  });

  // why: N4 control 3. An unrelated error fails the example and the message shows both the error and the expectation.
  // proves: CLAIM(N4-expected-failure)
  it("fails on an unrelated error", async () => {
    takeInvocations();
    const { invocation } = await callAsync(() => runExample(unrelated), "runExample");
    expect(invocation.native.outcome).toBe("failed");
    const message = invocation.native.outcome === "failed" ? invocation.native.message : "";
    expect(message).toContain("disk full");
    expect(message).toContain("lock held");
  });
});
