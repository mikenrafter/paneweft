These packs contain original Git commits, path trees and blobs for the demo
source pins. They let `test/demo-source-pins.test.ts` run `git show` without
network access or sibling checkouts. They contain no refs or full history.

Sources:

- `vigil.pack`: phoe-nix commit `d064373a15139b969599ee05bc7b156b1d5b8ed7`, under `scout-modules/vigil/`.
- `residual-web.pack`: residual-cli commit `32c0836283dad8c22431b3025ec910b4b5759e90`.
- `paneweft.pack`: commits `31aae89198d5f0e1057a87848b38696e9ae155bf` and `2765c525907bda1a95bcc5ecf03a1bf4a93bc7a7`, for `docs/design.md`. The old revision is retained to detect the S3 regression by its hash mismatch.

To refresh a pack, collect each required commit object, its root tree, every
tree along each cited path, and the cited blob using `git rev-parse` in the
original repository. Pass the sorted, unique object IDs to
`git pack-objects --stdout > <repository>.pack`. Keep the original objects;
recreating commits would change the revision being verified.
