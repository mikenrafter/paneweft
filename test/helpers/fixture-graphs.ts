// Every graph view that any committed fixture carries (bundles, single envelopes, run outputs), for the whole-fixture
// layout checks (S6). Walks the fixtures/ tree so that a graph added to any fixture is covered without editing a list.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FIXTURES } from "./fixtures.ts";

export interface FixtureGraph {
  file: string;
  viewId: string;
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
}

function* jsonFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.name.endsWith(".json")) yield path;
  }
}

export function fixtureGraphs(): FixtureGraph[] {
  const found: FixtureGraph[] = [];
  for (const path of jsonFiles(FIXTURES)) {
    let document: any;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    // Also visit HTTP ViewModel.envelope and tool input wrappers. New fixtures must be covered
    // regardless of their transport wrapper; only actual view envelopes count.
    const visit = (node: any): void => {
      if (node === null || typeof node !== "object") return;
      if (node.schemaVersion === "paneweft.view/1" && node.component === "graph" && node.data !== undefined) {
        found.push({ file: relative(FIXTURES, path), viewId: node.id, nodes: node.data.nodes, edges: node.data.edges });
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(document);
  }
  return found;
}
