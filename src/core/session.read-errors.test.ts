// why: S1, snapshot acquisition must preserve the Result-returning session API's storage errors.
// CLAIM(session-read-errors): a damaged manifest returns its storage code without rejecting.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { useOps } from "../../test/helpers/ops-env.ts";
import type { Session } from "./session.ts";

const open = useOps();
const key = { viewId: "modules", snapshotId: "snap-1" };
const readers = {
  getView: (session: Session) => session.getView(key),
  getEntity: (session: Session) => session.getEntity({ repository: "r", kind: "vigil/watch", id: "watch" }, "snap-1"),
  snapshotInfo: (session: Session) => session.snapshotInfo("snap-1"),
  listRuns: (session: Session) => session.listRuns(key),
  recordedRunOutputs: (session: Session) => session.recordedRunOutputs(key),
  notebookGet: (session: Session) => session.notebookGet("cancellation-notebook", undefined, "snap-1"),
};

describe("[S1] session read failures stay Results", () => {
  for (const [damage, code] of [["malformed", "STORAGE_CORRUPT"], ["read-failure", "STORAGE_FAILED"]] as const) {
    for (const [name, read] of Object.entries(readers)) {
      // why: each forwarding method must include acquisition in its error boundary, even when the manifest cannot be read at all.
      it(`[session-read-errors] ${name}: ${damage} returns ${code}`, async () => {
        const { session, dir } = await open(allBundle());
        expect((await read(session)).ok, "healthy manifest control").toBe(true);
        const manifest = join(dir, "manifest.json");
        if (damage === "malformed") writeFileSync(manifest, "{broken");
        else { unlinkSync(manifest); mkdirSync(manifest); } // EISDIR works even when tests run as root.
        await expect(read(session)).resolves.toMatchObject({ ok: false, error: { code, message: expect.stringContaining("manifest") } });
      });
    }
  }
});
