// Custom views in the text replies and in `views` (field test F25). `result` printed `view ... (shape)` and the fallback fields for a view whose
// renderer the owner had not trusted, and `views` listed `mapping.card [custom, priority 20]` without the renderer it needs: nothing an agent could
// read said that a renderer was involved, which one, which bytes, or that the owner has to trust it.
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
import { FIXTURES, collectionImport, loadFixture, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";
import { openTrustStore } from "./renderer.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

const DIGESTS = loadFixture<any>("renderers/DIGESTS.json").renderers["mapping-card"] as { digest: string; payloadSchemaDigest: string };
const renderer = { id: "mapping-card", apiVersion: 1, assetDigest: DIGESTS.digest, payloadSchemaDigest: DIGESTS.payloadSchemaDigest };
const Watch = defineType<{ name: string }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
Watch.view({ id: "watch.status", title: "Status", question: "What state?", priority: 10, component: "shape", render: (watch, view) => view.details().field("name", watch.name).done() });
Watch.view({ id: "watch.card", title: "Card", question: "Which mapping is this?", priority: 20, component: "custom", render: (watch, view) => view.custom(renderer, { originalIndex: 4, containerId: "firefox-container-3", backupName: watch.name }, view.details().field("name", watch.name).done()) });

async function cardWorld() {
  const world = await toolWorld();
  cpSync(join(FIXTURES, "renderers"), join(world.root, "renderers"), { recursive: true });
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1", limits: specLimits() });
  capture.publish({ name: "Work" }, Watch);
  must(await importCollection(world.session, { ...collectionImport("vigil-redelivered"), graphs: [capture.finish().toJSON()] }), "import");
  return world;
}
const TRUST = `paneweft renderers trust --repo vg --id mapping-card --digest ${DIGESTS.digest}`;

describe("[F25] view_result says that a view is custom, which renderer it needs and whether the owner trusts it", () => {
  // why: F25. The reply for `mapping.card` was indistinguishable from a plain shape. It now names the renderer, its API version and digest, the trust
  // state, and the exact command the owner runs; the fallback fields stay (they are the same facts).
  // proves: CLAIM(F25-renderer-in-replies)
  it("an untrusted renderer is named with its digest and the trust command", async () => {
    const { okCall, text } = await cardWorld();
    const { payload } = await okCall("view_result", { run: "run-1", view: "watch.card" });
    expect(payload.details.custom).toMatchObject({ renderer: { id: "mapping-card", apiVersion: 1, assetDigest: DIGESTS.digest, payloadSchemaDigest: DIGESTS.payloadSchemaDigest }, state: "untrusted" });
    expect(payload.details.custom.message).toContain(TRUST);
    const body = (await text("view_result", { run: "run-1", view: "watch.card" })).body;
    expect(body).toContain("custom view: renderer mapping-card (api 1, digest " + DIGESTS.digest + "): untrusted");
    expect(body).toContain(TRUST);
    expect(body).toContain("name: string");
  });

  // why: F25. After the owner trusts the digest the same reply says `ready`; editing a renderer file afterwards makes it `changed` (F26: the value was
  // captured with other bytes than the ones under the root; the field test's `missing-asset` said the files were gone).
  // proves: CLAIM(F25-renderer-in-replies) CLAIM(F26-changed-since-capture)
  it("follows the trust state: ready after trust, changed after an edit", async () => {
    const { okCall, text, dir, root } = await cardWorld();
    must(await openTrustStore(dir).trust({ repo: "vg", id: "mapping-card", digest: DIGESTS.digest }), "trust");
    expect((await okCall("view_result", { run: "run-1", view: "watch.card" })).payload.details.custom).toMatchObject({ state: "ready", message: "" });
    expect((await text("view_result", { run: "run-1", view: "watch.card" })).body).toContain("): ready");
    const style = join(root, "renderers/mapping-card/style.css");
    writeFileSync(style, `${readFileSync(style, "utf8")}\n/* edited */\n`);
    const edited = (await okCall("view_result", { run: "run-1", view: "watch.card" })).payload.details.custom;
    expect(edited.state).toBe("changed");
    expect(edited.message).toMatch(/changed since this value was captured/);
  });

  // why: F25. A view that is not custom says nothing about renderers: the reply of every ordinary view is unchanged.
  // proves: CLAIM(F25-renderer-in-replies)
  it("a plain view carries no custom member", async () => {
    const { okCall, text } = await cardWorld();
    const { payload } = await okCall("view_result", { run: "run-1", view: "watch.status" });
    expect(payload.details.custom).toBeUndefined();
    expect((await text("view_result", { run: "run-1", view: "watch.status" })).body).not.toContain("custom view");
  });
});

describe("[F25] views lists the renderer a custom view needs", () => {
  async function listed() {
    const world = await cardWorld();
    const file = join(world.dir, "catalogues", "vg", "cargo.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.catalogue.views.push({ id: "watch.card", typeId: "vigil::watch::WatchFile", title: "Card", question: "Which mapping is this?", component: "custom", priority: 20, source: { path: "src/watch.rs", line: 40 }, renderer: "mapping-card" });
    mkdirSync(join(world.dir, "catalogues", "vg"), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
    return world;
  }

  // why: F25. `paneweft views` showed `mapping.card [custom, priority 20]` with no renderer; skill step 7 asks the agent to report "renderer trust needs", which no
  // tool exposed. The listing names the renderer, its current digest and the state, and the plain views carry none.
  // proves: CLAIM(F25-renderer-in-views)
  it("names the renderer, its digest and its trust state; plain views have none", async () => {
    const { okCall, text } = await listed();
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    const card = payload.items.find((item: any) => item.id === "watch.card");
    expect(card.rendererStatus).toMatchObject({ id: "mapping-card", digest: DIGESTS.digest, state: "untrusted", trustCommand: TRUST });
    expect(payload.items.filter((item: any) => item.id !== "watch.card").every((item: any) => item.rendererStatus === undefined)).toBe(true);
    const line = (await text("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).body.split("\n").find((l) => l.startsWith("watch.card "));
    expect(line).toContain("renderer=mapping-card");
    expect(line).toContain("untrusted");
    expect(line).toContain(DIGESTS.digest.slice(0, 12));
  });

  // why: F25. Once the owner trusts the digest the listing says ready, so the agent stops reporting a need that is met.
  // proves: CLAIM(F25-renderer-in-views)
  it("says ready after the owner trusted the digest", async () => {
    const { okCall, dir } = await listed();
    must(await openTrustStore(dir).trust({ repo: "vg", id: "mapping-card", digest: DIGESTS.digest }), "trust");
    const { payload } = await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" });
    expect(payload.items.find((item: any) => item.id === "watch.card").rendererStatus).toMatchObject({ state: "ready", digest: DIGESTS.digest });
  });

  // why: F25, field data. The TypeScript catalogue does not know which renderer a custom view uses (`cx.custom(renderer, ...)` names it when the view RUNS), so the catalogued
  // view has no `renderer`: in the field session `paneweft views` showed `mapping.card [custom, priority 20]` with nothing. The renderer then comes from the view's last capture.
  // proves: CLAIM(F25-renderer-in-views)
  it("describes a custom view whose catalogue entry names no renderer by its last capture", async () => {
    const { okCall, text, dir } = await listed();
    const file = join(dir, "catalogues", "vg", "cargo.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    delete record.catalogue.views.find((view: any) => view.id === "watch.card").renderer;
    writeFileSync(file, JSON.stringify(record));
    const card = (await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).payload.items.find((item: any) => item.id === "watch.card");
    expect(card.rendererStatus).toMatchObject({ id: "mapping-card", digest: DIGESTS.digest, state: "untrusted", trustCommand: TRUST, basis: "last capture run-1" });
    const line = (await text("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).body.split("\n").find((l) => l.startsWith("watch.card "));
    expect(line).toContain("renderer=mapping-card");
    expect(line).toContain("untrusted");
  });

  // why: F25. A custom view that no collected run holds yet cannot say which renderer it needs; it says that, instead of saying nothing.
  // proves: CLAIM(F25-renderer-in-views)
  it("says the renderer is unknown when a custom view was never captured", async () => {
    const world = await toolWorld();
    const file = join(world.dir, "catalogues", "vg", "cargo.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.catalogue.views.push({ id: "watch.card", typeId: "vigil::watch::WatchFile", title: "Card", question: "Which mapping is this?", component: "custom", priority: 20, source: { path: "src/watch.rs", line: 40 } });
    writeFileSync(file, JSON.stringify(record));
    const card = (await world.okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).payload.items.find((item: any) => item.id === "watch.card");
    expect(card.rendererStatus).toMatchObject({ id: null, digest: null, state: "unknown" });
    expect(card.rendererStatus.message).toMatch(/no collected run/);
  });

  // why: F25. A renderer the catalogue names but the root does not hold is reported as missing, not silently untrusted.
  // proves: CLAIM(F25-renderer-in-views)
  it("reports a renderer whose files are not under the registered root", async () => {
    const { okCall, root } = await listed();
    const { rmSync } = await import("node:fs");
    rmSync(join(root, "renderers"), { recursive: true });
    const status = (await okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).payload.items.find((item: any) => item.id === "watch.card").rendererStatus;
    expect(status).toMatchObject({ id: "mapping-card", digest: null, state: "missing-asset" });
  });
});
