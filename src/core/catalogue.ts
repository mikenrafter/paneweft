// The component catalogue (design section 5: "Store component IDs, schemas,
// example payloads, capabilities, and summary policies in a catalogue").
// Questions are the "Question:" lines of design section 2.
import type { ComponentId } from "../schemas/index.ts";

export interface ComponentEntry {
  readonly id: ComponentId;
  readonly question: string;
  readonly capabilities: readonly string[];
}

export const COMPONENT_CATALOGUE: readonly ComponentEntry[] = [
  { id: "list", question: "What is in this set, and which members matter?", capabilities: ["select", "filter", "sort", "group", "expand-cell", "open-entity"] },
  { id: "tree", question: "How is this entity composed?", capabilities: ["select", "filter", "expand", "focus-subtree", "open-entity"] },
  { id: "graph", question: "What connects these entities, and by which relation?", capabilities: ["select", "filter-relation", "filter-provenance", "focus-neighborhood", "focus-path", "open-entity", "open-evidence"] },
  { id: "source", question: "Which exact code supports this statement?", capabilities: ["focus-annotation", "filter-claims", "expand-bounds", "open-entity", "open-source"] },
  { id: "shape", question: "What does this value or boundary payload contain?", capabilities: ["expand", "filter-presence", "open-entity", "open-source"] },
  { id: "notebook", question: "How do the evidence and views answer this investigation?", capabilities: ["expand-view", "filter-claims", "follow-evidence", "open-entity"] },
  { id: "example", question: "Can I rerun this scenario and inspect its tested result?", capabilities: ["select-run", "filter-assertions", "rerun", "inspect-result"] },
];
