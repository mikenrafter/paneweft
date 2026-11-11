// Raw Ajv 2020-12 construction and a $ref walker for the MCP schema-equivalence claim (MC11).
// "Raw" means: built here with the Ajv package itself, not through src/schemas/ajv.ts, so the advertised schemas are
// judged by a validator the code under test did not configure. strict:false only because advertised copies may keep the
// annotation keyword `x-hint`; no behaviour keyword is relaxed.
import * as ajv2020Module from "ajv/dist/2020.js";

type Ajv2020Class = typeof import("ajv/dist/2020.js").default;
type Interop<T> = { default?: T | { default?: T } };

function unwrap<T>(module: unknown): T {
  const first = (module as Interop<T>).default;
  const second = (first as { default?: T } | undefined)?.default;
  return (second ?? first ?? module) as T;
}
const Ajv2020Constructor = unwrap<Ajv2020Class>(ajv2020Module);

export type RawValidate = ((value: unknown) => boolean) & { errors?: unknown };

/** Compiles `schema` in its own Ajv instance; throws a plain Error (a test failure) when the schema does not compile. */
export function compileRaw(schema: Record<string, unknown>): RawValidate {
  const ajv = new Ajv2020Constructor({ strict: false, allErrors: true, allowUnionTypes: true });
  return ajv.compile(schema) as RawValidate;
}

/** Every `$ref` string in a JSON tree, with the JSON pointer of the node holding it. */
export function collectRefs(node: unknown, pointer = ""): Array<{ at: string; ref: string }> {
  if (Array.isArray(node)) return node.flatMap((child, index) => collectRefs(child, `${pointer}/${index}`));
  if (node === null || typeof node !== "object") return [];
  const found: Array<{ at: string; ref: string }> = [];
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string") found.push({ at: pointer, ref: child });
    else found.push(...collectRefs(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return found;
}

/** Resolves a same-document `#...` JSON-pointer reference; undefined when it does not resolve. */
export function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: any = root;
  for (const raw of ref.slice(2).split("/")) {
    const token = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(token in node)) return undefined;
    node = node[token];
  }
  return node;
}

/** The refs of `schema` that are NOT resolvable inside the same document (the definition of "not self-contained"). */
export function unresolvedRefs(schema: unknown): Array<{ at: string; ref: string }> {
  return collectRefs(schema).filter(({ ref }) => resolveLocalRef(schema, ref) === undefined);
}
