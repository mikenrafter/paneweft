// Catalogue merge, inventory check and coverage counts (IV3, IV14, IV18).
import { canonicalJson, compareCodeUnits } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { err, ok, type Result } from "../core/errors.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Inventory } from "../generated/v1/Inventory.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";

export interface CataloguePart {
  /** The worker artifact (binary or module) this part came from. */
  source: string;
  types: Catalogue["types"];
  views: Catalogue["views"];
  examples: Catalogue["examples"];
}

type Duplicate = Catalogue["duplicates"][number];
const sourcesOf = (sources: Array<{ path: string; line: number }>): Duplicate["sources"] => sources as Duplicate["sources"];

function byKey<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareCodeUnits(key(a), key(b)));
}

/** Merges parts into one catalogue: sorted by id, duplicates reported with both sources (VALIDATION_FAILED), digest independent of
 * part order. */
export function mergeCatalogue(parts: CataloguePart[], target: Catalogue["target"], linkedScope: string[]): Result<Catalogue> {
  const duplicates: Duplicate[] = [];
  const merge = <T extends { source: { path: string; line: number } }>(kind: "view" | "example", all: Array<T & { id: string }>): Array<T & { id: string }> => {
    const seen = new Map<string, Array<T & { id: string }>>();
    for (const item of all) seen.set(item.id, [...(seen.get(item.id) ?? []), item]);
    const result: Array<T & { id: string }> = [];
    for (const [id, items] of seen) {
      result.push(items[0] as T & { id: string });
      if (items.length > 1) duplicates.push({ id, kind, sources: sourcesOf(items.map((item) => ({ path: item.source.path, line: item.source.line }))) });
    }
    return byKey(result, (item) => item.id);
  };
  const views = merge("view", parts.flatMap((part) => part.views));
  const examples = merge("example", parts.flatMap((part) => part.examples));
  const typeSeen = new Map<string, Catalogue["types"]>();
  for (const type of parts.flatMap((part) => part.types)) typeSeen.set(type.typeId, [...(typeSeen.get(type.typeId) ?? []), type]);
  const types: Catalogue["types"] = [];
  for (const [typeId, items] of typeSeen) {
    types.push(items[0] as Catalogue["types"][number]);
    const distinct = new Set(items.map((item) => `${item.source.path}\0${item.source.symbol}`));
    if (distinct.size > 1) duplicates.push({ id: typeId, kind: "type", sources: sourcesOf(items.map((item) => ({ path: item.source.path, line: 1 }))) });
  }
  if (duplicates.length > 0) {
    const names = duplicates.map((duplicate) => `${duplicate.kind} "${duplicate.id}" at ${duplicate.sources.map((source) => `${source.path}:${source.line}`).join(" and ")}`).join("; ");
    return err("VALIDATION_FAILED", `the catalogue has duplicate declarations: ${names}`, { details: { duplicates: byKey(duplicates, (duplicate) => `${duplicate.kind}\0${duplicate.id}`) } });
  }
  const sortedTypes = byKey(types, (type) => type.typeId);
  const digest = sha256Hex(canonicalJson({ types: sortedTypes, views, examples, target }));
  return ok({ schemaVersion: "paneweft.catalogue/1", digest, target, linkedScope: [...linkedScope], types: sortedTypes, views, examples, duplicates: [] } as Catalogue);
}

export type InventoryProblem =
  | { kind: "removed-view" | "removed-example"; id: string; module: string }
  | { kind: "missing-module"; module: string; ids: string[] }
  | { kind: "unlisted"; id: string; module: string }
  | { kind: "return-type-changed"; id: string; expected: string; actual: string }
  | { kind: "duplicate-id"; id: string };

/** The checked-in inventory against the compiled catalogue. Intentional removal updates the inventory in the same change. */
export function checkInventory(catalogue: Catalogue, inventory: Inventory): { ok: boolean; problems: InventoryProblem[] } {
  const problems: InventoryProblem[] = [];
  const viewIds = new Set(catalogue.views.map((view) => view.id));
  const exampleIds = new Set(catalogue.examples.map((example) => example.id));
  const removed: InventoryProblem[] = [];
  const vanishedByModule = new Map<string, { all: string[]; gone: string[] }>();
  const note = (module: string, id: string, present: boolean): void => {
    const entry = vanishedByModule.get(module) ?? { all: [], gone: [] };
    entry.all.push(id);
    if (!present) entry.gone.push(id);
    vanishedByModule.set(module, entry);
  };
  for (const view of inventory.views) {
    note(view.module, view.id, viewIds.has(view.id));
    if (!viewIds.has(view.id)) removed.push({ kind: "removed-view", id: view.id, module: view.module });
  }
  for (const example of inventory.examples) {
    note(example.module, example.id, exampleIds.has(example.id));
    if (!exampleIds.has(example.id)) removed.push({ kind: "removed-example", id: example.id, module: example.module });
    else {
      const actual = catalogue.examples.find((candidate) => candidate.id === example.id)?.typeId;
      if (actual !== undefined && actual !== example.typeId) problems.push({ kind: "return-type-changed", id: example.id, expected: example.typeId, actual });
    }
  }
  const vanishedModules = new Set<string>();
  for (const [module, { all, gone }] of vanishedByModule) {
    if (gone.length > 0 && gone.length === all.length) {
      vanishedModules.add(module);
      problems.push({ kind: "missing-module", module, ids: [...gone].sort(compareCodeUnits) });
    }
  }
  for (const problem of removed) if (problem.kind !== "missing-module" && !vanishedModules.has((problem as { module: string }).module)) problems.push(problem);
  const listedViews = new Set(inventory.views.map((view) => view.id));
  const listedExamples = new Set(inventory.examples.map((example) => example.id));
  for (const view of catalogue.views) if (!listedViews.has(view.id)) problems.push({ kind: "unlisted", id: view.id, module: view.module ?? "" });
  for (const example of catalogue.examples) if (!listedExamples.has(example.id)) problems.push({ kind: "unlisted", id: example.id, module: example.module ?? "" });
  for (const duplicate of catalogue.duplicates) problems.push({ kind: "duplicate-id", id: duplicate.id });
  return { ok: problems.length === 0, problems };
}

/** declared/linked/exercised/passing are four numbers, never one; a discoverable view with no exercised example is a named gap. */
export interface Coverage {
  declared: number;
  linked: number;
  exercised: number;
  passing: number;
  gaps: Array<{ viewId: string; reason: "no-example" | "never-run" | "not-passing" }>;
}

const RAN: ReadonlyArray<string> = ["passed", "failed", "error", "blocked"];

/** `declared` = view ids in the inventory, `linked` = view ids in the catalogue, `exercised` = views whose type has an example that
 * ran, `passing` = views whose type has a verified passing example. The latest run containing an example decides for it. */
export function coverage(catalogue: Catalogue, inventory: Inventory, runs: TestRun[]): Coverage {
  const latest = new Map<string, TestRun["examples"][number]>();
  for (const run of runs) for (const example of run.examples) latest.set(example.id, example);
  const examplesOfType = new Map<string, string[]>();
  for (const example of catalogue.examples) examplesOfType.set(example.typeId, [...(examplesOfType.get(example.typeId) ?? []), example.id]);
  let exercised = 0;
  let passing = 0;
  const gaps: Coverage["gaps"] = [];
  for (const view of byKey(catalogue.views, (item) => item.id)) {
    const examples = examplesOfType.get(view.typeId) ?? [];
    if (examples.length === 0) {
      gaps.push({ viewId: view.id, reason: "no-example" });
      continue;
    }
    const outcomes = examples.map((id) => latest.get(id)).filter((entry): entry is TestRun["examples"][number] => entry !== undefined && RAN.includes(entry.outcome));
    if (outcomes.length === 0) {
      gaps.push({ viewId: view.id, reason: "never-run" });
      continue;
    }
    exercised += 1;
    if (outcomes.some((entry) => entry.outcome === "passed" && entry.verified)) passing += 1;
    else gaps.push({ viewId: view.id, reason: "not-passing" });
  }
  return { declared: inventory.views.length, linked: catalogue.views.length, exercised, passing, gaps };
}
