// Ajv configuration for every paneweft schema (design section 5).
// CLAIM(ajv-strict): schemas compile under Ajv's 2020-12 class with strict mode
// on [ajv.js.org/json-schema; test/scaffold/schemas.scaffold.test.ts].
// Options that are deliberate, not accidents:
//   allowUnionTypes  - Scalar is a union type by design.
//   allErrors        - repair hints want every fault of a payload, not the first.
//   strictRequired   - off: `required` inside if/then branches names properties declared by the
//                      enclosing schema, which is how the provenance and completeness variants are written.
//   x-hint           - a string annotation keyword carrying a repair hint.
import * as ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

type Ajv2020Class = typeof import("ajv/dist/2020.js").default;
type AddFormats = typeof import("ajv-formats").default;
type Interop<T> = { default?: T | { default?: T } };

function unwrap<T>(module: unknown): T {
  const first = (module as Interop<T>).default;
  const second = (first as { default?: T } | undefined)?.default;
  return (second ?? first ?? module) as T;
}

const Ajv2020Constructor = unwrap<Ajv2020Class>(ajv2020Module);
const addFormats = unwrap<AddFormats>(addFormatsModule);

export type SchemaValidator = InstanceType<Ajv2020Class>;

export function createAjv(options: { verbose?: boolean } = {}): SchemaValidator {
  const ajv = new Ajv2020Constructor({
    strict: true,
    // verbose keeps `parentSchema` on every error: the validator reads `x-hint` and the declared properties from it.
    verbose: options.verbose ?? false,
    allErrors: true,
    allowUnionTypes: true,
    strictRequired: false,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-hint", schemaType: "string" });
  return ajv;
}
