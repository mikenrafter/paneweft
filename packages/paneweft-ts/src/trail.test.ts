import { describe, expect, it } from "vitest";
import { trail } from "./index.ts";
import { call, loadFixture } from "../test/support.ts";

describe("[S8] trail builder", () => {
  // why: S8. Same story as the Rust builder test, compared with the SAME literal document (fixtures/v1/trails/write-lock.json), so the
  // two SDKs cannot drift: an abandoned option stays visible with its reason; a dead end links to its runnable example.
  // proves: CLAIM(S8-trail-contract)
  it("produces the literal trail document", () => {
    const built = trail("write-lock", "Why a kernel flock").entry({
      id: "e1",
      order: 1,
      question: "How should writers exclude each other?",
      options: [
        { id: "userspace", status: "failed", reason: "three rounds of recovery protocol still had a crash window", evidence: [{ provenance: "read", source: "docs/contract-additions/store.md" }] },
        { id: "flock", status: "chosen", reason: "the kernel releases the lock when the holder exits", evidence: [] },
      ],
      decision: "Use flock(1) through a helper process.",
      links: [],
      deadEndExample: "lock.userspace-recovery",
    });
    expect(call(() => built.toJSON(), "toJSON")).toEqual(loadFixture("v1/trails/write-lock.json"));
  });

  // why: S8. Supersession is explicit by id.
  // proves: CLAIM(S8-trail-contract)
  it("records supersession by explicit entry id", () => {
    const built = trail("t", "T")
      .entry({ id: "e1", order: 1, question: "first?", options: [{ id: "a", status: "chosen", reason: "r" }], decision: "a" })
      .entry({ id: "e2", order: 2, question: "again?", options: [{ id: "b", status: "chosen", reason: "r2" }], decision: "b", supersedes: "e1" });
    const json = call(() => built.toJSON(), "toJSON") as any;
    expect(json, "a trail document").not.toBeNull();
    expect(json.entries[1].supersedes).toBe("e1");
    expect(json.entries[0].supersedes).toBeUndefined();
  });
});

describe("[S20] trail links in the TypeScript builder", () => {
  // why: S20. The TypeScript builder passes links through; this pins that a source link's anchor and each link's snapshot are kept, the same document the Rust builder writes.
  // proves: CLAIM(S20-trail-links)
  it("keeps a source link's anchor and every link's snapshot", () => {
    const json = trail("t", "T").entry({
      id: "e1", order: 1, question: "q?", options: [{ id: "a", status: "chosen", reason: "r" }], decision: "a",
      links: [{ kind: "view", id: "lock.state", snapshotId: "snap-run-7" }, { kind: "source", id: "src/lock.rs", snapshotId: "snap-run-7", anchor: { repository: "vg", path: "src/lock.rs", lines: [10, 20] } }],
    }).toJSON() as any;
    expect(json.entries[0].links).toEqual([{ kind: "view", id: "lock.state", snapshotId: "snap-run-7" }, { kind: "source", id: "src/lock.rs", snapshotId: "snap-run-7", anchor: { repository: "vg", path: "src/lock.rs", lines: [10, 20] } }]);
  });
});
