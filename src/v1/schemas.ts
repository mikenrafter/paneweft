// Loader for the v1 schemas (src/schemas/v1). Kept apart from src/schemas/index.ts so the v0 tool surface (thirteen tools,
// tests that pin it) is untouched until green wires the new tools in (docs/v1-red-contract.md section 1).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAjv, type SchemaValidator } from "../schemas/ajv.ts";
import { loadSchemaDocuments, type SchemaDocument } from "../schemas/index.ts";
import type { ValidationIssue } from "../core/errors.ts";

export const V1_SCHEMA_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "v1");

/** Pinned by name on purpose: emptying or renaming this list must break tests. `scaffold_example` is optional in week one. */
export const V1_TOOL_NAMES = ["list_types", "list_views_for_type", "list_examples", "scaffold_view", "scaffold_example", "collect", "collection_status", "cancel_collection", "view_result", "explain_failure"] as const;
export type V1ToolName = (typeof V1_TOOL_NAMES)[number];
export const V1_REQUIRED_TOOL_NAMES = V1_TOOL_NAMES.filter((name) => name !== "scaffold_example");

/** Tools that read the catalogue or the session and never execute code. */
export const V1_READ_ONLY_TOOLS = ["list_types", "list_views_for_type", "list_examples", "scaffold_view", "scaffold_example", "collection_status", "view_result", "explain_failure"] as const;
/** The only tools that act: collect executes repository code; cancel stops a job. */
export const V1_ACTING_TOOLS = ["collect", "cancel_collection"] as const;

export function loadV1SchemaDocuments(): SchemaDocument[] {
  const files = [...readdirSync(V1_SCHEMA_DIRECTORY).filter((n) => n.endsWith(".schema.json")), ...readdirSync(join(V1_SCHEMA_DIRECTORY, "tools")).map((n) => `tools/${n}`)].sort();
  return files.map((file) => {
    const document = JSON.parse(readFileSync(join(V1_SCHEMA_DIRECTORY, file), "utf8")) as Record<string, unknown>;
    return { file: `v1/${file}`, id: String(document.$id), document };
  });
}

/** Ajv with the v0 and v1 documents registered. */
export function createV1SchemaRegistry(): SchemaValidator {
  const ajv = createAjv();
  for (const entry of [...loadSchemaDocuments(), ...loadV1SchemaDocuments()]) ajv.addSchema(entry.document);
  return ajv;
}

/** Validates `value` against the v1 schema with `$id` `id`; the issues carry the instance pointer. */
export function validateAgainstV1(id: string, value: unknown): ValidationIssue[] {
  const ajv = createV1SchemaRegistry();
  const validate = ajv.getSchema(id);
  if (validate === undefined) throw new Error(`unknown schema ${id}`);
  if (validate(value) as boolean) return [];
  return (validate.errors ?? []).map((error) => ({ code: "CONSTRAINT" as const, pointer: error.instancePath, constraint: `${error.keyword}: ${error.message ?? ""}`, hint: "See the schema." }));
}
