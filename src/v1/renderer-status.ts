// What the text replies say about renderers (F25): the renderer a custom view needs, the digest of its bytes, and whether the session owner trusts
// them. Nothing here runs a renderer; it reads the trust store and the renderer files under the registered root, like the viewer does before it
// decides between the frame and the fallback. Trusting is the owner's act (`paneweft renderers trust`, CLI only); the replies print the command.
import { join } from "node:path";
import type { SessionReader } from "../core/session.ts";
import type { CustomOverlay } from "./capture.ts";
import { customFile, readJsonFile } from "./read.ts";
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

/** The renderer a catalogued view names, judged against the files under the repository's registered root now. */
export interface CatalogueRenderer {
  id: string;
  /** The digest of the files under the root now; null when they cannot be read. */
  digest: string | null;
  state: "ready" | "untrusted" | "missing-asset";
  message: string;
  /** For an untrusted renderer: the command the session owner runs after reviewing the files. */
  trustCommand?: string;
}

export async function rendererOfCatalogue(session: SessionReader, sessionDir: string, repo: string, id: string): Promise<CatalogueRenderer> {
  const registered = (await session.repositories()).find((candidate) => candidate.id === repo);
  if (registered === undefined) return { id, digest: null, state: "missing-asset", message: `repository "${repo}" has no registered root, so the files of the renderer "${id}" cannot be read: paneweft repo add ${repo}=<dir>` };
  const digested = await digestRenderer(join(registered.root, "renderers"), id);
  if (!digested.ok) return { id, digest: null, state: "missing-asset", message: `the renderer "${id}" is not under ${join(registered.root, "renderers")}: ${digested.error.message}`.slice(0, 400) };
  const digest = digested.value.digest;
  if (await openTrustStore(sessionDir).isTrusted({ repo, id, digest })) return { id, digest, state: "ready", message: "" };
  const trustCommand = `paneweft renderers trust --repo ${repo} --id ${id} --digest ${digest}`;
  return { id, digest, state: "untrusted", message: `the session owner has not trusted these bytes; after reviewing the files the owner runs: ${trustCommand}`, trustCommand };
}
