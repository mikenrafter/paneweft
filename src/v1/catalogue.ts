// Catalogue merge, inventory check and coverage counts (IV3, IV14, IV18).
import type { Result } from "../core/errors.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";
import type { Inventory } from "../generated/v1/Inventory.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { notImplemented } from "./stub.ts";

export interface CataloguePart {
  /** The worker artifact (binary or module) this part came from. */
  source: string;
  types: Catalogue["types"];
  views: Catalogue["views"];
  examples: Catalogue["examples"];
}

/** Merges parts into one catalogue: sorted by id, duplicates reported with both sources (VALIDATION_FAILED), digest independent of
 * part order. STUB. */
export function mergeCatalogue(parts: CataloguePart[], target: Catalogue["target"], linkedScope: string[]): Result<Catalogue> {
  return notImplemented("mergeCatalogue");
}

export type InventoryProblem =
  | { kind: "removed-view" | "removed-example"; id: string; module: string }
  | { kind: "missing-module"; module: string; ids: string[] }
  | { kind: "unlisted"; id: string; module: string }
  | { kind: "return-type-changed"; id: string; expected: string; actual: string }
  | { kind: "duplicate-id"; id: string };

/** The checked-in inventory against the compiled catalogue. Intentional removal updates the inventory in the same change. STUB. */
export function checkInventory(catalogue: Catalogue, inventory: Inventory): { ok: boolean; problems: InventoryProblem[] } {
  return { ok: true, problems: [] };
}

/** declared/linked/exercised/passing are four numbers, never one; a discoverable view with no exercised example is a named gap. */
export interface Coverage {
  declared: number;
  linked: number;
  exercised: number;
  passing: number;
  gaps: Array<{ viewId: string; reason: "no-example" | "never-run" | "not-passing" }>;
}

/** `declared` = ids in the inventory, `linked` = ids in the catalogue, `exercised` = views whose type has an example that ran,
 * `passing` = views whose type has a verified passing example. STUB. */
export function coverage(catalogue: Catalogue, inventory: Inventory, runs: TestRun[]): Coverage {
  return { declared: 0, linked: 0, exercised: 0, passing: 0, gaps: [] };
}
