import type { TypeToken, ViewDefinition } from "./capture.js";
import type { ExampleDefinition } from "./example.js";
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
/** The symbol under which a manifest carries its own catalogue compiler. The host's catalogue export imports the repository's manifest and
 * calls this, so the SDK copy the repository resolved is the one that compiles (no second copy has to be resolvable from the host). */
export declare const COMPILE: unique symbol;
export declare function defineManifest(manifest: Manifest): Manifest;
export type CatalogueProblem = {
    kind: "duplicate-id" | "missing-import" | "unknown-type";
    id: string;
    sources: Array<{
        path: string;
    }>;
};
export type CatalogueResult = {
    ok: true;
    catalogue: Record<string, unknown>;
} | {
    ok: false;
    problems: CatalogueProblem[];
};
/** Compiles `paneweft.catalogue/1` content (types, views, examples) from the manifest: sorted by id, independent of module order. */
export declare function compileCatalogue(manifest: Manifest, declaredModules?: ReadonlyArray<string>): CatalogueResult;
