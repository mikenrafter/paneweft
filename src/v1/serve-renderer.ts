// What the viewer server needs to host repo-owned renderers (S4, N3): the state of a custom view (trusted? present? compatible?), the
// short-lived capability tokens of its frame, and the three allowlisted assets plus a generated classic-script document.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Session, ViewKey } from "../core/session.ts";
import type { EntityRef } from "../core/wire.ts";
import type { CustomOverlay } from "./capture.ts";
import { customFile, readJsonFile } from "./read.ts";
import { SUPPORTED_RENDERER_API, createCapabilityIssuer, digestRenderer, openTrustStore, validateRendererPayload } from "./renderer.ts";

/** The `custom` member of a view model: everything the browser needs to decide between the frame and the notice. */
export interface CustomRendering {
  state: "ready" | "untrusted" | "missing-asset" | "incompatible" | "failed";
  renderer: { id: string; apiVersion: number; assetDigest: string };
  message: string;
  /** Present when ready. */
  frame?: { src: string; frameId: string; nonce: string; payload: unknown; objects: Record<string, EntityRef> };
}

export interface RendererServing {
  custom(key: ViewKey): Promise<CustomRendering | undefined>;
  asset(digest: string, token: string, file: string): Promise<{ status: number; type: string; body: Buffer | string }>;
}

const TYPES: Record<string, string> = { "index.html": "text/html; charset=utf-8", "bundle.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8" };

/** The frame document: classic scripts only, no inline script, the renderer's own stylesheet. `#card` is the mount point the repo-owned
 * mapping card draws into; other renderers create their own elements under `#root`. */
const INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>renderer</title><link rel="stylesheet" href="style.css"></head><body><main id="root"><svg id="card" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="renderer"></svg></main><script src="bundle.js"></script></body></html>';

/** Whether the viewer would run the renderer of a stored custom view, and if not why not: the one decision the viewer's frame and the text replies
 * (`view_result`) share. Reads the trust store and the renderer files under the registered root; executes nothing. */
export async function decideRenderer(session: Pick<Session, "repositories">, sessionDirectory: string | undefined, overlay: CustomOverlay): Promise<{ state: CustomRendering["state"]; message: string }> {
  const renderer = overlay.renderer;
  const refuse = (state: CustomRendering["state"], message: string): { state: CustomRendering["state"]; message: string } => ({ state, message });
  const trust = sessionDirectory === undefined ? undefined : openTrustStore(sessionDirectory);
  if (trust === undefined || !(await trust.isTrusted({ repo: overlay.repo, id: renderer.id, digest: renderer.assetDigest }))) {
    return refuse("untrusted", `the renderer "${renderer.id}" (digest ${renderer.assetDigest.slice(0, 12)}...) is not trusted: submitted data cannot authorize code. The standard view below shows the same facts. The session owner can review the files and run: paneweft renderers trust --repo ${overlay.repo} --id ${renderer.id} --digest ${renderer.assetDigest}`);
  }
  if (!SUPPORTED_RENDERER_API.includes(renderer.apiVersion)) return refuse("incompatible", `the renderer speaks API ${renderer.apiVersion}; this viewer speaks ${SUPPORTED_RENDERER_API.join(", ")}`);
  const registered = (await session.repositories()).find((candidate) => candidate.id === overlay.repo);
  const digested = registered === undefined ? undefined : await digestRenderer(join(registered.root, "renderers"), renderer.id);
  if (digested === undefined || !digested.ok || digested.value.digest !== renderer.assetDigest) return refuse("missing-asset", `the renderer files of "${renderer.id}" are missing, or changed since they were trusted (expected digest ${renderer.assetDigest.slice(0, 12)}...)`);
  const definition = JSON.parse(digested.value.buffers["renderer.json"]!.toString("utf8")) as { payloadSchema?: unknown };
  const schemaDigest = overlay.renderer.payloadSchemaDigest;
  const problems = definition?.payloadSchema === undefined ? ["renderer.json has no payloadSchema"] : validateRendererPayload({ payloadSchemaDigest: schemaDigest }, overlay.payload, { [schemaDigest]: definition.payloadSchema }).map((issue) => `${issue.pointer}: ${issue.constraint}`);
  if (problems.length > 0) return refuse("failed", `the payload does not satisfy the renderer's registered schema: ${problems.slice(0, 3).join("; ")}`);
  return { state: "ready", message: "" };
}

export function createRendererServing(options: { session: Session; sessionDirectory: string | undefined; now?: () => number }): RendererServing {
  const issuer = createCapabilityIssuer({ now: options.now ?? Date.now, ttlMs: 10 * 60 * 1000 });
  const trust = options.sessionDirectory === undefined ? undefined : openTrustStore(options.sessionDirectory);

  async function rendererRoot(repo: string): Promise<string | undefined> {
    const registered = (await options.session.repositories()).find((candidate) => candidate.id === repo);
    return registered === undefined ? undefined : join(registered.root, "renderers");
  }

  return {
    async custom(key) {
      if (!key.snapshotId.startsWith("snap-")) return undefined;
      const runId = key.snapshotId.slice(5);
      const overlay = await readJsonFile<CustomOverlay>(customFile(options.session, runId, key.viewId));
      if (overlay === undefined) return undefined;
      const renderer = { id: overlay.renderer.id, apiVersion: overlay.renderer.apiVersion, assetDigest: overlay.renderer.assetDigest };
      const decided = await decideRenderer(options.session, options.sessionDirectory, overlay);
      if (decided.state !== "ready") return { state: decided.state, renderer, message: decided.message };
      const frameId = `frame-${randomBytes(6).toString("hex")}`;
      const { token } = issuer.mint({ digest: renderer.assetDigest, frameId });
      return { state: "ready", renderer, message: "", frame: { src: `/renderer/${renderer.assetDigest}/${token}/index.html`, frameId, nonce: randomBytes(16).toString("hex"), payload: overlay.payload, objects: overlay.objects } };
    },

    async asset(digest, token, file) {
      const gone = { status: 404, type: "text/plain; charset=utf-8", body: "not found" };
      if (!/^[0-9a-f]{64}$/.test(digest) || !issuer.verify(token, digest) || !(file in TYPES)) return gone;
      if (file === "index.html") return { status: 200, type: TYPES[file] as string, body: INDEX_HTML };
      for (const entry of (await trust?.list()) ?? []) {
        if (entry.digest !== digest) continue;
        const root = await rendererRoot(entry.repo);
        if (root === undefined) continue;
        const current = await digestRenderer(root, entry.id);
        if (!current.ok || current.value.digest !== digest) continue;
        try {
          return { status: 200, type: TYPES[file] as string, body: current.value.buffers[file] as Buffer };
        } catch {
          return gone;
        }
      }
      return gone;
    },
  };
}
