// The explicit import manifest (spec section 2, decision 3). Side-effect registration is acceptable inside the manifest;
// filesystem-wide imports are not discovery.
import type { TypeToken, ViewDefinition } from "./capture.ts";
import type { ExampleDefinition } from "./example.ts";

export interface ManifestModule {
  /** Repository-relative path of the module, for the catalogue and the inventory. */
  path: string;
  types?: ReadonlyArray<TypeToken<any>>;
  views?: ReadonlyArray<ViewDefinition<any>>;
  examples?: ReadonlyArray<ExampleDefinition<any>>;
}

export interface Manifest {
  runners: Array<"vitest" | "jest">;
  modules: ReadonlyArray<ManifestModule>;
}

export function defineManifest(manifest: Manifest): Manifest {
  return manifest;
}

export type CatalogueResult =
  | { ok: true; catalogue: Record<string, unknown> }
  | { ok: false; problems: Array<{ kind: "duplicate-id" | "missing-import" | "unknown-type"; id: string; sources: Array<{ path: string }> }> };

/** Compiles `paneweft.catalogue/1` content (types, views, examples) from the manifest. STUB: always reports a problem. */
export function compileCatalogue(manifest: Manifest, declaredModules: ReadonlyArray<string> = []): CatalogueResult {
  return { ok: false, problems: [{ kind: "missing-import", id: "NOT_IMPLEMENTED: compileCatalogue", sources: [] }] };
}
