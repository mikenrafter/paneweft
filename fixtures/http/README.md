# fixtures/http - successful viewer API responses (S7)

Literal JSON bodies of the viewer's read routes and of one notebook write, derived BY HAND from
`fixtures/components/all.bundle.json` and the response shapes in `docs/contract-additions/round2.md` (HTTP-4):

| file | route |
|---|---|
| `index.json` | `GET /api/index` |
| `registry.json` | `GET /api/registry` |
| `entity.{watch,notes,mcp}.json` | `GET /api/entity?...` (`{entity, views: RankOutput}`) |
| `view.{modules,delivery-path,cancellation-notebook}.json` | `GET /api/view?...` (`ViewModel`: `{envelope, freshness, contentHash}`; `contentHash` = sha256 of the canonical JSON of the envelope) |
| `notebook.request.json` | the exact body the browser must POST to `/api/notebooks/cancellation-notebook/revisions` after moving block b1 down (blocks reversed, expectedRevision 1) |
| `notebook.rev2.json`, `view.cancellation-notebook.rev2.json` | the answers after that write |

They exist so the SHIPPED bundle (dist/viewer/app.js) can be run against a plain HTTP server that answers like a correct
viewer server, without the server implementation (see `src/viewer/bundle.test.ts`).
