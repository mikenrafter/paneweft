// WHY CLAIM(S35): rejects hashing assets then reopening them for delivery. Inject different bytes only on the unchecked reopen.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES, loadFixture, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { openTrustStore } from "./renderer.ts";
import { customFile } from "./read.ts";
import { createRendererServing } from "./serve-renderer.ts";
const open = useV1Sessions();
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
it("[S35] serves the buffers whose digest was verified", async () => {
  const { session, dir } = await open();
  const root = join(dir, "repo"); mkdirSync(root);
  cpSync(join(FIXTURES, "renderers"), join(root, "renderers"), { recursive: true });
  must(await session.registerRepository({ id: "cm", root }), "repo");
  const metadata = loadFixture<any>("renderers/DIGESTS.json").renderers["mapping-card"];
  const renderer = { id: "mapping-card", apiVersion: 1, assetDigest: metadata.digest, payloadSchemaDigest: metadata.payloadSchemaDigest };
  must(await openTrustStore(dir).trust({ repo: "cm", id: renderer.id, digest: renderer.assetDigest }), "trust");
  const file = customFile(session, "r", "card"); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ repo: "cm", renderer, payload: { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" }, objects: {} }));
  const bundle = join(root, "renderers/mapping-card/bundle.js");
  const expected = readFileSync(bundle);
  const original = fs.readFile; let reads = 0;
  vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === bundle && ++reads >= 3) return Buffer.from("unchecked malicious bytes");
    return original(...args);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  const serving = createRendererServing({ session, sessionDirectory: dir });
  const frame = (await serving.custom({ snapshotId: "snap-r", viewId: "card" }))?.frame;
  expect(frame).toBeDefined();
  const token = frame!.src.split("/")[3]!;
  const reply = await serving.asset(renderer.assetDigest, token, "bundle.js");
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(expected);
});
