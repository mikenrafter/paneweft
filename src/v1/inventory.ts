// The checked-in view inventory: `paneweft.inventory.json` at the adapter root (S15, F27). It lists the stable ids a repository declares, each with the module
// that owns it, so that a removed import or a removed id is noticed. Format: `paneweft.inventory/1 { views: [{ id, module }], examples: [{ id, module, typeId }] }`,
// entries sorted by id. `module` is what the compiled catalogue calls the module: the crate-relative module path for Rust (`watch::paneweft_views`), the
// repository-relative file path for TypeScript (`src/mappings/containerMappings.paneweft.ts`). `paneweft inventory update` writes it from the stored catalogue.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "../core/canonical.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Inventory } from "../generated/v1/Inventory.ts";
import { validateAgainstV1 } from "./schemas.ts";

export const INVENTORY_FILE = "paneweft.inventory.json";

/** The repository's checked-in inventory (S15): absent is fine, present must be a valid inventory. */
export async function loadInventory(root: string): Promise<{ ok: true; value: Inventory | undefined } | { ok: false; message: string }> {
  const text = await readFile(join(root, INVENTORY_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: `${INVENTORY_FILE} is not JSON: ${(cause as Error).message}` };
  }
  const faults = validateAgainstV1("urn:paneweft:schema:v1:inventory:1", parsed);
  return faults.length > 0 ? { ok: false, message: `${INVENTORY_FILE} is not a paneweft.inventory/1 document: ${faults[0]?.pointer} ${faults[0]?.constraint}` } : { ok: true, value: parsed as Inventory };
}

export interface InventoryUpdate {
  inventory: Inventory;
  added: { views: string[]; examples: string[] };
  /** Declared ids whose module or return type the catalogue now names differently; the entry takes the catalogue's values. */
  changed: string[];
  /** Declared ids the catalogue lacks: kept unless `prune`, because dropping them silently would bless the loss the inventory exists to catch. */
  missing: string[];
  pruned: string[];
}

/** The inventory after `catalogue` is accepted: every id of the catalogue listed with the catalogue's module and type, the file's other entries kept (or dropped with `prune`). */
export function updateInventory(catalogue: Catalogue, current: Inventory | undefined, prune: boolean): InventoryUpdate {
  const declared = current ?? { schemaVersion: "paneweft.inventory/1" as const, views: [], examples: [] };
  const added = { views: [] as string[], examples: [] as string[] };
  const changed: string[] = [];
  const missing: string[] = [];
  const views = new Map(declared.views.map((view) => [view.id, view]));
  for (const view of catalogue.views) {
    const entry = { id: view.id, module: view.module ?? view.source.path };
    const known = views.get(view.id);
    if (known === undefined) added.views.push(view.id);
    else if (known.module !== entry.module) changed.push(view.id);
    views.set(view.id, entry);
  }
  const examples = new Map(declared.examples.map((example) => [example.id, example]));
  for (const example of catalogue.examples) {
    const entry = { id: example.id, module: example.module ?? example.source.path, typeId: example.typeId };
    const known = examples.get(example.id);
    if (known === undefined) added.examples.push(example.id);
    else if (known.module !== entry.module || known.typeId !== entry.typeId) changed.push(example.id);
    examples.set(example.id, entry);
  }
  const inCatalogue = { views: new Set(catalogue.views.map((view) => view.id)), examples: new Set(catalogue.examples.map((example) => example.id)) };
  const pruned: string[] = [];
  for (const id of [...views.keys()]) if (!inCatalogue.views.has(id)) { missing.push(id); if (prune) { views.delete(id); pruned.push(id); } }
  for (const id of [...examples.keys()]) if (!inCatalogue.examples.has(id)) { missing.push(id); if (prune) { examples.delete(id); pruned.push(id); } }
  const sorted = <T extends { id: string }>(entries: Iterable<T>): T[] => [...entries].sort((a, b) => compareCodeUnits(a.id, b.id));
  return { inventory: { schemaVersion: "paneweft.inventory/1", views: sorted(views.values()), examples: sorted(examples.values()) }, added, changed, missing, pruned };
}

/** The file text for `inventory`: the indentation of the file it replaces (a tab, else two spaces), the header members on their own lines and one entry per line, so a
 * hand-kept inventory changes by the entries that were added or removed and nothing else. */
export function formatInventory(inventory: Inventory, previous: string | undefined): string {
  const indent = previous !== undefined && /^\t/m.test(previous) ? "\t" : "  ";
  const entries = (list: ReadonlyArray<Record<string, string>>): string => (list.length === 0 ? "[]" : `[\n${list.map((entry) => `${indent}${indent}{ ${Object.entries(entry).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} }`).join(",\n")}\n${indent}]`);
  return `{\n${indent}"schemaVersion": "paneweft.inventory/1",\n${indent}"views": ${entries(inventory.views)},\n${indent}"examples": ${entries(inventory.examples)}\n}\n`;
}
