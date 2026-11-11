# v1 fixtures

Committed, hand-reviewed inputs for the v1 red tests (docs/v1-red-contract.md). Nothing here is generated at test time.

| Path | What it is | Who checks it |
|---|---|---|
| `values.json` | tagged-value cases shared by the Rust and TypeScript SDK tests | `src/v1/schemas.test.ts` validates every expected value against the schema |
| `graphs/*.json` | language-neutral graph scenarios with hand-written expected object records; `hashInput` is the exact text hashed, so `printf %s "$hashInput" \| sha256sum` reproduces `contentHash` (reviewer aid, stripped before comparison) | scaffold test checks hash and schema |
| `collections/*` | literal SDK artifacts (`object-graph.json`, `test-run.json`) for import, navigation and text tests | schema-validated by the scaffold test |
| `outcomes/{cargo,vitest}.scenarios.json` | raw runner results plus worker artifacts and the hand-written expected outcome (S6, N4) | `src/v1/adapters.test.ts` |
| `catalogues/*` | reviewed catalogues and inventory of the watchfile and containmarks fixtures | `src/v1/catalogue.test.ts` |
| `benchmark/*` | the pinned pilot topic. Content exercises the harness and is NOT verified against vigil's source | `src/v1/bench.test.ts` |
| `trails/write-lock.json` | one trail document compared by both SDK builders | both SDK trail tests |
| `bin/qex`, `runners/fake-cargo.mjs` | the fake queue and a fake cargo for deterministic job-lifecycle tests | `src/v1/jobs.test.ts` (and its own existence checks) |

`../renderers/*` are the repo-owned renderer fixtures (mapping card, a hostile probe, a protocol-abuse renderer);
`../renderers/DIGESTS.json` holds their reviewed digests. Regenerating a digest or a hash is a deliberate act: change the input,
re-derive the value with an independent tool, review the diff.
