// MC12 rankViews: exact-kind matching, built-ins, priority/tie-break order, missing-data explanation,
// preferred-view precedence, cheap registration, determinism. Normative: docs/red-contract.md section 5; design
// section 3 ("Definitions sort by ascending priority, then stable definition ID. Default priority is 50").
// Where the contract is silent (built-in titles/components, behaviour when an instance is unsupported AND roles are
// missing, a user priority above 1000) nothing is asserted; see docs/contract-additions/nav.md.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rankViews } from "./registry.ts";
import type { RankInput, RankedView, ViewInstanceInfo } from "./registry.ts";
import type { Entity, ViewDefinition } from "./wire.ts";
import { deepFreeze } from "../../test/helpers/nav-world.ts";

const entity = (kind: string, dataRoles: string[]): Entity => ({ repository: "r", id: "w", kind, snapshotId: "snap-1", label: "w", dataRoles, relations: [] });
const def = (id: string, options: { kind?: string; priority?: number; requires?: string[]; dataRole?: string; component?: ViewDefinition["component"]; title?: string } = {}): ViewDefinition => ({
  id,
  entityKind: options.kind ?? "vigil/watch",
  title: options.title ?? `title of ${id}`,
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  component: options.component ?? "list",
  requires: options.requires ?? [],
  dataRole: options.dataRole ?? "main",
});
const ids = (views: RankedView[]) => views.map((view) => view.definitionId);
const BUILTINS = ["builtin:metadata", "builtin:raw"];
const complete: ViewInstanceInfo["completeness"] = { status: "complete", criterion: "fixture" };

describe("exact kind matching and built-ins", () => {
  // why: design section 3 "A registry indexes definitions by exact kind ... no kind inheritance". vigil/watch must not pick up
  //      vigil/watch-result, vigil (prefix) or vigil/watch/sub (child), and the reverse holds; each entity sees only its own
  //      kind's definitions, then the two built-ins.
  // proves: CLAIM(MC12)
  it.each([
    ["vigil/watch", ["d-watch"]],
    ["vigil/watch-result", ["d-result"]],
    ["vigil", ["d-vigil"]],
    ["vigil/watch/sub", ["d-sub"]],
  ] as const)("[MC12] an entity of kind %s sees exactly its own kind's definitions, then the built-ins", (kind, expected) => {
    const definitions = [def("d-watch", { kind: "vigil/watch" }), def("d-result", { kind: "vigil/watch-result" }), def("d-vigil", { kind: "vigil" }), def("d-sub", { kind: "vigil/watch/sub" })];
    const { views } = rankViews({ entity: entity(kind, ["main"]), definitions, instances: [] });
    expect(ids(views)).toEqual([...expected, ...BUILTINS]);
  });

  // why: contract: `*` built-ins `builtin:metadata` (priority 1000) and `builtin:raw` (1001) are always appended and always
  //      available; with no matching definition they are the whole list, and `selected` is the metadata built-in (never null).
  // proves: CLAIM(MC12)
  it("[MC12] an entity with no matching definition gets exactly the two built-ins, available, selected = builtin:metadata", () => {
    const out = rankViews({ entity: entity("code/module", []), definitions: [def("other", { kind: "vigil/watch" })], instances: [] });
    expect(out.views.map((v) => [v.definitionId, v.priority, v.fallback, v.availability])).toStrictEqual([
      ["builtin:metadata", 1000, true, { status: "available" }],
      ["builtin:raw", 1001, true, { status: "available" }],
    ]);
    expect(out.selected).toStrictEqual({ definitionId: "builtin:metadata" });
  });

  // why: exact-kind views come first and are not flagged as fallbacks; the RankedView mirrors the definition (title, component,
  //      explicit priority) so the UI needs no second lookup. Full-object equality pins the shape.
  // proves: CLAIM(MC12)
  it("[MC12] a matching definition is listed before the built-ins with its own title, component and priority", () => {
    const { views } = rankViews({ entity: entity("vigil/watch", ["main"]), definitions: [def("d1", { priority: 7, component: "graph", title: "Calls receiving cancellation" })], instances: [] });
    expect(views[0]).toStrictEqual({ definitionId: "d1", title: "Calls receiving cancellation", priority: 7, component: "graph", availability: { status: "available" }, fallback: false });
    expect(ids(views)).toEqual(["d1", ...BUILTINS]);
  });
});

describe("ordering", () => {
  // why: ascending priority, an omitted priority counts as 50 (design section 3), an explicit 50 ties with it and is then
  //      ordered by id. Ids are chosen so id order differs from priority order (x3 has the lowest id but the highest priority).
  //      Boundary rows 49/50/51 pin the default exactly.
  // proves: CLAIM(MC12)
  it("[MC12] lower priority first; omitted priority is 50 and ties with an explicit 50 by id", () => {
    const definitions = [def("x3", { priority: 100 }), def("x2"), def("x0", { priority: 50 }), def("x6", { priority: 51 }), def("x1", { priority: 5 }), def("x5", { priority: 49 }), def("x4", { priority: -3 })];
    const { views } = rankViews({ entity: entity("vigil/watch", ["main"]), definitions, instances: [] });
    expect(views.map((v) => [v.definitionId, v.priority])).toEqual([
      ["x4", -3], ["x1", 5], ["x5", 49], ["x0", 50], ["x2", 50], ["x6", 51], ["x3", 100],
      ["builtin:metadata", 1000], ["builtin:raw", 1001],
    ]);
  });

  // why: tie-break is by id in CODE-UNIT order, not locale order and not numeric: uppercase "B" (0x42) before lowercase "a"
  //      (0x61); "10" before "9" ('1' < '9'); "a" before "a2" (prefix). localeCompare would give 10,9,a,a2,B.
  //      Both input orders, so an implementation that keeps input order on ties fails one of them.
  // proves: CLAIM(MC12)
  it.each([
    ["as listed", ["B", "a", "a2", "10", "9"]],
    ["reversed", ["9", "10", "a2", "a", "B"]],
  ] as const)("[MC12] equal priorities sort by code-unit id order (input %s)", (_name, order) => {
    const { views } = rankViews({ entity: entity("vigil/watch", ["main"]), definitions: order.map((id) => def(id)), instances: [] });
    expect(ids(views)).toEqual(["10", "9", "B", "a", "a2", ...BUILTINS]);
  });
});

describe("availability and the missing-data explanation", () => {
  // why: required roles = `requires` union {dataRole}; missing = required minus the entity's dataRoles, SORTED (code-unit)
  //      and de-duplicated. The row with "b" and "B" pins the sort; "z","a","a" pins de-dup; the roles the entity has
  //      (extra "q", present "p") never appear.
  // proves: CLAIM(MC12)
  it.each([
    ["requires + dataRole, none held, unsorted input with a duplicate", ["z", "a", "a"], "m", ["q"], ["a", "m", "z"]],
    ["dataRole alone missing", [], "d", [], ["d"]],
    ["one required role held, dataRole missing", ["p"], "d", ["p", "q"], ["d"]],
    ["upper case sorts before lower case", ["b", "B"], "p", ["p"], ["B", "b"]],
  ] as const)("[MC12] needs_data lists exactly the sorted missing roles: %s", (_name, requires, dataRole, held, missing) => {
    const { views } = rankViews({ entity: entity("vigil/watch", [...held]), definitions: [def("d", { requires: [...requires], dataRole })], instances: [] });
    expect(views[0]?.availability).toStrictEqual({ status: "needs_data", missingRoles: [...missing] });
  });

  // why: positive control for the above: when every required role (and the dataRole) is held the view is available, with no
  //      extra keys on the availability object.
  // proves: CLAIM(MC12)
  it("[MC12] a definition whose roles are all held is available", () => {
    const { views } = rankViews({ entity: entity("vigil/watch", ["a", "b", "main", "extra"]), definitions: [def("d", { requires: ["a", "b"] })], instances: [] });
    expect(views[0]?.availability).toStrictEqual({ status: "available" });
  });

  // why: an instance whose completeness is `unsupported` makes ITS definition unsupported with the instance's own reason
  //      (design section 3 "unsupported with a reason"); instances of other definitions, and complete or partial instances of
  //      the same definition, do not.
  // proves: CLAIM(MC12)
  it("[MC12] an unsupported instance marks its definition unsupported with that reason; others stay available", () => {
    const instances: ViewInstanceInfo[] = [
      { definitionId: "d-un", completeness: { status: "unsupported", reason: "no tracer attached", missingCapabilities: ["trace"] } },
      { definitionId: "d-partial", completeness: { status: "partial", gaps: [{ id: "g", question: "q?", reason: "r" }] } },
      { definitionId: "d-complete", completeness: complete },
    ];
    const definitions = [def("d-un", { priority: 1 }), def("d-partial", { priority: 2 }), def("d-complete", { priority: 3 }), def("d-none", { priority: 4 })];
    const { views } = rankViews({ entity: entity("vigil/watch", ["main"]), definitions, instances });
    expect(views.slice(0, 4).map((v) => [v.definitionId, v.availability])).toStrictEqual([
      ["d-un", { status: "unsupported", reason: "no tracer attached" }],
      ["d-partial", { status: "available" }],
      ["d-complete", { status: "available" }],
      ["d-none", { status: "available" }],
    ]);
  });
});

describe("selected view", () => {
  // d1 needs a role the entity lacks (needs_data), d2/d3 are available, d4 is unsupported by its instance.
  const base = (preferred?: string): RankInput => ({
    entity: entity("vigil/watch", ["main", "ok"]),
    definitions: [def("d1", { priority: 10, dataRole: "logs" }), def("d2", { priority: 20, dataRole: "ok" }), def("d3", { priority: 30, dataRole: "ok" }), def("d4", { priority: 25, dataRole: "ok" })],
    instances: [{ definitionId: "d4", completeness: { status: "unsupported", reason: "needs a compiler", missingCapabilities: ["compile"] } }],
    ...(preferred === undefined ? {} : { preferredViewDefinitionId: preferred }),
  });

  // why: no preference: the first AVAILABLE view in rank order, skipping a needs_data view ahead of it (d1) and an unsupported one.
  //      toStrictEqual: no `fallbackFrom` key when nothing was requested.
  // proves: CLAIM(MC12)
  it("[MC12] without a preference the first available view is selected, with no fallbackFrom", () => {
    expect(rankViews(base()).selected).toStrictEqual({ definitionId: "d2" });
  });

  // why: design section 3 / MC12 "explicit preferred-view precedence": an available preferred view wins even when a better-
  //      ranked view is available (d3 has the worse priority), and it is not reported as a fallback. A built-in id is a legal preference.
  // proves: CLAIM(MC12)
  it.each([
    ["a worse-priority available definition", "d3", "d3"],
    ["the best-ranked available definition", "d2", "d2"],
    ["a built-in", "builtin:raw", "builtin:raw"],
  ] as const)("[MC12] an available preferred view wins: %s", (_name, preferred, expected) => {
    expect(rankViews(base(preferred)).selected).toStrictEqual({ definitionId: expected });
  });

  // why: an unavailable preferred view falls back VISIBLY: selected is the first available view and fallbackFrom names what was
  //      requested and why. needs_data -> the reason names the missing role ("logs"); unsupported -> it carries the instance's
  //      reason. (Exact wording is free; naming the cause is the contract's "reason naming the missing role".)
  // proves: CLAIM(MC12)
  it.each([
    ["needs_data names the missing role", "d1", "logs"],
    ["unsupported carries the instance reason", "d4", "needs a compiler"],
  ] as const)("[MC12] unavailable preferred view falls back to the first available with a reason: %s", (_name, preferred, mustMention) => {
    const { selected } = rankViews(base(preferred));
    expect(selected?.definitionId).toBe("d2");
    expect(selected?.fallbackFrom?.requested).toBe(preferred);
    expect(selected?.fallbackFrom?.reason).toContain(mustMention);
    expect(Object.keys(selected ?? {}).sort()).toEqual(["definitionId", "fallbackFrom"]);
    expect(Object.keys(selected?.fallbackFrom ?? {}).sort()).toEqual(["reason", "requested"]);
  });

  // why: a preferred id that is not a view of this entity at all (nonexistent, or a definition registered for ANOTHER kind)
  //      falls back with a reason that names the requested id; it must not be selected just because the id exists somewhere.
  // proves: CLAIM(MC12)
  it.each([
    ["an id nobody registered", "nope"],
    ["a definition of another kind", "foreign"],
  ] as const)("[MC12] unknown preferred id falls back with a reason naming it: %s", (_name, preferred) => {
    const input = base(preferred);
    input.definitions.push(def("foreign", { kind: "code/module" }));
    const { selected } = rankViews(input);
    expect(selected?.definitionId).toBe("d2");
    expect(selected?.fallbackFrom?.requested).toBe(preferred);
    expect(selected?.fallbackFrom?.reason).toContain(preferred);
  });

  // why: design/contract: the built-ins are always available, so `selected` is never null for any entity. All registered
  //      views needs_data (entity holds no roles) -> builtin:metadata; a preference for a needs_data view still lands there.
  // proves: CLAIM(MC12)
  it("[MC12] when no registered view is available, selected is builtin:metadata (never null)", () => {
    const input: RankInput = { entity: entity("vigil/watch", []), definitions: [def("d1", { dataRole: "alpha-role" }), def("d2", { dataRole: "beta-role" })], instances: [] };
    expect(rankViews(input).selected).toStrictEqual({ definitionId: "builtin:metadata" });
    const preferring = rankViews({ ...input, preferredViewDefinitionId: "d2" }).selected;
    expect(preferring?.definitionId).toBe("builtin:metadata");
    expect(preferring?.fallbackFrom?.requested).toBe("d2");
    expect(preferring?.fallbackFrom?.reason).toContain("beta-role");
  });
});

describe("registering a view is a pure data change", () => {
  const watch = entity("vigil/watch", ["main", "events"]);
  const modules = def("d-modules", { priority: 10, component: "list", dataRole: "main" });
  const events = def("d-events", { priority: 30, component: "list", dataRole: "events" });
  const baseline = rankViews({ entity: watch, definitions: [modules, events], instances: [] }).views;

  // why: MC12 "Register a second list view for vigil/watch and show it without a browser rebuild": adding ONE definition to the input
  //      makes ONE new entry appear at its sorted place and changes nothing else (every other entry deep-equal to the baseline).
  //      Rows: a better priority, in between, an equal priority whose id sorts before / after, and one worse than all (but
  //      below the built-ins).
  // proves: CLAIM(MC12)
  it.each([
    ["priority 5", { id: "d-persist", priority: 5 }, 0],
    ["priority 20", { id: "d-persist", priority: 20 }, 1],
    ["priority 30, id sorts before d-events", { id: "d-aaa", priority: 30 }, 1],
    ["priority 30, id sorts after d-events", { id: "d-zzz", priority: 30 }, 2],
    ["priority 999", { id: "d-persist", priority: 999 }, 2],
  ] as const)("[MC12] a second list view appears at its sorted place: %s", (_name, added, insertAt) => {
    const created = def(added.id, { priority: added.priority, component: "list", title: "Persistence failures", dataRole: "events" });
    const { views } = rankViews({ entity: watch, definitions: [modules, events, created], instances: [] });
    const expectedNew: RankedView = { definitionId: added.id, title: "Persistence failures", priority: added.priority, component: "list", availability: { status: "available" }, fallback: false };
    const expected = [...baseline.slice(0, insertAt), expectedNew, ...baseline.slice(insertAt)];
    expect(views).toStrictEqual(expected);
  });

  // why: a definition for another entity kind never shows up for this entity, whatever its priority: output is identical to the baseline.
  // proves: CLAIM(MC12)
  it("[MC12] a definition registered for another kind changes nothing", () => {
    const foreign = def("d-foreign", { kind: "code/module", priority: 1, dataRole: "main" });
    expect(ids(baseline), "control: the baseline really lists the two definitions").toEqual(["d-modules", "d-events", ...BUILTINS]);
    expect(rankViews({ entity: watch, definitions: [modules, foreign, events], instances: [] }).views).toStrictEqual(baseline);
  });
});

describe("purity and determinism", () => {
  // why: rankViews is pure: frozen inputs (a mutation would throw) and an unchanged JSON snapshot afterwards; the same call twice gives equal output.
  // proves: CLAIM(MC12)
  it("[MC12] does not mutate its input and is repeatable", () => {
    const input: RankInput = {
      entity: entity("vigil/watch", ["b", "a"]),
      definitions: [def("y", { priority: 2, requires: ["b"], dataRole: "a" }), def("x", { priority: 2, dataRole: "b" }), def("w", { priority: 1, dataRole: "a" })],
      instances: [{ definitionId: "w", completeness: { status: "unsupported", reason: "r", missingCapabilities: ["c"] } }],
      preferredViewDefinitionId: "y",
    };
    const before = JSON.stringify(input);
    const first = rankViews(deepFreeze(structuredClone(input)));
    expect(JSON.stringify(input)).toBe(before);
    expect(rankViews(structuredClone(input))).toStrictEqual(first);
    // Control that the result is real: w (priority 1) is unsupported, x (first available) is NOT selected because y is preferred and available.
    expect(first.views.map((v) => v.availability.status)).toEqual(["unsupported", "available", "available", "available", "available"]);
    expect(first.selected).toStrictEqual({ definitionId: "y" });
  });

  // ---- property: shuffled input, and an independent oracle ----
  const ROLE_POOL = ["r1", "r2", "r3", "R4"];
  const ID_POOL = ["B", "a", "a2", "10", "9", "d1", "Z", "z", "_x", "d-2"];
  const KINDS = ["vigil/watch", "vigil", "vigil/watch-result"];
  const definitionArb = fc.record({
    id: fc.constantFrom(...ID_POOL),
    kind: fc.constantFrom(...KINDS),
    priority: fc.option(fc.constantFrom(-5, 0, 49, 50, 51, 120), { nil: undefined }),
    requires: fc.subarray(ROLE_POOL),
    dataRole: fc.constantFrom(...ROLE_POOL),
  });
  const inputArb = fc.record({
    definitions: fc.uniqueArray(definitionArb, { selector: (d) => d.id, maxLength: 10 }),
    roles: fc.subarray(ROLE_POOL),
    unsupportedIds: fc.subarray(ID_POOL),
    preferred: fc.option(fc.constantFrom(...ID_POOL, "builtin:raw", "builtin:metadata", "ghost"), { nil: undefined }),
    keys: fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 24, maxLength: 24 }),
  });
  const permute = <T>(list: T[], keys: number[], offset: number): T[] =>
    list.map((value, index) => [value, keys[(index + offset) % keys.length] ?? 0] as const).sort((a, b) => a[1] - b[1]).map(([value]) => value);
  type Sample = typeof inputArb extends fc.Arbitrary<infer T> ? T : never;
  const toInput = (sample: Sample, shuffle: boolean): RankInput => {
    const definitions = sample.definitions.map((d) => def(d.id, { kind: d.kind, ...(d.priority === undefined ? {} : { priority: d.priority }), requires: d.requires, dataRole: d.dataRole }));
    const instances: ViewInstanceInfo[] = sample.unsupportedIds.map((id) => ({ definitionId: id, completeness: { status: "unsupported", reason: `reason of ${id}`, missingCapabilities: ["c"] } }));
    const roles = [...sample.roles];
    return {
      entity: entity("vigil/watch", shuffle ? permute(roles, sample.keys, 7) : roles),
      definitions: shuffle ? permute(definitions, sample.keys, 0) : definitions,
      instances: shuffle ? permute(instances, sample.keys, 3) : instances,
      ...(sample.preferred === undefined ? {} : { preferredViewDefinitionId: sample.preferred }),
    };
  };
  const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  // why: determinism under input order (design section 5 "Sort unordered inputs"): permuting definitions, instances and the
  //      entity's roles must not change the output at all; and the id order / availability must equal a small independent oracle
  //      (priority with default 50, then code-unit id; missing = (requires + dataRole) - roles, sorted; unsupported by instance).
  // proves: CLAIM(MC12)
  it("[MC12] output is independent of input order and matches an independent oracle (300 seeded cases)", () => {
    fc.assert(
      fc.property(inputArb, (sample) => {
        const plain = toInput(sample, false);
        const shuffled = toInput(sample, true);
        const out = rankViews(plain);
        expect(rankViews(shuffled), "shuffled input").toStrictEqual(out);

        const mine = sample.definitions.filter((d) => d.kind === "vigil/watch").sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50) || codeUnit(a.id, b.id));
        expect(ids(out.views)).toEqual([...mine.map((d) => d.id), ...BUILTINS]);
        const first = out.views.find((v) => v.availability.status === "available");
        expect(first, "a built-in is always available").toBeDefined();
        for (const d of mine) {
          const required = [...new Set([...d.requires, d.dataRole])];
          const missing = required.filter((role) => !sample.roles.includes(role)).sort(codeUnit);
          const shown = out.views.find((v) => v.definitionId === d.id)?.availability;
          if (sample.unsupportedIds.includes(d.id) && missing.length === 0) expect(shown).toStrictEqual({ status: "unsupported", reason: `reason of ${d.id}` });
          else if (missing.length > 0 && !sample.unsupportedIds.includes(d.id)) expect(shown).toStrictEqual({ status: "needs_data", missingRoles: missing });
          else if (missing.length === 0) expect(shown).toStrictEqual({ status: "available" });
        }
        const preferred = out.views.find((v) => v.definitionId === sample.preferred);
        if (sample.preferred !== undefined && preferred?.availability.status === "available") expect(out.selected).toStrictEqual({ definitionId: sample.preferred });
        else if (sample.preferred !== undefined) expect(out.selected?.fallbackFrom?.requested).toBe(sample.preferred);
        else expect(out.selected).toStrictEqual({ definitionId: first?.definitionId });
      }),
      { seed: 42, numRuns: 300 },
    );
  });
});
