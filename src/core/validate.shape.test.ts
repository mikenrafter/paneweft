// MC1: envelope-level schema shape of validateSubmission (required fields, enums, anchors, unknown
// properties, schema versions, hash/time/pattern faults, completeness variants, item variants).
// Component-specific negatives live in validate.components.test.ts.
//
// Expectations are derived by hand from docs/design.md sections 2 and 4 and docs/red-contract.md section 2
// (code and pointer per fault; one fault -> one issue; issues sorted by (pointer, code)). Every negative is
// built from a committed fixture with patch() so it differs from a valid document by exactly one fault.
import { describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { V0_COMPONENTS, allBundle, clone, componentFixture } from "../../test/helpers/fixtures.ts";
import { patch, type PatchOp } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected, expectTokens, type Expected } from "../../test/helpers/val-check.ts";
import { runSource } from "../../test/helpers/val-fixtures.ts";

const list = () => componentFixture("list");
const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");

describe("[MC1] positive controls", () => {
  // why: a validator that rejects everything would satisfy every negative test; each shipped fixture must pass.
  // proves: CLAIM(MC1) positive control accepts a literal valid fixture (design section 7, MC1)
  it.each([...V0_COMPONENTS])("[MC1] the %s fixture is accepted as an envelope", (component) => {
    expectAccepted(check(componentFixture(component)), "envelope");
  });

  // why: the bundle fixture registers all seven views; it must be accepted as kind "bundle".
  // proves: CLAIM(MC1)
  it("[MC1] the all-components bundle fixture is accepted as a bundle", () => {
    expectAccepted(check(allBundle()), "bundle");
  });

  // why: an unsupported view is a domain result, not an error; it carries no data (design section 4).
  // proves: CLAIM(MC1), CLAIM(MC4)
  it("[MC1] an unsupported envelope without data is accepted", () => {
    const doc = patch(
      list(),
      { op: "replace", path: "/completeness", value: { status: "unsupported", reason: "no parser for this language", missingCapabilities: ["ast"] } },
      { op: "remove", path: "/data" },
    );
    expectAccepted(check(doc), "envelope");
  });

  // why: RFC 3339 allows fractional seconds; a UTC `Z` timestamp with them must not be rejected as a pattern fault.
  // proves: CLAIM(MC1)
  it("[MC1] generatedAt with fractional seconds and Z is accepted", () => {
    expectAccepted(check(patch(list(), { op: "replace", path: "/generatedAt", value: "2026-11-11T00:00:00.5Z" })), "envelope");
  });

  // why: sources may be captured in any RFC 3339 offset; only generatedAt is pinned to UTC (design section 4).
  // proves: CLAIM(MC1)
  it("[MC1] capturedAt with a +01:00 offset is accepted", () => {
    expectAccepted(check(patch(list(), { op: "replace", path: "/sources/0/capturedAt", value: "2026-11-11T01:00:00+01:00" })), "envelope");
  });

  // why: non-Git roots use gitRev null and keep hashes (design section 4); null must not be a TYPE fault.
  // proves: CLAIM(MC1)
  it("[MC1] a non-Git root with gitRev null is accepted", () => {
    expectAccepted(check(patch(list(), { op: "replace", path: "/freshness/repositories/0/gitRev", value: null })), "envelope");
  });

  // why: only a `file` source needs repository and path; a document source with a URL is legitimate.
  // proves: CLAIM(MC1)
  it("[MC1] a document source with only a URL is accepted", () => {
    const doc = patch(list(), {
      op: "add",
      path: "/sources/-",
      value: { id: "s9", kind: "document", url: "https://example.com/design", sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", capturedAt: "2026-11-11T00:00:00Z", method: "read" },
    });
    expectAccepted(check(doc), "envelope");
  });

  // why: purity. Validation must neither mutate the submitted document nor depend on call history.
  // proves: CLAIM(MC1)
  it("[MC1] validation is pure: input unchanged and a second call gives the same report", () => {
    const doc = list();
    const copy = clone(doc);
    const first = check(doc);
    const second = check(doc);
    expectAccepted(first, "envelope");
    expect(doc).toEqual(copy);
    expect(second).toEqual(first);
  });
});

describe("[MC1] not a paneweft document", () => {
  // why: input that is not even an object cannot be classified; the only fault is the root type (red-contract
  //      section 2: TYPE at pointer "", kind "unknown").
  // proves: CLAIM(MC1)
  it.each([
    ["a number", 5],
    ["a string", "paneweft.view/1"],
    ["null", null],
    ["an array", []],
    ["a boolean", true],
  ])("[MC1] %s is one TYPE issue at the root with kind unknown", (_name, input) => {
    expectRejected(check(input), [{ code: "TYPE", pointer: "" }], "unknown");
  });

  // why: the rule must be stated so an agent can act on it (constraint names the type).
  // proves: CLAIM(MC1)
  it("[MC1] the root TYPE issue names the expected type", () => {
    expectTokens(check([]), { constraint: ["object"] });
  });

  // why: an empty object has no schemaVersion; classification fails with the one missing property.
  // proves: CLAIM(MC1)
  it("[MC1] an empty object is one REQUIRED issue for schemaVersion", () => {
    expectRejected(check({}), [{ code: "REQUIRED", pointer: "/schemaVersion" }], "unknown");
  });
});

describe("[MC1] schema versions", () => {
  // why: a wrong pinned literal is SCHEMA_VERSION at /schemaVersion (red-contract section 2), whatever the rest holds.
  // proves: CLAIM(MC1)
  it.each([
    ["envelope version 2", () => patch(list(), { op: "replace", path: "/schemaVersion", value: "paneweft.view/2" })],
    ["envelope version with wrong prefix", () => patch(list(), { op: "replace", path: "/schemaVersion", value: "pane.view/1" })],
    ["envelope numeric version", () => patch(list(), { op: "replace", path: "/schemaVersion", value: 1 })],
    ["bundle version 2", () => patch(allBundle(), { op: "replace", path: "/schemaVersion", value: "paneweft.bundle/2" })],
  ])("[MC1] %s is one SCHEMA_VERSION issue", (_name, build) => {
    expectRejected(check(build()), [{ code: "SCHEMA_VERSION", pointer: "/schemaVersion" }]);
  });

  // why: the hint must tell the agent the literal to use.
  // proves: CLAIM(MC1)
  it("[MC1] the SCHEMA_VERSION issue names the pinned literal", () => {
    expectTokens(check(patch(list(), { op: "replace", path: "/schemaVersion", value: "paneweft.view/2" })), {
      constraint: ["paneweft.view/1"],
      hint: ["paneweft.view/1"],
    });
  });

  // why: a missing schemaVersion is REQUIRED (not SCHEMA_VERSION) and is the only issue.
  // proves: CLAIM(MC1)
  it.each([
    ["envelope", () => patch(list(), { op: "remove", path: "/schemaVersion" })],
    ["bundle", () => patch(allBundle(), { op: "remove", path: "/schemaVersion" })],
  ])("[MC1] a %s without schemaVersion is one REQUIRED issue", (_name, build) => {
    expectRejected(check(build()), [{ code: "REQUIRED", pointer: "/schemaVersion" }]);
  });

  // why: bundle members carry their own version; the pointer must lead through the bundle (MC20 prefix rule).
  // proves: CLAIM(MC1), CLAIM(MC20)
  it("[MC1] a bad member schemaVersion points inside the bundle", () => {
    const doc = patch(allBundle(), { op: "replace", path: "/views/0/schemaVersion", value: "paneweft.view/9" });
    expectRejected(check(doc), [{ code: "SCHEMA_VERSION", pointer: "/views/0/schemaVersion" }], "bundle");
  });
});

describe("[MC1] required envelope fields", () => {
  // why: each required property missing is a REQUIRED issue at that property's path (red-contract section 2).
  // proves: CLAIM(MC1)
  it.each([
    "id", "title", "question", "entity", "snapshotId", "component", "viewDefinitionId", "scope", "sources",
    "generatedAt", "freshness", "links", "completeness", "data",
  ])("[MC1] missing /%s is one REQUIRED issue", (field) => {
    expectRejected(check(patch(list(), { op: "remove", path: `/${field}` })), [{ code: "REQUIRED", pointer: `/${field}` }], "envelope");
  });
});

interface Case {
  name: string;
  ops: PatchOp[];
  expected: Expected[];
}
function runCases(cases: Case[], base: () => Record<string, any> = list) {
  it.each(cases)("[MC1] $name", ({ ops, expected }) => {
    expectRejected(check(patch(base(), ...ops)), expected);
  });
}

describe("[MC1] envelope types and bounds", () => {
  // why: wrong JSON types and bound violations name the offending value (TYPE / SIZE), one issue each.
  // proves: CLAIM(MC1)
  runCases([
    { name: "id as a number is TYPE", ops: [{ op: "replace", path: "/id", value: 5 }], expected: [{ code: "TYPE", pointer: "/id" }] },
    { name: "empty id is SIZE", ops: [{ op: "replace", path: "/id", value: "" }], expected: [{ code: "SIZE", pointer: "/id" }] },
    { name: "129-character id is SIZE (max 128)", ops: [{ op: "replace", path: "/id", value: "i".repeat(129) }], expected: [{ code: "SIZE", pointer: "/id" }] },
    { name: "empty title is SIZE", ops: [{ op: "replace", path: "/title", value: "" }], expected: [{ code: "SIZE", pointer: "/title" }] },
    { name: "257-character title is SIZE (max 256)", ops: [{ op: "replace", path: "/title", value: "t".repeat(257) }], expected: [{ code: "SIZE", pointer: "/title" }] },
    { name: "empty question is SIZE", ops: [{ op: "replace", path: "/question", value: "" }], expected: [{ code: "SIZE", pointer: "/question" }] },
    { name: "null snapshotId is TYPE", ops: [{ op: "replace", path: "/snapshotId", value: null }], expected: [{ code: "TYPE", pointer: "/snapshotId" }] },
    { name: "links as an object is TYPE", ops: [{ op: "replace", path: "/links", value: {} }], expected: [{ code: "TYPE", pointer: "/links" }] },
    { name: "sources as a string is TYPE", ops: [{ op: "replace", path: "/sources", value: "none" }], expected: [{ code: "TYPE", pointer: "/sources" }] },
    { name: "entity as a string is TYPE", ops: [{ op: "replace", path: "/entity", value: "watch" }], expected: [{ code: "TYPE", pointer: "/entity" }] },
    { name: "scope.repositories as a string is TYPE", ops: [{ op: "replace", path: "/scope/repositories", value: "r" }], expected: [{ code: "TYPE", pointer: "/scope/repositories" }] },
    { name: "missing scope.excludes is REQUIRED", ops: [{ op: "remove", path: "/scope/excludes" }], expected: [{ code: "REQUIRED", pointer: "/scope/excludes" }] },
  ]);

  // why: the hint for an id bound must tell the agent what a valid id is.
  // proves: CLAIM(MC1)
  it("[MC1] an empty id carries a hint naming the non-empty rule", () => {
    expectTokens(check(patch(list(), { op: "replace", path: "/id", value: "" })), { hint: ["non-empty"] });
  });
});

describe("[MC1] unknown properties", () => {
  // why: strictness (design section 5): unknown keys are rejected where they sit, never ignored, so a
  //      payload cannot smuggle keys past validation.
  // proves: CLAIM(MC1)
  runCases([
    { name: "unknown top-level key is UNKNOWN_PROPERTY at that key", ops: [{ op: "add", path: "/colour", value: "red" }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/colour" }] },
    { name: "unknown key in scope", ops: [{ op: "add", path: "/scope/extra", value: 1 }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/scope/extra" }] },
    { name: "unknown key in entity", ops: [{ op: "add", path: "/entity/extra", value: 1 }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/entity/extra" }] },
    { name: "unknown key in freshness", ops: [{ op: "add", path: "/freshness/extra", value: 1 }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/freshness/extra" }] },
    { name: "unknown key in a source", ops: [{ op: "add", path: "/sources/0/mime", value: "text/plain" }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/sources/0/mime" }] },
    { name: "unknown key in a row (data level)", ops: [{ op: "add", path: "/data/rows/0/colour", value: "red" }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/rows/0/colour" }] },
  ]);
});

describe("[MC1] hashes, timestamps, patterns", () => {
  // why: sha256 must be 64 lowercase hex (design section 4); every malformed form is one PATTERN issue at the value.
  // proves: CLAIM(MC1)
  it.each([
    ["uppercase hex", "5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03"],
    ["63 characters", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be0"],
    ["a non-hex character", "g891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"],
    ["empty", ""],
  ])("[MC1] source sha256 %s is PATTERN", (_name, value) => {
    expectRejected(check(patch(list(), { op: "replace", path: "/sources/0/sha256", value })), [{ code: "PATTERN", pointer: "/sources/0/sha256" }]);
  });

  // why: freshness file hashes use the same rule, and the pointer must escape "/" in the path key as "~1"
  //      (RFC 6901): key "src/mcp.rs" -> /freshness/repositories/0/files/src~1mcp.rs.
  // proves: CLAIM(MC1)
  it("[MC1] a bad freshness hash is PATTERN at the RFC 6901-escaped file key", () => {
    const doc = patch(list(), { op: "replace", path: "/freshness/repositories/0/files/src~1mcp.rs", value: "deadbeef" });
    const errors = expectRejected(check(doc), [{ code: "PATTERN", pointer: "/freshness/repositories/0/files/src~1mcp.rs" }]);
    expect(errors).toHaveLength(1);
  });

  // why: the hint must say what a digest looks like.
  // proves: CLAIM(MC1)
  it("[MC1] the sha256 issue hint names the 64-character form", () => {
    expectTokens(check(patch(list(), { op: "replace", path: "/sources/0/sha256", value: "abc" })), { hint: ["64"] });
  });

  // why: generatedAt is RFC 3339 UTC ending in Z (design section 4). Offsets, date-only, prose and impossible
  //      dates are each ONE PATTERN issue: format and pattern failing together must not echo twice.
  // proves: CLAIM(MC1)
  it.each([
    ["an offset instead of Z", "2026-11-11T00:00:00+01:00"],
    ["a date only", "2026-11-11"],
    ["prose", "yesterday"],
    ["month 13", "2026-13-01T00:00:00Z"],
  ])("[MC1] generatedAt with %s is one PATTERN issue", (_name, value) => {
    expectRejected(check(patch(list(), { op: "replace", path: "/generatedAt", value })), [{ code: "PATTERN", pointer: "/generatedAt" }]);
  });

  // why: the hint for generatedAt must mention UTC so the agent knows the offset is the problem.
  // proves: CLAIM(MC1)
  it("[MC1] the generatedAt hint mentions UTC", () => {
    expectTokens(check(patch(list(), { op: "replace", path: "/generatedAt", value: "2026-11-11T00:00:00+01:00" })), { hint: ["UTC"] });
  });

  // why: capturedAt must be a real RFC 3339 date-time; impossible dates/times are PATTERN.
  // proves: CLAIM(MC1)
  it.each([
    ["30 February", "2026-02-30T00:00:00Z"],
    ["hour 25", "2026-11-11T25:00:00Z"],
    ["prose", "noon"],
  ])("[MC1] capturedAt %s is one PATTERN issue", (_name, value) => {
    expectRejected(check(patch(list(), { op: "replace", path: "/sources/0/capturedAt", value })), [{ code: "PATTERN", pointer: "/sources/0/capturedAt" }]);
  });

  // why: gitRev is a 40-hex revision or null; anything else is a PATTERN/TYPE fault at the value.
  // proves: CLAIM(MC1)
  runCases([
    { name: "short gitRev is PATTERN", ops: [{ op: "replace", path: "/freshness/repositories/0/gitRev", value: "abc123" }], expected: [{ code: "PATTERN", pointer: "/freshness/repositories/0/gitRev" }] },
    { name: "uppercase gitRev is PATTERN", ops: [{ op: "replace", path: "/freshness/repositories/0/gitRev", value: "0123456789ABCDEF0123456789ABCDEF01234567" }], expected: [{ code: "PATTERN", pointer: "/freshness/repositories/0/gitRev" }] },
    { name: "numeric gitRev is TYPE", ops: [{ op: "replace", path: "/freshness/repositories/0/gitRev", value: 5 }], expected: [{ code: "TYPE", pointer: "/freshness/repositories/0/gitRev" }] },
    { name: "dirty as a string is TYPE", ops: [{ op: "replace", path: "/freshness/repositories/0/dirty", value: "no" }], expected: [{ code: "TYPE", pointer: "/freshness/repositories/0/dirty" }] },
  ]);

  // why: entity kinds are lowercase namespaces (design section 3); other forms are PATTERN at /entity/kind.
  // proves: CLAIM(MC1)
  it.each([
    ["uppercase", "Vigil/Watch"],
    ["empty segment", "vigil//watch"],
    ["leading digit", "1vigil/watch"],
  ])("[MC1] entity kind %s is one PATTERN issue", (_name, value) => {
    expectRejected(check(patch(list(), { op: "replace", path: "/entity/kind", value })), [{ code: "PATTERN", pointer: "/entity/kind" }]);
  });
});

describe("[MC1] sources", () => {
  // why: source variants (design section 4): kind is an enum; a file source needs repository AND path.
  // proves: CLAIM(MC1)
  runCases([
    { name: "source kind 'network' is ENUM", ops: [{ op: "replace", path: "/sources/0/kind", value: "network" }], expected: [{ code: "ENUM", pointer: "/sources/0/kind" }] },
    { name: "a file source without path is REQUIRED", ops: [{ op: "remove", path: "/sources/0/path" }], expected: [{ code: "REQUIRED", pointer: "/sources/0/path" }] },
    { name: "a file source without repository is REQUIRED", ops: [{ op: "remove", path: "/sources/0/repository" }], expected: [{ code: "REQUIRED", pointer: "/sources/0/repository" }] },
    {
      name: "a file source without path and repository gives both, sorted",
      ops: [{ op: "remove", path: "/sources/0/path" }, { op: "remove", path: "/sources/0/repository" }],
      expected: [{ code: "REQUIRED", pointer: "/sources/0/path" }, { code: "REQUIRED", pointer: "/sources/0/repository" }],
    },
    { name: "a source without method is REQUIRED", ops: [{ op: "remove", path: "/sources/0/method" }], expected: [{ code: "REQUIRED", pointer: "/sources/0/method" }] },
    { name: "a non-integer exitCode is TYPE", ops: [{ op: "add", path: "/sources/0/exitCode", value: 1.5 }], expected: [{ code: "TYPE", pointer: "/sources/0/exitCode" }] },
    { name: "a non-string argv element is TYPE", ops: [{ op: "add", path: "/sources/0/argv", value: [1] }], expected: [{ code: "TYPE", pointer: "/sources/0/argv/0" }] },
  ]);

  // why: a command source recording argv/exitCode/runId is evidence DATA and is accepted (it is what makes
  //      an observed item possible); the control for the argv rejections in the security suite.
  // proves: CLAIM(MC1)
  it("[MC1] a command source with runId, argv and exitCode is accepted", () => {
    expectAccepted(check(patch(list(), { op: "add", path: "/sources/-", value: runSource() })), "envelope");
  });
});

describe("[MC1] links", () => {
  const link = { id: "l1", relation: "opens", snapshotId: "snap-1", viewId: "delivery-path" };

  // why: positive control for the link negatives below (cross-view reference is checked at bundle level only).
  // proves: CLAIM(MC1)
  it("[MC1] a well-formed link is accepted in a single envelope", () => {
    expectAccepted(check(patch(list(), { op: "replace", path: "/links", value: [link] })), "envelope");
  });

  // why: a link addresses a snapshot AND a view (design section 3 cross-view links); omitting either is REQUIRED.
  // proves: CLAIM(MC1)
  it.each(["viewId", "snapshotId", "relation", "id"])("[MC1] a link without %s is one REQUIRED issue", (field) => {
    const withLink = patch(list(), { op: "replace", path: "/links", value: [link] });
    expectRejected(check(patch(withLink, { op: "remove", path: `/links/0/${field}` })), [{ code: "REQUIRED", pointer: `/links/0/${field}` }]);
  });
});

describe("[MC1] completeness variants", () => {
  // why: a complete view names its criterion; schema validation cannot prove truth but must require it (design section 4).
  // proves: CLAIM(MC1), CLAIM(MC4)
  runCases([
    { name: "complete without criterion is REQUIRED", ops: [{ op: "remove", path: "/completeness/criterion" }], expected: [{ code: "REQUIRED", pointer: "/completeness/criterion" }] },
    { name: "complete with an empty criterion is SIZE", ops: [{ op: "replace", path: "/completeness/criterion", value: "" }], expected: [{ code: "SIZE", pointer: "/completeness/criterion" }] },
    { name: "complete carrying gaps is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/completeness/gaps", value: [{ id: "g", question: "q", reason: "r" }] }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/completeness/gaps" }] },
    { name: "completeness status 'unknown' is ENUM", ops: [{ op: "replace", path: "/completeness/status", value: "unknown" }], expected: [{ code: "ENUM", pointer: "/completeness/status" }] },
    { name: "completeness without status is REQUIRED", ops: [{ op: "remove", path: "/completeness/status" }], expected: [{ code: "REQUIRED", pointer: "/completeness/status" }] },
    { name: "an unsupported view still carrying data is FORBIDDEN_PROPERTY at /data", ops: [{ op: "replace", path: "/completeness", value: { status: "unsupported", reason: "no parser", missingCapabilities: ["ast"] } }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data" }] },
    { name: "unsupported without reason is REQUIRED", ops: [{ op: "replace", path: "/completeness", value: { status: "unsupported", missingCapabilities: ["ast"] } }, { op: "remove", path: "/data" }], expected: [{ code: "REQUIRED", pointer: "/completeness/reason" }] },
    { name: "unsupported without missingCapabilities is REQUIRED", ops: [{ op: "replace", path: "/completeness", value: { status: "unsupported", reason: "no parser" } }, { op: "remove", path: "/data" }], expected: [{ code: "REQUIRED", pointer: "/completeness/missingCapabilities" }] },
  ]);

  // why: "remove the gap from a partial payload and expect rejection" (design 7, MC4): a partial view must
  //      name at least one gap, whether the key is empty or absent.
  // proves: CLAIM(MC4)
  it("[MC4] a partial view whose only gap is removed is SIZE at /completeness/gaps", () => {
    expectRejected(check(patch(componentFixture("example"), { op: "remove", path: "/completeness/gaps/0" })), [{ code: "SIZE", pointer: "/completeness/gaps" }]);
  });
  it("[MC4] a partial view without a gaps key is REQUIRED at /completeness/gaps", () => {
    expectRejected(check(patch(componentFixture("example"), { op: "remove", path: "/completeness/gaps" })), [{ code: "REQUIRED", pointer: "/completeness/gaps" }]);
  });
  it("[MC4] a partial view with a criterion is FORBIDDEN_PROPERTY", () => {
    expectRejected(check(patch(componentFixture("example"), { op: "add", path: "/completeness/criterion", value: "all of it" })), [{ code: "FORBIDDEN_PROPERTY", pointer: "/completeness/criterion" }]);
  });
  it("[MC4] a gap without a question is REQUIRED", () => {
    expectRejected(check(patch(componentFixture("example"), { op: "remove", path: "/completeness/gaps/0/question" })), [{ code: "REQUIRED", pointer: "/completeness/gaps/0/question" }]);
  });

  // why: the hint must tell the agent what a complete/partial view requires.
  // proves: CLAIM(MC1)
  it("[MC1] the missing-criterion hint mentions the criterion", () => {
    expectTokens(check(patch(list(), { op: "remove", path: "/completeness/criterion" })), { hint: ["criterion"] });
  });
});

describe("[MC1] item variants, anchors and enums (list row as carrier)", () => {
  // why: every item needs id, evidence and provenance (design 2 'Shared item notation').
  // proves: CLAIM(MC1)
  it.each(["id", "evidence", "provenance"])("[MC1] a row without %s is one REQUIRED issue", (field) => {
    expectRejected(check(patch(list(), { op: "remove", path: `/data/rows/0/${field}` })), [{ code: "REQUIRED", pointer: `/data/rows/0/${field}` }]);
  });

  // why: provenance is a closed enum; the hint lists the five values.
  // proves: CLAIM(MC1)
  it("[MC1] provenance 'guess' is ENUM and the hint lists the allowed values", () => {
    const report = check(patch(list(), { op: "replace", path: "/data/rows/0/provenance", value: "guess" }));
    expectRejected(report, [{ code: "ENUM", pointer: "/data/rows/0/provenance" }]);
    expectTokens(report, { hint: ["read", "parsed", "compiled", "observed", "inferred"] });
  });

  runCases([
    { name: "empty evidence is SIZE (at least one source id)", ops: [{ op: "replace", path: "/data/rows/0/evidence", value: [] }], expected: [{ code: "SIZE", pointer: "/data/rows/0/evidence" }] },
    { name: "evidence as a string is TYPE", ops: [{ op: "replace", path: "/data/rows/0/evidence", value: "s1" }], expected: [{ code: "TYPE", pointer: "/data/rows/0/evidence" }] },
    { name: "a numeric evidence entry is TYPE", ops: [{ op: "add", path: "/data/rows/0/evidence/-", value: 5 }], expected: [{ code: "TYPE", pointer: "/data/rows/0/evidence/1" }] },
    { name: "empty label is SIZE", ops: [{ op: "add", path: "/data/rows/0/label", value: "" }], expected: [{ code: "SIZE", pointer: "/data/rows/0/label" }] },
    { name: "257-character label is SIZE", ops: [{ op: "add", path: "/data/rows/0/label", value: "l".repeat(257) }], expected: [{ code: "SIZE", pointer: "/data/rows/0/label" }] },
    { name: "entity with a bad kind is PATTERN", ops: [{ op: "replace", path: "/data/rows/0/entity/kind", value: "Code/Module" }], expected: [{ code: "PATTERN", pointer: "/data/rows/0/entity/kind" }] },
    { name: "entity without id is REQUIRED", ops: [{ op: "remove", path: "/data/rows/0/entity/id" }], expected: [{ code: "REQUIRED", pointer: "/data/rows/0/entity/id" }] },
  ]);

  // why: reason/basis belong to inferred items only (design 2); on any other provenance they are FORBIDDEN_PROPERTY
  //      at the property (red-contract section 2, false schema).
  // proves: CLAIM(MC1), CLAIM(MC5)
  runCases([
    { name: "reason on a read row is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/rows/0/reason", value: "because" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/rows/0/reason" }] },
    { name: "basis on a read row is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/rows/0/basis", value: ["s1"] }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/rows/0/basis" }] },
    {
      name: "reason and basis together on a read row are two FORBIDDEN_PROPERTY issues, basis first",
      ops: [{ op: "add", path: "/data/rows/0/reason", value: "because" }, { op: "add", path: "/data/rows/0/basis", value: ["s1"] }],
      expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/rows/0/basis" }, { code: "FORBIDDEN_PROPERTY", pointer: "/data/rows/0/reason" }],
    },
  ]);

  // why: anchors are [first,last], one-based, inclusive, integers (design 2 'Shared item notation'); every
  //      malformed form is named at the offending element or array. `lines:[0,3]` and non-integer are
  //      the design's own examples.
  // proves: CLAIM(MC1)
  const anchor = { repository: "r", path: "src/mcp.rs", lines: [1, 3] };
  const withAnchor = (lines: unknown) => patch(list(), { op: "add", path: "/data/rows/0/anchor", value: { ...anchor, lines } });
  it("[MC1] positive control: a row with a valid anchor is accepted", () => {
    expectAccepted(check(withAnchor([1, 3])), "envelope");
  });
  it.each([
    ["line 0 is OUT_OF_RANGE", [0, 3], { code: "OUT_OF_RANGE", pointer: "/data/rows/0/anchor/lines/0" }],
    ["a negative line is OUT_OF_RANGE", [-1, 2], { code: "OUT_OF_RANGE", pointer: "/data/rows/0/anchor/lines/0" }],
    ["a fractional first line is TYPE", [1.5, 3], { code: "TYPE", pointer: "/data/rows/0/anchor/lines/0" }],
    ["a string last line is TYPE", [1, "3"], { code: "TYPE", pointer: "/data/rows/0/anchor/lines/1" }],
    ["one element is SIZE", [1], { code: "SIZE", pointer: "/data/rows/0/anchor/lines" }],
    ["three elements is SIZE", [1, 2, 3], { code: "SIZE", pointer: "/data/rows/0/anchor/lines" }],
    ["a non-array is TYPE", "1-3", { code: "TYPE", pointer: "/data/rows/0/anchor/lines" }],
  ] as const)("[MC1] anchor lines: %s", (_name, lines, expected) => {
    expectRejected(check(withAnchor(lines)), [expected]);
  });
  it("[MC1] the anchor lines hint explains the [first, last] convention (x-hint on the lines array)", () => {
    expectTokens(check(withAnchor([1])), { hint: ["one-based"] });
  });
  runCases([
    { name: "an anchor without path is REQUIRED", ops: [{ op: "add", path: "/data/rows/0/anchor", value: { repository: "r", lines: [1, 2] } }], expected: [{ code: "REQUIRED", pointer: "/data/rows/0/anchor/path" }] },
    { name: "an anchor with an unknown key is UNKNOWN_PROPERTY", ops: [{ op: "add", path: "/data/rows/0/anchor", value: { ...anchor, column: 4 } }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/rows/0/anchor/column" }] },
  ]);

  // why: a row that is not an object must give ONE TYPE issue, not one per allOf branch of the row schema
  //      (red-contract section 2: no echo from other schema branches).
  // proves: CLAIM(MC1)
  runCases([{ name: "a row that is a string is one TYPE issue", ops: [{ op: "replace", path: "/data/rows/0", value: "mcp" }], expected: [{ code: "TYPE", pointer: "/data/rows/0" }] }]);
});

describe("[MC1] component and data dispatch", () => {
  // why: the design's own example: a graph with a string depth is TYPE at /data/focus/depth with a message
  //      naming the expected type (design 7 MC1).
  // proves: CLAIM(MC1)
  it("[MC1] a graph with a string focus depth is TYPE naming 'integer'", () => {
    const doc = patch(componentFixture("graph"), { op: "add", path: "/data/focus", value: { node: "a", direction: "out", depth: "2" } });
    const report = check(doc);
    expectRejected(report, [{ code: "TYPE", pointer: "/data/focus/depth" }], "envelope");
    expectTokens(report, { constraint: ["integer"], hint: ["integer"] });
  });

  // why: the design's other half: an unknown component is UNKNOWN_COMPONENT at /component. Deferred
  //      components (matrix, heat) are unknown in v0, and their data is NOT checked (red-contract section 2).
  // proves: CLAIM(MC1)
  it.each(["heatmap", "matrix", "state", "List"])("[MC1] component '%s' is one UNKNOWN_COMPONENT issue listing the seven", (component) => {
    const report = check(patch(componentFixture("graph"), { op: "replace", path: "/component", value: component }));
    expectRejected(report, [{ code: "UNKNOWN_COMPONENT", pointer: "/component" }]);
    expectTokens(report, { hint: ["list", "tree", "graph", "source", "shape", "notebook", "example"] });
  });

  // why: with an unknown component the data cannot be judged, so a data fault beside it must NOT be reported
  //      (the single-issue rule); contrast with the TYPE test above where the component is known.
  // proves: CLAIM(MC1)
  it("[MC1] unknown component plus a string depth reports only the component", () => {
    const doc = patch(
      componentFixture("graph"),
      { op: "add", path: "/data/focus", value: { node: "a", direction: "out", depth: "2" } },
      { op: "replace", path: "/component", value: "heatmap" },
    );
    expectRejected(check(doc), [{ code: "UNKNOWN_COMPONENT", pointer: "/component" }]);
  });

  // why: data is validated against the schema of the declared component: list data under component 'graph'
  //      misses the graph's required members.
  // proves: CLAIM(MC1)
  it("[MC1] list data declared as a graph is reported against the graph schema", () => {
    const doc = patch(list(), { op: "replace", path: "/component", value: "graph" });
    const report = check(doc);
    expectRejected(
      report,
      [
        { code: "UNKNOWN_PROPERTY", pointer: "/data/columns" },
        { code: "REQUIRED", pointer: "/data/edges" },
        { code: "REQUIRED", pointer: "/data/layout" },
        { code: "REQUIRED", pointer: "/data/nodes" },
        { code: "UNKNOWN_PROPERTY", pointer: "/data/order" },
        { code: "UNKNOWN_PROPERTY", pointer: "/data/rows" },
      ],
      "envelope",
    );
  });
});

describe("[MC1] determinism and completeness of the report", () => {
  // why: all faults of a payload are reported at once (repair in one round) and in a fixed order:
  //      sorted by (pointer, code) with plain code-unit comparison (red-contract section 2).
  //      pointers: /data/order/direction < /data/rows/0/colour < /snapshotId < /title.
  // proves: CLAIM(MC1)
  const faulty = () =>
    patch(
      list(),
      { op: "replace", path: "/title", value: "" },
      { op: "remove", path: "/snapshotId" },
      { op: "add", path: "/data/rows/0/colour", value: "red" },
      { op: "replace", path: "/data/order/direction", value: "up" },
    );
  const expected: Expected[] = [
    { code: "ENUM", pointer: "/data/order/direction" },
    { code: "UNKNOWN_PROPERTY", pointer: "/data/rows/0/colour" },
    { code: "REQUIRED", pointer: "/snapshotId" },
    { code: "SIZE", pointer: "/title" },
  ];
  it("[MC1] four faults give four issues in sorted order", () => {
    expectRejected(check(faulty()), expected, "envelope");
  });

  // why: the same input twice, and the same document with every object's keys reversed, must give an
  //      identical report: no dependence on key order, hash order or call history.
  // proves: CLAIM(MC1)
  it("[MC1] the same input twice, and with reversed key order, gives deep-equal reports", () => {
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]))
          : value;
    const first = check(faulty());
    const second = check(faulty());
    const reversed = check(reverseKeys(faulty()));
    expectRejected(first, expected);
    expect(second).toEqual(first);
    expect(reversed).toEqual(first);
  });
});
