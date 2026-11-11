// why: tier-2 review T5, the viewer half. `/api/index` opened (read, hash-verified, parsed) every stored object of the session on each request just to list
//   the views' ids, titles, components, definitions and entities. Those are in the manifest rows now; the route answers from one manifest read and opens nothing.
//   Added after the fix (the session-level equivalent, session.snapshot-reads.test.ts "listViewIndex reads no object", was red first).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observeFilesystem } from "../../test/helpers/fs-spy.ts";
import { bearer, jsonOf, rawRequest, useViewers } from "../../test/helpers/wire-http.ts";

const viewers = useViewers();

describe("[T5] /api/index lists the views without opening them", () => {
  it("[T5] answers all seven views with their title, component, definition and entity, reading no object", async () => {
    const { dir, server } = await viewers.start();
    const observation = observeFilesystem();
    let reply;
    try {
      reply = await rawRequest(server, "/api/index", { headers: bearer(server.token) });
    } finally {
      observation.stop();
    }
    expect(reply.status).toBe(200);
    const body = jsonOf(reply);
    expect(body.views.map((view: { viewId: string }) => view.viewId).sort()).toEqual(["cancellation-notebook", "check-source", "delivery-path", "layout", "modules", "vigil-one-write", "watch-shape"]);
    expect(body.views.find((view: { viewId: string }) => view.viewId === "modules")).toEqual({
      viewId: "modules", snapshotId: "snap-1", component: "list", title: "Modules", viewDefinitionId: "def-modules", entity: { repository: "r", id: "watch", kind: "vigil/watch" },
    });
    const objects = observation.touching(join(dir, "objects")).filter((call) => /readFile|createReadStream|open$/.test(call.api));
    expect(objects).toEqual([]);
  });
});
