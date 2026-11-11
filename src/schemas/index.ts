// Loads the canonical JSON Schema documents from disk. Node only.
// The files under src/schemas are the single source of every wire structure
// (design section 5); nothing else in the repo restates them.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAjv, type SchemaValidator } from "./ajv.ts";

export const SCHEMA_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const COMPONENT_IDS = ["list", "tree", "graph", "source", "shape", "notebook", "example"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const TOOL_NAMES = [
  "list_components", "describe_component", "validate", "register_view", "render", "open_entity",
  "navigate", "inspect_view", "search", "notebook_create", "notebook_get", "notebook_update", "example_record",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface SchemaDocument {
  readonly file: string; // path relative to SCHEMA_DIRECTORY
  readonly id: string; // $id
  readonly document: Record<string, unknown>;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIRECTORY, file), "utf8")) as Record<string, unknown>;
}

export function loadSchemaDocuments(): SchemaDocument[] {
  const files = [
    ...readdirSync(SCHEMA_DIRECTORY).filter((name) => name.endsWith(".schema.json")),
    ...readdirSync(join(SCHEMA_DIRECTORY, "components")).map((name) => `components/${name}`),
    ...readdirSync(join(SCHEMA_DIRECTORY, "tools")).map((name) => `tools/${name}`),
  ].sort();
  return files.map((file) => {
    const document = readJson(file);
    return { file, id: String(document.$id), document };
  });
}

export function toolSchemaFile(tool: ToolName): string {
  return `tools/${tool}.schema.json`;
}

export function componentSchemaId(component: ComponentId): string {
  return `urn:paneweft:schema:component:${component}:1`;
}

/** An Ajv instance with every schema document registered. */
export function createSchemaRegistry(): SchemaValidator {
  const ajv = createAjv();
  for (const entry of loadSchemaDocuments()) ajv.addSchema(entry.document);
  return ajv;
}
