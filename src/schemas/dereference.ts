// Replaces every `$ref` by its target (urn:paneweft ids and local `#/...` pointers), so an advertised tool schema stands alone.
// Shared by the v0 and v1 tool descriptors of the MCP server.
type Json = any;

export function dereference(schema: Json, documents: Map<string, Json>, root: Json, seen: string[] = []): Json {
  if (Array.isArray(schema)) return schema.map((entry) => dereference(entry, documents, root, seen));
  if (schema === null || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    const [id, fragment = ""] = schema.$ref.split("#");
    const base = id === "" ? root : documents.get(id);
    if (base === undefined) throw new Error(`unresolvable $ref ${schema.$ref}`);
    if (seen.includes(schema.$ref)) throw new Error(`cyclic $ref ${schema.$ref}`);
    let target = base;
    for (const token of fragment.split("/").slice(1)) target = target[token.replace(/~1/g, "/").replace(/~0/g, "~")];
    const { $ref: _ref, ...siblings } = schema;
    return { ...dereference(target, documents, base, [...seen, schema.$ref]), ...dereference(siblings, documents, root, seen) };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) if (key !== "$id" && key !== "$schema" && key !== "$defs") out[key] = dereference(value, documents, root, seen);
  return out;
}
