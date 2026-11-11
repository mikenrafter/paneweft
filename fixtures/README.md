# Fixtures

Committed, hand-reviewed JSON. Nothing here is generated at test time, and tests must not derive
expected values from these files with the code under test.

- `components/<component>.json` - the design section 2 example payload of each v0 component, wrapped in
  a complete `paneweft.view/1` envelope. Shared ids: snapshot `snap-1`, repository `r`.
- `components/all.bundle.json` - one `paneweft.bundle/1` registering the three entities, seven view
  definitions and the seven views above. `views[i]` must equal the matching component fixture
  (checked in `test/scaffold`).
- `demos/` - the two design section 6 demo sets (vigil in Rust, residual-cli's TypeScript web package)
  and the composed notebook; see `demos/README.md`.
- `runners/` - tiny independent runner scripts for the example tests (MC17).

The sha256 `5891b5b5...be03` used in component fixtures is `sha256("hello\n")`.
