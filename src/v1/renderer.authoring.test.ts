// F26: renderer authoring. The field test hand-computed `payloadSchemaDigest` with a script, found that `collect` did not compare the declared `assetDigest`
// with the files (an edited renderer collected silently), and that every edit left the older snapshots saying `missing-asset`. Here: a command prints
// both digests, a collection diagnoses a declaration that does not match the files, and a value captured with other bytes says so in those words.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
import { FIXTURES, collectionImport, loadFixture, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";
import { openTrustStore } from "./renderer.ts";
import { rendererDiagnostics } from "./renderer-check.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

// the reviewed digests of the fixture renderer (fixtures/renderers/DIGESTS.json), computed once by the author tool and checked in: the oracle
const REVIEWED = loadFixture<any>("renderers/DIGESTS.json").renderers["mapping-card"] as { digest: string; payloadSchemaDigest: string };
const declared = { id: "mapping-card", apiVersion: 1, assetDigest: REVIEWED.digest, payloadSchemaDigest: REVIEWED.payloadSchemaDigest };
const Watch = defineType<{ name: string }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
Watch.view({ id: "watch.card", title: "Card", question: "Which mapping is this?", priority: 20, component: "custom", render: (watch, view) => view.custom(declared, { originalIndex: 4, containerId: "firefox-container-3", backupName: watch.name }, view.details().field("name", watch.name).done(), [view.self()]) });

async function cardWorld() {
  const world = await toolWorld();
  cpSync(join(FIXTURES, "renderers"), join(world.root, "renderers"), { recursive: true });
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1", limits: specLimits() });
  capture.publish({ name: "Work" }, Watch);
  const graph = capture.finish().toJSON();
  must(await importCollection(world.session, { ...collectionImport("vigil-redelivered"), graphs: [graph] }), "import");
  return { ...world, graph };
}

describe("[F26] `paneweft renderers digest` prints both digests", () => {
  const run = (dir: string, ...args: string[]) => runCliInProcess(["renderers", "digest", ...args], { env: { PANEWEFT_SESSION: dir } });

  // why: F26. The author computed `payloadSchemaDigest` by hand (sha256 of the canonical JSON of the payload schema, through the SDK under tsx) and `renders list`
  // printed only the asset digest. The expected values are the reviewed ones in fixtures/renderers/DIGESTS.json, not computed by the code under test.
  // proves: CLAIM(F26-digest-command)
  it("prints the asset digest, the payload schema digest and the declaration that names them", async () => {
    const world = await cardWorld();
    await world.session.close();
    const text = await run(world.dir, "--repo", "vg", "--id", "mapping-card");
    expect(text.exitCode, text.stderr + text.stdout).toBe(0);
    expect(text.stdout).toContain(`assetDigest: ${REVIEWED.digest}`);
    expect(text.stdout).toContain(`payloadSchemaDigest: ${REVIEWED.payloadSchemaDigest}`);
    expect(text.stdout).toContain(`defineRenderer({ id: "mapping-card", apiVersion: 1, assetDigest: "${REVIEWED.digest}", payloadSchemaDigest: "${REVIEWED.payloadSchemaDigest}" })`);
    expect(text.stdout).toContain("paneweft::Renderer::<Payload>::new");
    expect(text.stdout).toContain(`paneweft renderers trust --repo vg --id mapping-card --digest ${REVIEWED.digest}`);
    const json = await run(world.dir, "--repo", "vg", "--id", "mapping-card", "--format", "json");
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: "paneweft.renderer-digests/1", repo: "vg", id: "mapping-card", apiVersion: 1, assetDigest: REVIEWED.digest, payloadSchemaDigest: REVIEWED.payloadSchemaDigest, trusted: false });
  });

  // why: F26. A payload schema digest is the digest of the schema only: editing the style or the script moves the asset digest and leaves the payload digest where
  // it was; editing the schema moves both. Pins the two as independent, against an independent sha256 of the canonical (key-sorted) schema.
  // proves: CLAIM(F26-digest-command)
  it("moves the asset digest with any file and the payload digest only with the schema", async () => {
    const world = await cardWorld();
    await world.session.close();
    const style = join(world.root, "renderers/mapping-card/style.css");
    writeFileSync(style, `${readFileSync(style, "utf8")}/* edit */\n`);
    const edited = JSON.parse((await run(world.dir, "--repo", "vg", "--id", "mapping-card", "--format", "json")).stdout);
    expect(edited.assetDigest).not.toBe(REVIEWED.digest);
    expect(edited.payloadSchemaDigest).toBe(REVIEWED.payloadSchemaDigest);
    const definition = join(world.root, "renderers/mapping-card/renderer.json");
    const parsed = JSON.parse(readFileSync(definition, "utf8"));
    parsed.payloadSchema.required = [...parsed.payloadSchema.required, "extra"];
    writeFileSync(definition, JSON.stringify(parsed));
    const sorted = (value: any): any => (Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
    const moved = JSON.parse((await run(world.dir, "--repo", "vg", "--id", "mapping-card", "--format", "json")).stdout);
    expect(moved.payloadSchemaDigest).toBe(createHash("sha256").update(JSON.stringify(sorted(parsed.payloadSchema))).digest("hex"));
    expect(moved.payloadSchemaDigest).not.toBe(REVIEWED.payloadSchemaDigest);
  });

  // why: F26. A missing renderer, or one without a payload schema, is an error that names the file, never a digest of nothing.
  // proves: CLAIM(F26-digest-command)
  it("refuses a renderer that is not there or has no payload schema", async () => {
    const world = await cardWorld();
    await world.session.close();
    expect((await run(world.dir, "--repo", "vg", "--id", "nothing-here")).exitCode).toBe(1);
    writeFileSync(join(world.root, "renderers/mapping-card/renderer.json"), JSON.stringify({ id: "mapping-card", apiVersion: 1 }));
    const bad = await run(world.dir, "--repo", "vg", "--id", "mapping-card");
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain("payloadSchema");
  });
});

describe("[F26] a collection compares the declared digests with the renderer files", () => {
  // why: F26. `cmr-1` (style.css edited, the source still declaring the old digest) succeeded with no diagnostic. The same declaration against unedited files says
  // nothing; against edited files it names the view, both digests and the command that prints the right ones.
  // proves: CLAIM(F26-collect-checks-digest)
  it("is silent for a matching declaration and diagnoses an asset digest that does not match the files", async () => {
    const world = await cardWorld();
    const args = { repo: "vg", repositoryRoot: world.root, graphs: [world.graph] as never };
    expect(await rendererDiagnostics(args)).toEqual([]);
    const style = join(world.root, "renderers/mapping-card/style.css");
    writeFileSync(style, `${readFileSync(style, "utf8")}/* edit */\n`);
    const diagnostics = await rendererDiagnostics(args);
    expect(diagnostics).toHaveLength(1);
    const [only] = diagnostics as any[];
    expect(only).toMatchObject({ category: "renderer", viewId: "inv-1.o1.watch.card".replace("inv-1.o1.", "") });
    expect(only.message).toContain(`assetDigest is ${REVIEWED.digest}`);
    expect(only.message).toMatch(/files hash to [0-9a-f]{64}/);
    expect(only.message).not.toContain("payloadSchemaDigest is");
    expect(only.nextAction).toContain("paneweft renderers digest --repo vg --id mapping-card");
  });

  // why: F26. A declaration with a wrong payload schema digest is the other half of the hand computation; a renderer directory that is not there is its own message.
  // proves: CLAIM(F26-collect-checks-digest)
  it("diagnoses a wrong payload schema digest and a renderer that has no files", async () => {
    const world = await cardWorld();
    const wrongPayload = structuredClone(world.graph) as any;
    wrongPayload.views.find((view: any) => view.component === "custom").data.renderer.payloadSchemaDigest = "f".repeat(64);
    const [payload] = (await rendererDiagnostics({ repo: "vg", repositoryRoot: world.root, graphs: [wrongPayload] })) as any[];
    expect(payload.message).toContain(`payloadSchemaDigest is ${"f".repeat(64)}`);
    expect(payload.message).not.toContain("assetDigest is");
    const unknown = structuredClone(world.graph) as any;
    unknown.views.find((view: any) => view.component === "custom").data.renderer.id = "ghost";
    const [ghost] = (await rendererDiagnostics({ repo: "vg", repositoryRoot: world.root, graphs: [unknown] })) as any[];
    expect(ghost.message).toContain('the renderer "ghost"');
    expect(ghost.message).toContain("renderers/ghost");
    expect(await rendererDiagnostics({ repo: "vg", repositoryRoot: undefined, graphs: [world.graph] as never }), "no registered root, nothing to compare").toEqual([]);
  });
});

describe("[F26] a value captured with other renderer bytes says that the renderer changed since capture", () => {
  // why: F26 policy. Renderer files are NOT stored with the snapshot: trust follows the reviewed bytes of the files that exist now, so a value cannot run bytes it was
  // not captured with. After an edit the value reads `changed` (not `missing-asset`), with the captured and the current digest and the way forward; this holds
  // whether or not the owner has already trusted the new bytes (the field test's order: edit, update the source, recollect, trust).
  // proves: CLAIM(F26-changed-since-capture)
  it("is `changed`, naming both digests and the recollect step, whatever the trust state", async () => {
    const world = await cardWorld();
    must(await openTrustStore(world.dir).trust({ repo: "vg", id: "mapping-card", digest: REVIEWED.digest }), "trust");
    expect((await world.okCall("view_result", { run: "run-1", view: "watch.card" })).payload.details.custom.state).toBe("ready");
    const style = join(world.root, "renderers/mapping-card/style.css");
    writeFileSync(style, `${readFileSync(style, "utf8")}/* edit */\n`);
    const current = JSON.parse((await runCliInProcess(["renderers", "digest", "--repo", "vg", "--id", "mapping-card", "--format", "json"], { env: { PANEWEFT_SESSION: world.dir } })).stdout).assetDigest as string;
    for (const retrusted of [false, true]) {
      if (retrusted) must(await openTrustStore(world.dir).trust({ repo: "vg", id: "mapping-card", digest: current }), "trust the new bytes");
      const custom = (await world.okCall("view_result", { run: "run-1", view: "watch.card" })).payload.details.custom;
      expect(custom.state, `retrusted=${retrusted}`).toBe("changed");
      expect(custom.message).toContain("changed since this value was captured");
      expect(custom.message).toContain(REVIEWED.digest.slice(0, 12));
      expect(custom.message).toContain(current.slice(0, 12));
      expect(custom.message).toContain("Collect the example again");
      expect(custom.message).not.toContain("missing");
    }
    // the stored catalogue declares the custom view, as the compiled one does; without the entry the listing has no item to check
    const file = join(world.dir, "catalogues", "vg", "cargo.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.catalogue.views.push({ id: "watch.card", typeId: "vigil::watch::WatchFile", title: "Card", question: "Which mapping is this?", component: "custom", priority: 20, source: { path: "src/watch.rs", line: 40 }, renderer: "mapping-card" });
    writeFileSync(file, JSON.stringify(stored));
    const views = (await world.okCall("list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" })).payload.items.find((item: any) => item.id === "watch.card");
    expect(views, "the listing carries the view").toBeDefined();
    // the listing judges the renderer the catalogue names by the files that exist now (the loop's last step trusted them), so it says `ready` for the current digest; the value-level `changed` is view_result's
    expect(views.rendererStatus, "the discovery listing agrees with the trust given to the current bytes").toMatchObject({ id: "mapping-card", digest: current, state: "ready" });
  });
});
