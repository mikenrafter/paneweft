// Decision trails (S8): the contract, validation and lowering to existing notebook blocks.
import { describe, expect, it } from "vitest";
import { createV1SchemaRegistry } from "./schemas.ts";
import { loadFixture } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { lowerTrail, validateTrail } from "./trail.ts";
import { componentSchemaId } from "../schemas/index.ts";

const lock = () => structuredClone(loadFixture<any>("v1/trails/write-lock.json"));
const context = { trailSourceId: "trail", sourceIds: { "docs/contract-additions/store.md": "s-store" }, knownExamples: ["lock.userspace-recovery"] };

describe("[S8] validation", () => {
  // why: the reviewed lock trail is a valid trail (positive control for every refusal below).
  // proves: CLAIM(S8-trail-contract)
  it("accepts the lock trail", () => {
    expect(must(validateTrail(lock(), context), "valid").entries).toHaveLength(1);
  });

  // why: S8. Each rule is an error with a pointer: order, unique option ids, at most one chosen, superseded names its successor,
  // supersession names an EARLIER entry, no supersession cycle, a dead end names an example that exists, abandoned options keep a reason.
  // proves: CLAIM(S8-trail-contract)
  it.each<[string, (t: any) => void, string]>([
    ["entry orders that do not increase", (t) => void t.entries.push({ ...t.entries[0], id: "e2", order: 1 }), "/entries/1/order"],
    ["duplicate option ids", (t) => void t.entries[0].options.push({ ...t.entries[0].options[0] }), "/entries/0/options/2/id"],
    ["two chosen options", (t) => void (t.entries[0].options[0].status = "chosen"), "/entries/0/options/1/status"],
    ["a superseded option without supersededBy", (t) => void (t.entries[0].options[0].status = "superseded"), "/entries/0/options/0/supersededBy"],
    ["supersession of an unknown entry", (t) => void t.entries.push({ ...t.entries[0], id: "e2", order: 2, supersedes: "e9" }), "/entries/1/supersedes"],
    ["supersession of a LATER entry", (t) => { t.entries[0].supersedes = "e2"; t.entries.push({ ...t.entries[0], id: "e2", order: 2, supersedes: undefined }); }, "/entries/0/supersedes"],
    ["a dead end example that does not exist", (t) => void (t.entries[0].deadEndExample = "lock.nope"), "/entries/0/deadEndExample"],
    ["an abandoned option with no reason", (t) => void (t.entries[0].options[0].reason = ""), "/entries/0/options/0/reason"],
  ])("refuses %s", (_name, mutate, pointer) => {
    const trail = lock();
    mutate(trail);
    const error = mustFail(validateTrail(trail, context), "refused");
    expect(error.errors.map((e) => e.pointer)).toContain(pointer);
  });
});

describe("[S8] lowering", () => {
  // why: S8. A trail lowers to the EXISTING notebook component, in entry order, deterministically: per entry a prose question block,
  // one claim per option (status word in the statement; supported when it cites evidence, open otherwise), a prose decision block, and
  // an example block for a dead end. Written by hand from docs/v1-red-contract.md section 12.
  // proves: CLAIM(S8-trail-contract) CLAIM(S8-dead-end)
  it("lowers the lock trail to the literal blocks", () => {
    const lowered = must(lowerTrail(lock(), context), "lower");
    expect(lowered.blocks).toEqual([
      { id: "e1-question", kind: "prose", markdown: "**How should writers exclude each other?**", provenance: "read", evidence: ["trail"] },
      { id: "e1-option-userspace", kind: "claim", statement: "[failed] userspace: three rounds of recovery protocol still had a crash window", status: "supported", supports: ["s-store"], contradicts: [], provenance: "read", evidence: ["s-store"] },
      { id: "e1-option-flock", kind: "claim", statement: "[chosen] flock: the kernel releases the lock when the holder exits", status: "open", supports: [], contradicts: [], provenance: "read", evidence: ["trail"] },
      { id: "e1-decision", kind: "prose", markdown: "**Decision:** Use flock(1) through a helper process.", provenance: "read", evidence: ["trail"] },
      { id: "e1-dead-end", kind: "example", exampleId: "lock.userspace-recovery", provenance: "read", evidence: ["trail"] },
    ]);
  });

  // why: the lowered blocks are a valid notebook component: the existing schema accepts them (so the existing renderer shows them).
  // proves: CLAIM(S8-trail-contract)
  it("produces data the notebook schema accepts", () => {
    const lowered = must(lowerTrail(lock(), context), "lower");
    const validate = createV1SchemaRegistry().getSchema(componentSchemaId("notebook"))!;
    expect(validate(lowered), JSON.stringify(validate.errors)).toBe(true);
  });

  // why: S8 supersession: the superseded entry's blocks stay (history is not deleted) and say so; entries lower in order.
  // proves: CLAIM(S8-trail-contract)
  it("keeps a superseded entry visible and marks it", () => {
    const trail = lock();
    trail.entries.push({ id: "e2", order: 2, question: "Is flock(1) enough?", options: [{ id: "flock", status: "chosen", reason: "yes", evidence: [] }], decision: "Keep it.", links: [], supersedes: "e1" });
    const blocks = must(lowerTrail(trail, context), "lower").blocks;
    expect(blocks.map((b) => b.id)).toEqual(["e1-question", "e1-option-userspace", "e1-option-flock", "e1-decision", "e1-dead-end", "e2-question", "e2-option-flock", "e2-decision"]);
    expect(blocks.find((b) => b.id === "e1-decision")!.markdown).toContain("superseded by e2");
  });
});

describe("[S20] links survive lowering", () => {
  const withLinks = () => {
    const trail = lock();
    trail.entries[0].links = [
      { kind: "view", id: "lock.state", snapshotId: "snap-run-7" },
      { kind: "source", id: "src/lock.rs", snapshotId: "snap-run-7", anchor: { repository: "vg", path: "src/lock.rs", lines: [10, 20] } },
      { kind: "example", id: "lock.userspace-recovery", snapshotId: "snap-run-8" },
      { kind: "type", id: "vigil::lock::Lock", snapshotId: "snap-run-7" },
    ];
    return trail;
  };

  // why: S20. lowerTrail read an entry's decision, options and dead end and dropped `entry.links`, so a trail that pointed at the view, source, example and
  // type behind a decision lowered to a notebook with no pointer to any of them. One block per link follows its decision, in order, naming the kind, the target and the
  // SNAPSHOT it was bound to (two links of one entry may belong to different snapshots); a source link keeps its anchor. Rejects a lowering that never reads `links`.
  // proves: CLAIM(S20-trail-links) CLAIM(S8-trail-contract)
  it("lowers every link to a block that keeps its kind, target, snapshot and anchor", () => {
    const blocks = must(lowerTrail(withLinks(), context), "lower").blocks;
    expect(blocks.map((b) => b.id)).toEqual(["e1-question", "e1-option-userspace", "e1-option-flock", "e1-decision", "e1-link-1", "e1-link-2", "e1-link-3", "e1-link-4", "e1-dead-end"]);
    expect(blocks.filter((b) => String(b.id).includes("-link-"))).toEqual([
      { id: "e1-link-1", kind: "prose", markdown: "Link (view): `lock.state` in snapshot `snap-run-7`", provenance: "read", evidence: ["trail"] },
      { id: "e1-link-2", kind: "prose", markdown: "Link (source): `src/lock.rs` in snapshot `snap-run-7`", anchor: { repository: "vg", path: "src/lock.rs", lines: [10, 20] }, provenance: "read", evidence: ["trail"] },
      { id: "e1-link-3", kind: "prose", markdown: "Link (example): `lock.userspace-recovery` in snapshot `snap-run-8`", provenance: "read", evidence: ["trail"] },
      { id: "e1-link-4", kind: "prose", markdown: "Link (type): `vigil::lock::Lock` in snapshot `snap-run-7`", provenance: "read", evidence: ["trail"] },
    ]);
  });

  // why: S20. The lowered blocks with links are still a valid notebook component.
  // proves: CLAIM(S20-trail-links)
  it("keeps the notebook schema satisfied", () => {
    const lowered = must(lowerTrail(withLinks(), context), "lower");
    const validate = createV1SchemaRegistry().getSchema(componentSchemaId("notebook"))!;
    expect(validate(lowered), JSON.stringify(validate.errors)).toBe(true);
  });
});
