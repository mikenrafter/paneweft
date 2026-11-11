// T9 (tier-2 review): the viewer URL carries the session token in the fragment (#token=...). The fragment is never sent to a server, but it stays in
// the address bar, the history entry and a copied link. The app reads it, then strips it with history.replaceState, before its first await, so the
// token is held in memory only; the other fragment parameters (view, snapshot) stay. Run through the SHIPPED bundle in JSDOM over a real server.
// proves: CLAIM(session-credential)
import { describe, expect, it } from "vitest";
import { useViewerDom } from "../../test/helpers/viewer-dom.ts";
import { useViewers } from "../../test/helpers/wire-http.ts";

const viewers = useViewers();
const openPage = useViewerDom();

describe("the token leaves location.hash", () => {
  // why: stripped synchronously (before any request resolves), so even a viewer that fails to load does not leave the token in the address bar.
  it("right after the bundle boots, location.hash has no token but keeps view and snapshot", async () => {
    const { server } = await viewers.start();
    const page = openPage(server, "modules", "snap-1");
    expect(page.window.location.hash).toBe("#view=modules&snapshot=snap-1");
    expect(page.window.location.href).not.toContain(server.token);
    await page.settled(() => expect(page.text(page.window.document.getElementById("root")), "the viewer still loads with its in-memory token").toContain("mcp.rs"));
    expect(page.window.location.href).not.toContain(server.token);
  });

  // why: the token must still authenticate every API call after the strip (it is held in memory); a stripped-but-unusable token would show up
  //   as an error text instead of the module list. Also no history entry was added by the strip (replace, not push).
  it("the page still loads authenticated and the strip replaced the history entry instead of adding one", async () => {
    const { server } = await viewers.start();
    const page = openPage(server, "modules", "snap-1");
    expect(page.window.history.length).toBe(1);
    await page.settled(() => expect(page.pw("cell").length).toBeGreaterThan(0));
    expect(page.text(page.window.document.getElementById("root"))).not.toMatch(/UNAUTHORIZED/);
  });
});
