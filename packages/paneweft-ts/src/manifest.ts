// The explicit import manifest (spec section 2, decision 3). Side-effect registration is acceptable inside the manifest;
// filesystem-wide imports are not discovery. A forgotten import is invisible to the compiler, so `compileCatalogue` takes the list of
// module paths the repository declares and reports any that the manifest does not carry.
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

/** The symbol under which a manifest carries its own catalogue compiler. The host's catalogue export imports the repository's manifest and
 * calls this, so the SDK copy the repository resolved is the one that compiles (no second copy has to be resolvable from the host). */
export const COMPILE = Symbol.for("paneweft.compile");

export function defineManifest(manifest: Manifest): Manifest {
  Object.defineProperty(manifest, COMPILE, { value: (declared?: ReadonlyArray<string>) => compileCatalogue(manifest, declared), enumerable: false });
  return manifest;
}

export type CatalogueProblem = { kind: "duplicate-id" | "missing-import" | "unknown-type"; id: string; sources: Array<{ path: string }> };
export type CatalogueResult = { ok: true; catalogue: Record<string, unknown> } | { ok: false; problems: CatalogueProblem[] };

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Compiles `paneweft.catalogue/1` content (types, views, examples) from the manifest: sorted by id, independent of module order. */
export function compileCatalogue(manifest: Manifest, declaredModules: ReadonlyArray<string> = []): CatalogueResult {
  const problems: CatalogueProblem[] = [];
  const modulePaths = [...manifest.modules.map((module) => module.path)].sort();
  const types = new Map<string, { typeId: string; source: { path: string; symbol: string } }>();
  const views = new Map<string, Array<{ module: string; definition: ViewDefinition<any> }>>();
  const examples = new Map<string, Array<{ module: string; definition: ExampleDefinition<any> }>>();
  for (const module of [...manifest.modules].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    for (const token of module.types ?? []) if (!types.has(token.id)) types.set(token.id, { typeId: token.id, source: { path: token.source.path, symbol: token.source.symbol } });
    for (const definition of module.views ?? []) views.set(definition.id, [...(views.get(definition.id) ?? []), { module: module.path, definition }]);
    for (const definition of module.examples ?? []) examples.set(definition.id, [...(examples.get(definition.id) ?? []), { module: module.path, definition }]);
  }
  for (const [kind, table] of [["view", views], ["example", examples]] as const) {
    for (const [id, entries] of [...table.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (entries.length > 1) problems.push({ kind: "duplicate-id", id, sources: entries.map((entry) => ({ path: entry.module })) });
      void kind;
    }
  }
  const unknown = new Map<string, Set<string>>();
  for (const table of [views, examples] as Array<Map<string, Array<{ module: string; definition: { typeId: string } }>>>) {
    for (const entries of table.values()) for (const entry of entries) if (!types.has(entry.definition.typeId)) unknown.set(entry.definition.typeId, (unknown.get(entry.definition.typeId) ?? new Set<string>()).add(entry.module));
  }
  for (const [typeId, modules] of [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) problems.push({ kind: "unknown-type", id: typeId, sources: [...modules].sort().map((path) => ({ path })) });
  for (const declared of [...declaredModules].sort()) if (!modulePaths.includes(declared)) problems.push({ kind: "missing-import", id: declared, sources: [] });
  if (problems.length > 0) return { ok: false, problems };

  const viewRows = [...views.values()].map(([entry]) => {
    const { module, definition } = entry as { module: string; definition: ViewDefinition<any> };
    return { id: definition.id, typeId: definition.typeId, title: definition.title, question: definition.question, component: definition.component, priority: definition.priority, module, source: { path: module, line: definition.definedAtLine ?? 1 } };
  });
  const exampleRows = [...examples.values()].map(([entry]) => {
    const { module, definition } = entry as { module: string; definition: ExampleDefinition<any> };
    return { id: definition.id, typeId: definition.typeId, claims: [...definition.claims], kind: definition.kind ?? "example", composes: [] as string[], module, source: { path: module, line: definition.definedAtLine ?? 1 }, selector: { runner: "vitest", name: `example:${definition.id}` } };
  });
  return { ok: true, catalogue: { types: [...types.values()].sort((a, b) => (a.typeId < b.typeId ? -1 : 1)), views: viewRows.sort(byId), examples: exampleRows.sort(byId) } };
}
