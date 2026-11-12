// What a collection says about the renderers its custom views declare (F26). A view names its renderer with two digests the author copied into the
// source (`defineRenderer`); nothing compared them with the files, so a renderer edited without updating the source collected silently and the viewer then
// showed `missing-asset`. Here the declared digests are compared with the files under the repository's registered root, and a difference becomes a diagnostic
// that names both values and the command that prints the right ones. Reading only; nothing is run.
import { join } from "node:path";
import type { Diagnostic } from "../generated/v1/ObjectGraph.ts";
import { identifyRenderer } from "./renderer.ts";

interface DeclaredRenderer { id: string; assetDigest: string; payloadSchemaDigest: string; viewId: string }

function declarations(graphs: ReadonlyArray<{ views?: ReadonlyArray<{ viewId?: string; component?: string; completeness?: { status?: string }; data?: unknown }> }>): DeclaredRenderer[] {
  const found = new Map<string, DeclaredRenderer>();
  for (const graph of graphs) {
    for (const view of graph.views ?? []) {
      if (view.component !== "custom" || view.completeness?.status === "unsupported") continue;
      const renderer = (view.data as { renderer?: { id?: unknown; assetDigest?: unknown; payloadSchemaDigest?: unknown } } | undefined)?.renderer;
      if (renderer === undefined || typeof renderer.id !== "string" || typeof renderer.assetDigest !== "string" || typeof renderer.payloadSchemaDigest !== "string") continue;
      found.set(`${renderer.id}\0${renderer.assetDigest}\0${renderer.payloadSchemaDigest}\0${view.viewId ?? ""}`, { id: renderer.id, assetDigest: renderer.assetDigest, payloadSchemaDigest: renderer.payloadSchemaDigest, viewId: view.viewId ?? "" });
    }
  }
  return [...found.values()].sort((a, b) => (a.id + a.viewId < b.id + b.viewId ? -1 : 1));
}

/** Diagnostics (category `renderer`) for every declared renderer whose files under `<repositoryRoot>/renderers/<id>` are absent or hash to other digests.
 * `repositoryRoot` is the root registered for the adapter's repository, the place the viewer looks; without one nothing can be compared. */
export async function rendererDiagnostics(args: { repo: string; repositoryRoot: string | undefined; graphs: Parameters<typeof declarations>[0] }): Promise<Diagnostic[]> {
  if (args.repositoryRoot === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  const digestCommand = (id: string): string => `paneweft renderers digest --repo ${args.repo} --id ${id}`;
  for (const declared of declarations(args.graphs)) {
    const identity = await identifyRenderer(join(args.repositoryRoot, "renderers"), declared.id);
    const base = { category: "renderer" as const, viewId: declared.viewId };
    const id = `diag-renderer-${diagnostics.length + 1}`;
    if (!identity.ok) {
      diagnostics.push({ id, ...base, message: `the view ${declared.viewId} names the renderer "${declared.id}", whose files cannot be read under ${join(args.repositoryRoot, "renderers", declared.id)}: ${identity.error.message}`.slice(0, 1000), invariant: "a custom view's renderer exists under the repository's renderers directory", nextAction: `Create renderers/${declared.id}/ with renderer.json, bundle.js and style.css, or fix the renderer id in the view, then collect again. \`${digestCommand(declared.id)}\` prints the digests to declare.` } as Diagnostic);
      continue;
    }
    const wrong: string[] = [];
    if (identity.value.assetDigest !== declared.assetDigest) wrong.push(`assetDigest is ${declared.assetDigest} but the files hash to ${identity.value.assetDigest}`);
    if (identity.value.payloadSchemaDigest !== declared.payloadSchemaDigest) wrong.push(`payloadSchemaDigest is ${declared.payloadSchemaDigest} but the payload schema hashes to ${identity.value.payloadSchemaDigest}`);
    if (wrong.length === 0) continue;
    diagnostics.push({ id, ...base, message: `the view ${declared.viewId} declares the renderer "${declared.id}" with the wrong digest: ${wrong.join("; ")}. The viewer will show this value as changed since capture, and the owner would be asked to trust bytes the declaration does not name.`.slice(0, 1500), invariant: "a custom view declares the digests of the renderer files it was written against", nextAction: `Run \`${digestCommand(declared.id)}\`, copy assetDigest and payloadSchemaDigest into the renderer declaration (defineRenderer / paneweft::Renderer::new), collect again, then have the owner review the files and run \`paneweft renderers trust --repo ${args.repo} --id ${declared.id} --digest <assetDigest>\`.` } as Diagnostic);
  }
  return diagnostics;
}
