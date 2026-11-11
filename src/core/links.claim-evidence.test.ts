// Review S7: resolveClaimEvidence resolved every {viewId, itemId} target in the notebook's OWN snapshot and ignored the snapshot the
// notebook's `links` name for that view, unlike navigation and embeds (referencedSnapshot). A story page that cites a view of another
// snapshot therefore showed the wrong evidence whenever the ids collided (they do: ids are per view, not per snapshot).
// World: list "shared" in snap-1 and snap-2 with the SAME row id "x" but different content (entity e1 vs e2); notebook "story" lives in snap-2.
// A link to a snapshot that does not exist cannot be stored at all since review S6 (DANGLING_REFERENCE, references.exact-snapshot.test.ts), so
// the "named unresolved result" case of resolveLink stays covered in links.test.ts and is not repeated here.
// proves: CLAIM(links-exact)
import { describe, expect, it } from "vitest";
import { resolveClaimEvidence } from "./links.ts";
import type { Session } from "./session.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleOf, claimBlock, complete, listView, moduleRef, notebookView, row } from "../../test/helpers/ops-views.ts";
import { openOk } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
type Json = any;
const shared = (snapshotId: string, entityId: string): Json =>
  listView({ id: "shared", snapshotId, definitionId: "def-shared", title: "Shared", completeness: complete("fixture"), rows: [row("x", { name: entityId }, { entity: moduleRef(entityId) })] });
const story = (links: Json[]): Json => ({
  ...notebookView({ id: "story", snapshotId: "snap-2", definitionId: "def-story-x", title: "Story", completeness: complete("fixture"), blocks: [claimBlock("c1", "claim", "supported", { supports: [{ viewId: "shared", itemId: "x" }] })] }),
  links,
});
const link = (id: string, snapshotId: string, itemId?: string): Json => ({ id, relation: "cites", snapshotId, viewId: "shared", ...(itemId === undefined ? {} : { itemId }) });
async function evidenceOf(links: Json[]): Promise<Awaited<ReturnType<typeof resolveClaimEvidence>>> {
  const session: Session = await openOk(tmp("claim-evidence"));
  must(await session.importBundle(bundleOf([shared("snap-1", "e1"), shared("snap-2", "e2"), story(links)])));
  return resolveClaimEvidence(session, { viewId: "story", snapshotId: "snap-2" }, "c1");
}

describe("[S7] resolveClaimEvidence addresses the snapshot the notebook's links name", () => {
  it("a view-level link to snap-1 sends the target to snap-1's item x (entity e1), not snap-2's (entity e2)", async () => {
    const [step] = await evidenceOf([link("l1", "snap-1")]);
    expect(step).toMatchObject({ relation: "supports", target: { snapshotId: "snap-1", viewId: "shared", itemId: "x" }, resolution: { status: "resolved", snapshotId: "snap-1", entity: { id: "e1" } } });
  });

  it("an item-level link wins over a view-level link (the rule navigation uses)", async () => {
    const [step] = await evidenceOf([link("l1", "snap-2"), link("l2", "snap-1", "x")]);
    expect(step).toMatchObject({ target: { snapshotId: "snap-1" }, resolution: { status: "resolved", snapshotId: "snap-1", entity: { id: "e1" } } });
  });

  // control: with no link the notebook's own snapshot is meant.
  it("control: without a link the target resolves in the notebook's own snapshot (entity e2)", async () => {
    const [step] = await evidenceOf([]);
    expect(step).toMatchObject({ target: { snapshotId: "snap-2" }, resolution: { status: "resolved", snapshotId: "snap-2", entity: { id: "e2" } } });
  });
});
