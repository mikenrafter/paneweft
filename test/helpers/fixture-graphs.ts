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
    const views: any[] =
      document?.schemaVersion === "paneweft.bundle/1" ? document.views
        : document?.schemaVersion === "paneweft.view/1" ? [document]
          : Array.isArray(document?.bundle?.views) ? document.bundle.views : [];
    for (const view of views) {
      if (view?.component === "graph" && view.data !== undefined) {
        found.push({ file: relative(FIXTURES, path), viewId: view.id, nodes: view.data.nodes, edges: view.data.edges });
      }
    }
  }
  return found;
}
