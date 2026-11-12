// The view inventory (field test F27). With `paneweft.inventory.json` present, collecting a NEW example failed the whole job before the run ("is in the
// compiled catalogue but not in paneweft.inventory.json"), yet the skill updates the inventory only after the collect; the file's name, format and module
// naming were written down nowhere, and no command wrote it. A collect now tolerates additions (they are drift the replies report), a removal still stops
// it, `catalogue refresh` stays the strict check, and `paneweft inventory update` writes the file.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { FIXTURES, fakeCargoAdapter, loadFixture, makeRepo, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { createJobService, type JobService } from "./jobs.ts";
import { executeV1Operation } from "./tools.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });
const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
const inventory = loadFixture<any>("v1/catalogues/watchfile.inventory.json");
const request = (requestId: string, examples: string[]) => ({ requestId, repo: "vg", adapter: "cargo", examples });
const settle = async (service: JobService, id: string) => vi.waitFor(async () => { const view = must(await service.status(id), "status"); expect(["succeeded", "failed"], JSON.stringify(view)).toContain(view.state); return view; }, { timeout: 20_000, interval: 50 });

/** A repository that checked in the inventory, and an agent's edit that makes the export declare `watch.fresh` (no inventory entry yet). */
async function authoring() {
  const { session, dir } = await open();
  const root = tmp("inventory-root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  writeFileSync(join(root, "paneweft.inventory.json"), JSON.stringify(inventory));
  const qex = fake();
  const adapter = fakeCargoAdapter({ workspaceRoot: root });
  writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
  const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], cancelWaitMs: 3000 });
  writeFileSync(join(root, "src", "watch_fresh.rs"), "// the new example, implemented\n");
  const base = catalogue.examples.find((example: any) => example.id === "watch.pending");
  const extra = join(dir, "extra.catalogue.json");
  writeFileSync(extra, JSON.stringify({ examples: [{ ...base, id: "watch.fresh", source: { path: "src/watch_fresh.rs", line: 1 }, selector: { ...base.selector, name: "tests::paneweft_example_watch_fresh" } }] }));
  qex.scenario({ catalogueExtra: extra });
  const stored = (): any => JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8"));
  return { session, dir, root, qex, service, stored, context: { session, sessionDir: dir, jobs: service } };
}

describe("[F27] collecting a new example is not blocked by the inventory", () => {
  // why: F27. `inv-1`: `run-inv-1:diag-inventory-1 [registration] "watch.huge" ... is in the compiled catalogue but not in paneweft.inventory.json`; nothing ran and
  // the catalogue was not stored. The skill's order is collect (step 5), update the inventory (step 7): the collect has to run.
  // proves: CLAIM(F27-collect-not-blocked)
  it("a collect of an example the inventory does not list runs it and stores the catalogue", async () => {
    const w = await authoring();
    must(await w.service.collect(request("inv-1", ["watch.fresh"])), "collect");
    const view = await settle(w.service, "inv-1");
    expect(view.state, JSON.stringify(view)).toBe("succeeded");
    expect(w.stored().catalogue.examples.map((example: any) => example.id)).toContain("watch.fresh");
    expect(w.stored().inventory, "the inventory the repository checked in is recorded as it is").toEqual(inventory);
    expect(w.stored().inventoryDrift).toEqual({ unlisted: [{ id: "watch.fresh", module: "watch" }] });
  });

  // why: F27. What the inventory guards is a LOSS (a forgotten import, a removed id); it still stops a collect. The control that the relaxation is only for additions.
  // proves: CLAIM(F27-collect-not-blocked)
  it("a collect still fails when the inventory declares something the export no longer has", async () => {
    const w = await authoring();
    writeFileSync(join(w.root, "paneweft.inventory.json"), JSON.stringify({ ...inventory, views: [...inventory.views, { id: "ghost.view", module: "ghost" }] }));
    must(await w.service.collect(request("inv-2", ["watch.fresh"])), "collect");
    const view = await settle(w.service, "inv-2");
    expect(view.state).toBe("failed");
    expect(JSON.stringify(JSON.parse(readFileSync(join(w.dir, "jobs", "inv-2", "diagnostics.json"), "utf8")))).toContain("ghost");
  });

  // why: F27. `catalogue refresh` is the CHECK ("the inventory matches what compiles"): it keeps failing on an unlisted id, and its next action now names the command.
  // proves: CLAIM(F27-collect-not-blocked)
  it("catalogue refresh still fails on an unlisted id and names the command that fixes it", async () => {
    const w = await authoring();
    must(await w.service.refreshCatalogue({ requestId: "cat-1", repo: "vg", adapter: "cargo" }), "refresh");
    const view = await settle(w.service, "cat-1");
    expect(view.state).toBe("failed");
    const diagnostics = JSON.parse(readFileSync(join(w.dir, "jobs", "cat-1", "diagnostics.json"), "utf8"));
    expect(diagnostics[0].message).toContain("watch.fresh");
    expect(diagnostics[0].nextAction).toContain("paneweft inventory update --repo vg --adapter cargo");
  });

  // why: F27. The drift does not disappear into the stored record: every discovery reply says which ids the inventory lacks and what to run.
  // proves: CLAIM(F27-drift-reported)
  it("discovery replies report the unlisted ids and the command", async () => {
    const w = await authoring();
    must(await w.service.collect(request("inv-3", ["watch.fresh"])), "collect");
    await settle(w.service, "inv-3");
    for (const [tool, args] of [["list_examples", { repo: "vg" }], ["list_types", { repo: "vg" }], ["list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" }]] as const) {
      const outcome = await executeV1Operation(w.context, tool, { ...args, format: "json" });
      expect(outcome.ok, outcome.body.slice(0, 200)).toBe(true);
      const notices = JSON.parse(outcome.body).notices.join("\n");
      expect(notices, tool).toContain("watch.fresh");
      expect(notices, tool).toContain("paneweft.inventory.json");
      expect(notices, tool).toContain("paneweft inventory update --repo vg --adapter cargo");
    }
  });
});

describe("[F27] the update also brings the stored catalogue record in line", () => {
  // why: F27, field data. After `inventory update` the discovery notice kept naming the id until the next collect, because the record still carried the drift it was stored with.
  // The update rewrites the record's inventory and clears the drift.
  // proves: CLAIM(F27-drift-reported)
  it("clears the drift notice and records the new inventory", async () => {
    const w = await authoring();
    must(await w.service.collect(request("inv-4", ["watch.fresh"])), "collect");
    await settle(w.service, "inv-4");
    expect(w.stored().inventoryDrift).toBeDefined();
    await w.session.close();
    const updated = await runCliInProcess(["inventory", "update", "--repo", "vg", "--adapter", "cargo"], { env: { PANEWEFT_SESSION: w.dir } });
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(w.stored().inventoryDrift).toBeUndefined();
    expect(w.stored().inventory.examples.map((example: any) => example.id)).toContain("watch.fresh");
    const listed = await runCliInProcess(["examples", "--repo", "vg", "--format", "json"], { env: { PANEWEFT_SESSION: w.dir } });
    expect(JSON.parse(listed.stdout).notices).toEqual([]);
  });
});

describe("[F27] paneweft inventory update writes the file", () => {
  async function stored() {
    const world = await toolWorld();
    await world.session.close();
    return world;
  }
  const run = (dir: string, ...args: string[]) => runCliInProcess(["inventory", "update", ...args], { env: { PANEWEFT_SESSION: dir } });

  // why: F27. No command generated or updated the file. From the stored catalogue it produces exactly the inventory the fixture catalogue's reviewers wrote by hand
  // (sorted, `module` and `typeId` as the catalogue names them).
  // proves: CLAIM(F27-inventory-command)
  it("creates the inventory from the stored catalogue", async () => {
    const { dir, root } = await stored();
    expect(existsSync(join(root, "paneweft.inventory.json"))).toBe(false);
    const result = await run(dir, "--repo", "vg", "--adapter", "cargo");
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "paneweft.inventory.json"), "utf8"))).toEqual(inventory);
    expect(result.stdout).toContain("added 3 views and 3 examples");
  });

  // why: F27. An update ADDS: an entry the file declares but the catalogue lacks stays (and is reported), because dropping it silently would bless the loss the
  // inventory exists to catch. `--prune` is the reviewed removal.
  // proves: CLAIM(F27-inventory-command)
  it("keeps declared entries that the catalogue lacks unless --prune is given", async () => {
    const { dir, root } = await stored();
    const declared = { ...inventory, views: [...inventory.views, { id: "ghost.view", module: "ghost" }], examples: inventory.examples.filter((example: any) => example.id !== "watch.pending") };
    writeFileSync(join(root, "paneweft.inventory.json"), JSON.stringify(declared));
    const kept = await run(dir, "--repo", "vg", "--adapter", "cargo");
    expect(kept.exitCode, kept.stderr).toBe(0);
    const afterKeep = JSON.parse(readFileSync(join(root, "paneweft.inventory.json"), "utf8"));
    expect(afterKeep.views.map((view: any) => view.id)).toContain("ghost.view");
    expect(afterKeep.examples.map((example: any) => example.id)).toContain("watch.pending");
    expect(kept.stdout).toContain("ghost.view");
    expect(kept.stdout).toContain("--prune");
    const pruned = await run(dir, "--repo", "vg", "--adapter", "cargo", "--prune");
    expect(pruned.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "paneweft.inventory.json"), "utf8"))).toEqual(inventory);
  });

  // why: F27, field data. ContainMarks keeps its inventory by hand: tab-indented, one entry per line. A first `update` that re-formatted the whole file would bury the one
  // added entry in a diff of every line; the file keeps its indent and its one-entry-per-line shape, so the review sees one added line.
  // proves: CLAIM(F27-inventory-command)
  it("keeps the file's indentation and one-entry-per-line shape, so adding an id adds one line", async () => {
    const { dir, root } = await stored();
    const handWritten = [
      "{", '\t"schemaVersion": "paneweft.inventory/1",', '\t"views": [',
      ...inventory.views.map((view: any, index: number) => `\t\t{ "id": "${view.id}", "module": "${view.module}" }${index === inventory.views.length - 1 ? "" : ","}`),
      "\t],", '\t"examples": [',
      ...inventory.examples.filter((example: any) => example.id !== "watch.redelivered").map((example: any, index: number, all: any[]) => `\t\t{ "id": "${example.id}", "module": "${example.module}", "typeId": "${example.typeId}" }${index === all.length - 1 ? "" : ","}`),
      "\t]", "}", "",
    ].join("\n");
    writeFileSync(join(root, "paneweft.inventory.json"), handWritten);
    const result = await run(dir, "--repo", "vg", "--adapter", "cargo");
    expect(result.exitCode, result.stderr).toBe(0);
    const after = readFileSync(join(root, "paneweft.inventory.json"), "utf8");
    const before = new Set(handWritten.split("\n"));
    const added = after.split("\n").filter((line) => !before.has(line));
    expect(added, "only the new entry (and the comma its neighbour gained) differ").toEqual([`\t\t{ "id": "watch.pending", "module": "watch", "typeId": "vigil::watch::WatchFile" },`, `\t\t{ "id": "watch.redelivered", "module": "watch", "typeId": "vigil::watch::WatchFile" }`]);
    expect(JSON.parse(after)).toEqual(inventory);
  });

  // why: F27. Nothing stored, nothing to write: the command says to collect first rather than writing an empty inventory.
  // proves: CLAIM(F27-inventory-command)
  it("refuses when no catalogue is stored for the adapter", async () => {
    const { dir } = await stored();
    rmSync(join(dir, "catalogues", "vg", "cargo.json"));
    const result = await run(dir, "--repo", "vg", "--adapter", "cargo");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/no catalogue is stored|collect/);
  });
});
