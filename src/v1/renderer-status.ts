// What the text replies say about renderers (F25): the renderer a custom view needs, the digest of its bytes, and whether the session owner trusts
// them. Nothing here runs a renderer; it reads the trust store and the renderer files under the registered root, like the viewer does before it
// decides between the frame and the fallback. Trusting is the owner's act (`paneweft renderers trust`, CLI only); the replies print the command.
import { join } from "node:path";
import type { SessionReader } from "../core/session.ts";
import type { CustomOverlay } from "./capture.ts";
import { customFile, readJsonFile, snapshotOfRun } from "./read.ts";
import { digestRenderer, openTrustStore } from "./renderer.ts";
import { decideRenderer, type CustomRendering } from "./serve-renderer.ts";

/** The custom view `viewId` of `runId`, as the stored result of a collected run: its renderer and whether the viewer would run it. */
export interface StoredRenderer {
  renderer: { id: string; apiVersion: number; assetDigest: string; payloadSchemaDigest: string };
  state: CustomRendering["state"];
  /** Empty when ready; otherwise the reason, including the trust command for an untrusted renderer. */
  message: string;
}

export async function rendererOfStoredView(session: SessionReader & { repositories: SessionReader["repositories"] }, sessionDir: string, runId: string, viewId: string): Promise<StoredRenderer | undefined> {
  const overlay = await readJsonFile<CustomOverlay>(customFile(session, runId, viewId));
  if (overlay === undefined) return undefined;
  const decided = await decideRenderer(session, sessionDir, overlay);
  const { id, apiVersion, assetDigest, payloadSchemaDigest } = overlay.renderer;
  return { renderer: { id, apiVersion, assetDigest, payloadSchemaDigest }, state: decided.state, message: decided.message };
}

/** The renderer a view needs, as `views` reports it. */
export interface ViewRenderer {
  /** null: the view is custom but no collected run holds it, so which renderer it needs is not known. */
  id: string | null;
  /** The digest of the renderer's bytes: the files under the root now (catalogue), or the digest the last capture recorded. */
  digest: string | null;
  state: "ready" | "untrusted" | "changed" | "missing-asset" | "incompatible" | "failed" | "unknown";
  message: string;
  /** For an untrusted renderer: the command the session owner runs after reviewing the files. */
  trustCommand?: string;
  /** Where the renderer's identity came from: the catalogue entry, or the view's last capture. */
  basis: string;
}

/** The renderer a catalogued view names, judged against the files under the repository's registered root now. */
export async function rendererOfCatalogue(session: SessionReader, sessionDir: string, repo: string, id: string): Promise<ViewRenderer> {
  const registered = (await session.repositories()).find((candidate) => candidate.id === repo);
  if (registered === undefined) return { id, digest: null, state: "missing-asset", message: `repository "${repo}" has no registered root, so the files of the renderer "${id}" cannot be read: paneweft repo add ${repo}=<dir>`, basis: "catalogue" };
  const digested = await digestRenderer(join(registered.root, "renderers"), id);
  if (!digested.ok) return { id, digest: null, state: "missing-asset", message: `the renderer "${id}" is not under ${join(registered.root, "renderers")}: ${digested.error.message}`.slice(0, 400), basis: "catalogue" };
  const digest = digested.value.digest;
  if (await openTrustStore(sessionDir).isTrusted({ repo, id, digest })) return { id, digest, state: "ready", message: "", basis: "catalogue" };
  const trustCommand = `paneweft renderers trust --repo ${repo} --id ${id} --digest ${digest}`;
  return { id, digest, state: "untrusted", message: `the session owner has not trusted these bytes; after reviewing the files the owner runs: ${trustCommand}`, trustCommand, basis: "catalogue" };
}

/** The renderer the newest capture of the view definition `viewId` recorded, with the state the viewer would find it in. The TypeScript catalogue cannot name it
 * (the view calls `cx.custom(renderer, ...)` when it runs), so a collected run is the only place it is written down. `runs` are oldest first. */
export async function rendererOfLastCapture(session: SessionReader, sessionDir: string, repo: string, viewId: string, runs: Array<{ runId: string }>): Promise<ViewRenderer> {
  for (const run of [...runs].reverse()) {
    for (const entry of await session.listViewIndex(snapshotOfRun(run.runId))) {
      if (entry.viewDefinitionId !== viewId) continue;
      const stored = await rendererOfStoredView(session, sessionDir, run.runId, entry.viewId);
      if (stored === undefined) continue;
      const trustCommand = stored.state === "untrusted" ? `paneweft renderers trust --repo ${repo} --id ${stored.renderer.id} --digest ${stored.renderer.assetDigest}` : undefined;
      return { id: stored.renderer.id, digest: stored.renderer.assetDigest, state: stored.state, message: stored.message, ...(trustCommand === undefined ? {} : { trustCommand }), basis: `last capture ${run.runId}` };
    }
  }
  return { id: null, digest: null, state: "unknown", message: "the view is custom but no collected run holds it yet, so which renderer it needs is not known: collect an example of its type", basis: "none" };
}
