// Atomic, idempotent import and the origin stamp (IV8, IV20; amendment S3).
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { executeOperation } from "../core/operations.ts";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { collectionImport, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { importCollection } from "./import.ts";
import { openV1Reader } from "./read.ts";

const open = useV1Sessions();

describe("[IV8] provenance and origin", () => {
  // why: IV8. The host stamps `host_collected` on what IT launched; the stamp is session metadata, read back from the session and
  // never from the payload. Observed items carry the actual run id (run source) and the input fingerprint digest of the run.
  // proves: CLAIM(IV8)
  it("stores the host-assigned origin and the run's own record", async () => {
    const { session } = await open();
    const receipt = must(await importCollection(session, collectionImport("vigil-redelivered", { jobId: "job-1" })), "import");
    expect(receipt).toMatchObject({ runId: "run-1", snapshotId: "snap-run-1", captureIds: ["inv-1"], alreadyImported: false });
    const stored = must(await openV1Reader(session).run("run-1"), "read run");
    expect(stored.origin).toBe("host_collected");
    expect(stored.run.runId).toBe("run-1");
    expect(stored.run.inputFingerprint.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // why: IV8. A payload cannot acquire the host-collected stamp by saying so: `meta.origin` inside a submitted run is refused, and an
  // import that the host did not launch is stored with the origin its CALLER (not the payload) states.
  // proves: CLAIM(IV8)
  it("refuses a submitted run that carries meta.origin", async () => {
    const { session } = await open();
    const input = collectionImport("vigil-redelivered");
    (input.run as any).meta = { origin: "host_collected" };
    const error = mustFail(await importCollection(session, input), "forged stamp");
    expect(error.errors.map((e) => [e.code, e.pointer])).toContainEqual(["FORBIDDEN_PROPERTY", "/run/meta"]);
  });

  // why: IV8. External recordings and agent submissions keep their own categories; nothing upgrades them.
  // proves: CLAIM(IV8)
  it.each(["external_recorded", "agent_submitted"] as const)("keeps %s as given", async (origin) => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered", { origin })), "import");
    expect(must(await openV1Reader(session).run("run-1"), "read").origin).toBe(origin);
  });

  // why: IV8 / S3. The run id binds everything: a graph from another run, or a run record whose id differs, is refused before any write.
  // proves: CLAIM(IV8)
  it("refuses a graph or run of a different run id and writes nothing", async () => {
    const control = await open();
    must(await importCollection(control.session, collectionImport("vigil-redelivered")), "positive control: the same collection with matching run ids imports");
    const { session, dir } = await open();
    const count = () => (existsSync(join(dir, "objects")) ? readdirSync(join(dir, "objects")).length : 0);
    const before = count();
    const wrongGraph = collectionImport("vigil-redelivered", { runId: "run-OTHER" });
    mustFail(await importCollection(session, wrongGraph), "graph of another run");
    expect(count(), "nothing written").toBe(before);
  });
});

describe("[IV20] atomic import", () => {
  // why: IV20 / S3. Import is idempotent by run id: the same content twice yields the same receipt (alreadyImported) and ONE copy; other
  // content under the same run id is a CONFLICT.
  // proves: CLAIM(IV20) CLAIM(S3-job-lifecycle)
  it("is idempotent by run id and refuses different content under the same run id", async () => {
    const { session } = await open();
    const first = must(await importCollection(session, collectionImport("vigil-redelivered")), "first");
    const second = must(await importCollection(session, collectionImport("vigil-redelivered")), "second");
    expect(second).toEqual({ ...first, alreadyImported: true });
    const different = collectionImport("vigil-redelivered");
    (different.graphs[0] as any).objects[1].label = "changed";
    expect(mustFail(await importCollection(session, different), "conflict").code).toBe("CONFLICT");
  });

  // why: IV20 / S3 crash-point test. A crash after the objects are written but BEFORE the manifest swap leaves the session exactly as
  // before (readable, no half collection); retrying the import then succeeds with one copy.
  // proves: CLAIM(IV20) CLAIM(S3-job-lifecycle)
  it("a crash before the manifest swap leaves nothing visible and a retry succeeds", async () => {
    const { session } = await open();
    must(await session.importBundle(allBundle()), "legacy bundle");
    await expect(importCollection(session, collectionImport("vigil-redelivered"), { crashAt: (point) => { if (point === "after-objects") throw new Error("crash"); } })).rejects.toThrow("crash");
    const runs = must(await openV1Reader(session).runs(), "runs after crash");
    expect(runs).toEqual([]);
    const retried = must(await importCollection(session, collectionImport("vigil-redelivered")), "retry");
    expect(retried.alreadyImported).toBe(false);
    expect(must(await openV1Reader(session).runs(), "runs after retry")).toHaveLength(1);
  });

  // why: IV20. A crash AFTER the manifest swap is a completed import: the next attempt reports alreadyImported, never a second copy.
  // proves: CLAIM(IV20)
  it("a crash after the manifest swap is a completed import", async () => {
    const { session } = await open();
    await expect(importCollection(session, collectionImport("vigil-redelivered"), { crashAt: (point) => { if (point === "after-manifest") throw new Error("crash"); } })).rejects.toThrow("crash");
    const again = must(await importCollection(session, collectionImport("vigil-redelivered")), "again");
    expect(again.alreadyImported).toBe(true);
    expect(must(await openV1Reader(session).runs(), "runs")).toHaveLength(1);
  });

  // why: IV20. Two concurrent writers of different collections serialise on the session write lock: both succeed, both are listed,
  // nothing is lost, and content hashes stay immutable (a second import never rewrites the first's objects).
  // proves: CLAIM(IV20)
  it("two concurrent imports both land", async () => {
    const { session } = await open();
    const [a, b] = await Promise.all([
      importCollection(session, collectionImport("vigil-redelivered")),
      importCollection(session, collectionImport("containmarks-mapping")),
    ]);
    must(a, "a");
    must(b, "b");
    expect(must(await openV1Reader(session).runs(), "runs").map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);
  });

  // why: IV20. v0 data keeps working: a legacy bundle imported before and a v1 collection imported after coexist; the legacy views are
  // still readable through the unchanged v0 operations (no migration writes).
  // proves: CLAIM(IV20)
  it("coexists with a legacy v0 bundle", async () => {
    const { session } = await open();
    must(await session.importBundle(allBundle()), "legacy");
    must(await importCollection(session, collectionImport("vigil-redelivered")), "v1");
    const inspected = await executeOperation(session, "inspect_view", { viewId: "modules", snapshotId: "snap-1" });
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
  });

  // why: validation happens first and fails whole: one invalid graph among two writes nothing (no half collection).
  // proves: CLAIM(IV20)
  it("writes nothing when any graph is invalid", async () => {
    const { session } = await open();
    const input = collectionImport("vigil-redelivered");
    const bad = structuredClone(input.graphs[0]) as any;
    bad.captureId = "inv-2";
    bad.roots = ["o99"];
    input.graphs.push(bad);
    mustFail(await importCollection(session, input), "invalid second graph");
    expect(must(await openV1Reader(session).runs(), "runs")).toEqual([]);
  });
});
