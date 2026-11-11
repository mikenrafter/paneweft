// why: S1, the viewer must expose a session's storage error instead of converting a rejected read into INTERNAL.
// proves: CLAIM(session-read-errors) at the HTTP boundary.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bearer, expectErrorBody, rawRequest, useViewers } from "../../test/helpers/wire-http.ts";

const viewers = useViewers();

describe("[S1] viewer reports manifest storage errors", () => {
  for (const [damage, code] of [["malformed", "STORAGE_CORRUPT"], ["read-failure", "STORAGE_FAILED"]] as const) {
    // why: a real request exercises getView and the route's result-to-error response, with a healthy-request control.
    it(`[session-read-errors] /api/view: ${damage} returns ${code}`, async () => {
      const { dir, server } = await viewers.start();
      const request = () => rawRequest(server, "/api/view?viewId=modules&snapshotId=snap-1", { headers: bearer(server.token) });
      expect((await request()).status).toBe(200);
      const manifest = join(dir, "manifest.json");
      if (damage === "malformed") writeFileSync(manifest, "{broken");
      else { unlinkSync(manifest); mkdirSync(manifest); }
      expectErrorBody(await request(), 500, code);
    });
  }
});
