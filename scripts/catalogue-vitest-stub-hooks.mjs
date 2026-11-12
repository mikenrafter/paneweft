// The module hooks behind catalogue-vitest-stub.mjs: resolve `vitest` to an inert module and load it from generated source.
const STUB_URL = "paneweft-stub:vitest";

/** The runtime exports of `vitest` (the union of 3.2 and 5.1). A name the repository imports that is not here makes the import fail visibly, as a
 * missing export does, and the failure is reported as a manifest import problem naming this list's file. */
export const VITEST_EXPORTS = ["Snapshots", "TestRunner", "EvaluatedModules", "afterAll", "afterEach", "aroundAll", "aroundEach", "assert", "assertType", "beforeAll", "beforeEach", "bench", "chai", "createExpect", "describe", "expect", "expectTypeOf", "inject", "it", "onTestFailed", "onTestFinished", "recordArtifact", "should", "suite", "test", "vi", "vitest"];

const SOURCE = `
const inert = new Proxy(function inert() {}, {
  get: (_target, key) => (key === "then" || typeof key === "symbol" ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
});
${VITEST_EXPORTS.map((name) => `export const ${name} = inert;`).join("\n")}
`;

export async function resolve(specifier, context, next) {
  if (specifier === "vitest") return { url: STUB_URL, format: "module", shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === STUB_URL) return { format: "module", source: SOURCE, shortCircuit: true };
  return next(url, context);
}
