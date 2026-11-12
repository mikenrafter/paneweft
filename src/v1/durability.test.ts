// WHY CLAIM(S33): rejects file-only fsync followed by rename without syncing the directory entries and newly created ancestors.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { collectionImport, useV1Sessions, fakeCargoAdapter, useFakeQex, loadFixture } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { importCollection } from "./import.ts";
import { createJobService } from "./jobs.ts";
const open = useV1Sessions();
const fake = useFakeQex();
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
async function observe() {
  const events: string[] = [];
  const paths = new WeakMap<object, string>();
  const originalOpen = fs.open;
  const probe = await originalOpen(import.meta.filename);
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = proto.sync;
  vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); paths.set(handle, String(args[0])); return handle;
  }) as typeof fs.open);
  vi.spyOn(proto, "sync").mockImplementation(async function (this: object) {
    events.push(`sync:${paths.get(this)}`); return originalSync.call(this);
  });
  const originalRename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { events.push(`rename:${to}`); return originalRename(from, to); });
  syncBuiltinESMExports();
  return events;
}
it("[S33] syncs every v1 file directory and new ancestors before manifest publication", async () => {
  const { session, dir } = await open();
  const events = await observe();
  must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
  const publish = events.indexOf(`rename:${join(dir, "manifest.json")}`);
  expect(publish).toBeGreaterThan(0);
  for (const directory of [dir, join(dir, "v1"), join(dir, "v1/runs"), join(dir, "v1/runs/run-1"), join(dir, "v1/runs/run-1/captures")]) {
    expect(events.slice(0, publish), `directory ${directory} durable before publication`).toContain(`sync:${directory}`);
  }
  for (const [at, event] of events.entries()) {
    if (!event.startsWith(`rename:${join(dir, "v1")}`)) continue;
    expect(events.slice(at + 1, publish), `renamed file ${event} durable before publication`).toContain(`sync:${dirname(event.slice(7))}`);
  }
});
it("[S33] syncs the intent directory and new job ancestors before collect acknowledges", async () => {
  const { session, dir } = await open(); const qex = fake();
  const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [fakeCargoAdapter()], catalogueFor: async () => loadFixture<any>("v1/catalogues/watchfile.catalogue.json"), crashAt: (p) => { if (p === "after-intent") throw new Error("intent acknowledged"); } });
  const events = await observe();
  await expect(service.collect({ requestId: "durable", repo: "vg", adapter: "cargo", examples: ["watch.pending"] })).rejects.toThrow("intent acknowledged");
  const rename = events.indexOf(`rename:${join(dir, "jobs/durable/intent.json")}`);
  expect(rename).toBeGreaterThan(0);
  expect(events.slice(rename + 1)).toContain(`sync:${join(dir, "jobs/durable")}`);
  for (const directory of [dir, join(dir, "jobs")]) expect(events).toContain(`sync:${directory}`);
});
