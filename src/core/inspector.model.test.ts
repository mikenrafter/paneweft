// MC7 model-based test: reduceInspector against an independent navigation model.
//
// The model below is written from docs/red-contract.md section 4 in a deliberately different style from any
// reducer: the history is a list of all frames (last = current, past = frames minus the last), panes are plain
// tuples, and every rule is a small named function over immutable arrays. It reads WORLD_TABLE directly, not the
// InspectorWorld functions the reducer is given, so both reach the same data by different routes.
//
// Shrunk-reproducer convention: fc.assert runs with a fixed seed. If it ever fails, fast-check prints the shrunk
// command list; the failure message here also carries the commands and the step. Paste the shrunk list into
// REGRESSIONS below with a comment `// shrunk from seed=42 run=<n>: <what it showed>` so it keeps running as a plain
// example forever, independent of the generator.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialInspectorState, reduceInspector } from "./inspector.ts";
import type { InspectorAction, InspectorNoticeCode, InspectorState, PaneState } from "./inspector.ts";
import { ALL_ITEM_IDS, ALL_VIEW_IDS, ENT, WORLD, WORLD_TABLE } from "../../test/helpers/nav-world.ts";
import type { EntityId } from "../../test/helpers/nav-world.ts";

// ----- commands -------------------------------------------------------------------------------
type Cmd =
  | { t: "open"; e: EntityId; s: "s1" | "s2"; pref?: string }
  | { t: "select"; i: number; item: string }
  /** Resolved against the MODEL before running: picks the k-th item of pane i's current view (a valid select), or "ghost" if pane i does not exist; i = "last" means the model's last pane (index 0, out of range, on an empty trail). */
  | { t: "pick"; i: number | "last"; k: number }
  | { t: "switch"; i: number; view: string }
  | { t: "pin"; i: number }
  | { t: "back" };

const toAction = (cmd: Exclude<Cmd, { t: "pick" }>): InspectorAction => {
  switch (cmd.t) {
    case "open":
      return cmd.pref === undefined ? { type: "open", entity: ENT[cmd.e], snapshotId: cmd.s } : { type: "open", entity: ENT[cmd.e], snapshotId: cmd.s, viewDefinitionId: cmd.pref };
    case "select":
      return { type: "select", paneIndex: cmd.i, itemId: cmd.item };
    case "switch":
      return { type: "switchView", paneIndex: cmd.i, viewDefinitionId: cmd.view };
    case "pin":
      return { type: "pin", paneIndex: cmd.i };
    case "back":
      return { type: "back" };
  }
};

// Indexes run from -1 to 4: in range, one past the end, far past, and negative (all out of range for trails <= 4 deep).
const indexArb = fc.integer({ min: -1, max: 4 });
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("open" as const), e: fc.constantFrom<EntityId>("A", "B", "C", "D", "Z"), s: fc.constantFrom("s1" as const, "s2" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("open" as const), e: fc.constantFrom<EntityId>("A", "B", "C", "D", "Z"), s: fc.constantFrom("s1" as const, "s2" as const), pref: fc.constantFrom(...ALL_VIEW_IDS) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("select" as const), i: indexArb, item: fc.constantFrom(...ALL_ITEM_IDS) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("pick" as const), i: indexArb, k: fc.nat(20) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("pick" as const), i: fc.constant("last" as const), k: fc.nat(20) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("switch" as const), i: indexArb, view: fc.constantFrom(...ALL_VIEW_IDS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("pin" as const), i: indexArb }) },
  { weight: 3, arbitrary: fc.constant({ t: "back" as const }) },
);
const commandsArb = fc.array(cmdArb, { minLength: 1, maxLength: 40 });

// ----- the independent model --------------------------------------------------------------------
type MPane = readonly [entityId: string, snapshotId: string, view: string, selection: readonly string[], pinned: boolean];
interface MFrame { readonly trail: readonly MPane[]; readonly retained: readonly MPane[] }
interface MModel { readonly frames: readonly MFrame[] } // frames[last] is current; frames minus last is the history
interface MOut { readonly model: MModel; readonly notice: InspectorNoticeCode | undefined }

const current = (m: MModel): MFrame => m.frames[m.frames.length - 1]!;
const frameKey = (f: MFrame): string => JSON.stringify([f.trail, f.retained]);
const commit = (m: MModel, f: MFrame): MModel => (frameKey(f) === frameKey(current(m)) ? m : { frames: [...m.frames, f] });
const pinnedOnly = (panes: readonly MPane[]): MPane[] => panes.filter((p) => p[4]);
const viewsOf = (entityId: string, snapshotId: string) => WORLD_TABLE[snapshotId]?.[entityId];
const fresh = (entityId: string, snapshotId: string, view: string): MPane => [entityId, snapshotId, view, [], false];

/** Turns a `pick` into a concrete select using only the model's own state (never the reducer's). */
function concretize(m: MModel, cmd: Cmd): Exclude<Cmd, { t: "pick" }> {
  if (cmd.t !== "pick") return cmd;
  const index = cmd.i === "last" ? Math.max(0, current(m).trail.length - 1) : cmd.i;
  const pane = current(m).trail[index];
  if (pane === undefined) return { t: "select", i: index, item: "ghost" };
  const items = Object.keys(viewsOf(pane[0], pane[1])!.views[pane[2]]!);
  return { t: "select", i: index, item: items[cmd.k % items.length]! };
}

function modelStep(m: MModel, cmd: Exclude<Cmd, { t: "pick" }>): MOut {
  const { trail, retained } = current(m);
  const unchanged = (notice: InspectorNoticeCode): MOut => ({ model: m, notice });
  switch (cmd.t) {
    case "open": {
      const row = viewsOf(cmd.e, cmd.s);
      if (row === undefined) return unchanged("UNKNOWN_VIEW");
      const view = cmd.pref !== undefined && cmd.pref in row.views ? cmd.pref : row.initial;
      return { model: commit(m, { trail: [fresh(cmd.e, cmd.s, view)], retained: [...retained, ...pinnedOnly(trail)] }), notice: undefined };
    }
    case "select": {
      if (cmd.i < 0 || cmd.i >= trail.length) return unchanged("NO_SUCH_PANE");
      const source = trail[cmd.i]!;
      const items = viewsOf(source[0], source[1])?.views[source[2]];
      if (items === undefined || !(cmd.item in items)) return unchanged("UNRESOLVED_TARGET");
      const target = items[cmd.item] ?? null; // entity id | null (the item exists)
      const kept: MPane[] = [...trail.slice(0, cmd.i), [source[0], source[1], source[2], [cmd.item], source[4]]];
      const moved = pinnedOnly(trail.slice(cmd.i + 1));
      const spawned: MPane[] = target === null ? [] : [fresh(target, source[1], viewsOf(target, source[1])!.initial)];
      return { model: commit(m, { trail: [...kept, ...spawned], retained: [...retained, ...moved] }), notice: target === null ? "NO_TARGET" : undefined };
    }
    case "switch": {
      if (cmd.i < 0 || cmd.i >= trail.length) return unchanged("NO_SUCH_PANE");
      const target = trail[cmd.i]!;
      const row = viewsOf(target[0], target[1]);
      if (row === undefined || !(cmd.view in row.views)) return unchanged("UNKNOWN_VIEW");
      const valid = target[3].filter((id) => id in row.views[cmd.view]!);
      const replaced: MPane = [target[0], target[1], cmd.view, valid, target[4]];
      return { model: commit(m, { trail: trail.map((p, k) => (k === cmd.i ? replaced : p)), retained }), notice: undefined };
    }
    case "pin": {
      if (cmd.i < 0 || cmd.i >= trail.length) return unchanged("NO_SUCH_PANE");
      const target = trail[cmd.i]!;
      const replaced: MPane = [target[0], target[1], target[2], target[3], true];
      return { model: commit(m, { trail: trail.map((p, k) => (k === cmd.i ? replaced : p)), retained }), notice: undefined };
    }
    case "back":
      return m.frames.length === 1 ? unchanged("NOTHING_TO_GO_BACK") : { model: { frames: m.frames.slice(0, -1) }, notice: undefined };
  }
}

// ----- projections (what is compared after every step) -------------------------------------------
interface PaneProjection { entity: string; kind: string; snapshotId: string; view: string; selection: string[]; filters: unknown; pinned: boolean }
const projectReal = (p: PaneState): PaneProjection => ({ entity: p.entity.id, kind: p.entity.kind, snapshotId: p.snapshotId, view: p.viewDefinitionId, selection: [...p.selection], filters: p.filters, pinned: p.pinned });
const projectModel = (p: MPane): PaneProjection => ({ entity: p[0], kind: ENT[p[0] as EntityId].kind, snapshotId: p[1], view: p[2], selection: [...p[3]], filters: {}, pinned: p[4] });
const realView = (s: InspectorState) => ({ trail: s.trail.map(projectReal), retained: s.retained.map(projectReal), pastDepth: s.past.length });
const modelView = (m: MModel) => ({ trail: current(m).trail.map(projectModel), retained: current(m).retained.map(projectModel), pastDepth: m.frames.length - 1 });
/** Past frames, projected, for the exact-history comparison. */
const realPast = (s: InspectorState) => s.past.map((f) => ({ trail: f.trail.map(projectReal), retained: f.retained.map(projectReal) }));
const modelPast = (m: MModel) => m.frames.slice(0, -1).map((f) => ({ trail: f.trail.map(projectModel), retained: f.retained.map(projectModel) }));

const ILLEGAL: ReadonlySet<InspectorNoticeCode> = new Set(["NO_SUCH_PANE", "UNRESOLVED_TARGET", "UNKNOWN_VIEW", "NOTHING_TO_GO_BACK"]);

interface RunStats { maxTrail: number; maxRetained: number; maxPast: number; notices: Set<string>; successfulBacks: number }
/** Runs one command list through reducer and model, asserting agreement after EVERY step. */
function agree(commands: readonly Cmd[]): RunStats {
  let state = initialInspectorState();
  let model: MModel = { frames: [{ trail: [], retained: [] }] };
  const stats: RunStats = { maxTrail: 0, maxRetained: 0, maxPast: 0, notices: new Set(), successfulBacks: 0 };
  commands.forEach((cmd, index) => {
    const ctx = `REPRO seed=42 step=${index} cmd=${JSON.stringify(cmd)} commands=${JSON.stringify(commands.slice(0, index + 1))} (pick resolves against the model)`;
    const previous = state;
    const concrete = concretize(model, cmd);
    const expected = modelStep(model, concrete);
    const outcome = reduceInspector(previous, toAction(concrete), WORLD);
    expect(outcome.notice?.code, `notice code. ${ctx}`).toBe(expected.notice);
    expect(realView(outcome.state), `projection. ${ctx}`).toEqual(modelView(expected.model));
    expect(realPast(outcome.state), `history frames. ${ctx}`).toEqual(modelPast(expected.model));
    if (expected.notice !== undefined && ILLEGAL.has(expected.notice)) {
      expect(outcome.state, `illegal command must leave the state untouched. ${ctx}`).toStrictEqual(previous);
    }
    state = outcome.state;
    model = expected.model;
    stats.maxTrail = Math.max(stats.maxTrail, state.trail.length);
    stats.maxRetained = Math.max(stats.maxRetained, state.retained.length);
    stats.maxPast = Math.max(stats.maxPast, state.past.length);
    if (expected.notice !== undefined) stats.notices.add(expected.notice);
    if (concrete.t === "back" && expected.notice === undefined) stats.successfulBacks += 1;
  });
  return stats;
}

// Regression sequences: paste shrunk counterexamples here (see header). Seeded with hand-picked edge sequences.
const REGRESSIONS: Array<{ name: string; commands: Cmd[] }> = [
  { name: "the design scenario", commands: [{ t: "open", e: "A", s: "s1" }, { t: "select", i: 0, item: "a-b" }, { t: "select", i: 1, item: "b-c" }, { t: "pin", i: 1 }, { t: "select", i: 0, item: "a-x" }, { t: "switch", i: 0, view: "va-graph" }, { t: "back" }, { t: "back" }] },
  { name: "pin twice then back twice", commands: [{ t: "open", e: "B", s: "s1" }, { t: "pin", i: 0 }, { t: "pin", i: 0 }, { t: "back" }, { t: "back" }, { t: "back" }] },
  { name: "cycle A-B-C-A then select in the middle", commands: [{ t: "open", e: "A", s: "s1" }, { t: "select", i: 0, item: "a-b" }, { t: "select", i: 1, item: "b-c" }, { t: "select", i: 2, item: "c-a" }, { t: "select", i: 1, item: "b-none" }, { t: "back" }] },
  { name: "snapshots: open in s2 then select, open in s1, back", commands: [{ t: "open", e: "A", s: "s2" }, { t: "select", i: 0, item: "a-b" }, { t: "open", e: "A", s: "s1" }, { t: "select", i: 0, item: "a-x" }, { t: "back" }, { t: "back" }] },
  { name: "every refusal first, then a valid sequence", commands: [{ t: "back" }, { t: "pin", i: 0 }, { t: "select", i: 0, item: "a-b" }, { t: "switch", i: 0, view: "va-list" }, { t: "open", e: "Z", s: "s1" }, { t: "open", e: "A", s: "s1", pref: "va-graph" }, { t: "select", i: 0, item: "a-x" }] },
];

describe("MC7 reducer versus the independent navigation model", () => {
  // why: the headline MC7 property ("compare entity IDs, snapshot IDs, selection and retained branch against a small
  //      independent navigation model"): for ANY command sequence the real reducer and the model agree after every step on
  //      trail/retained projections (entity, snapshot, view, selection, pinned, filters), the full history, and the notice
  //      code; and every illegal command leaves the state strictly untouched. Fixed seed => reproducible.
  // proves: CLAIM(MC7)
  it("[MC7] 300 random command sequences: reducer and model agree after every step", () => {
    fc.assert(fc.property(commandsArb, (commands) => void agree(commands)), { seed: 42, numRuns: 300 });
  });

  // why: pinned regression sequences (the shrunk-reproducer convention) run through the same agreement check.
  // proves: CLAIM(MC7)
  it.each(REGRESSIONS.map((entry) => [entry.name, entry.commands] as const))("[MC7] regression sequence: %s", (_name, commands) => {
    agree(commands);
  });

  // why: a generator that rarely produces deep trails, retained panes, refusals or successful Backs would make the
  //      agreement property vacuous. With the same fixed seed we sample the generator and require that the
  //      MODEL saw each interesting situation at least once (boolean coverage, not counts).
  // proves: CLAIM(MC7)
  it("[MC7] the generator reaches deep trails, retained panes, every refusal, NO_TARGET and successful Backs", () => {
    const sample = fc.sample(commandsArb, { seed: 42, numRuns: 300 });
    const totals: RunStats = { maxTrail: 0, maxRetained: 0, maxPast: 0, notices: new Set(), successfulBacks: 0 };
    for (const commands of sample) {
      let model: MModel = { frames: [{ trail: [], retained: [] }] };
      for (const raw of commands) {
        const cmd = concretize(model, raw);
        const out = modelStep(model, cmd);
        model = out.model;
        totals.maxTrail = Math.max(totals.maxTrail, current(model).trail.length);
        totals.maxRetained = Math.max(totals.maxRetained, current(model).retained.length);
        if (out.notice !== undefined) totals.notices.add(out.notice);
        if (cmd.t === "back" && out.notice === undefined) totals.successfulBacks += 1;
      }
    }
    expect(totals.maxTrail >= 4, "a trail of four panes").toBe(true);
    expect(totals.maxRetained >= 1, "a retained pane").toBe(true);
    expect(totals.successfulBacks >= 1, "a successful Back").toBe(true);
    for (const code of ["NO_SUCH_PANE", "UNRESOLVED_TARGET", "UNKNOWN_VIEW", "NOTHING_TO_GO_BACK", "NO_TARGET"]) expect(totals.notices.has(code), code).toBe(true);
  });

  // why: the model is only a fair oracle if the world table it reads is self-consistent: every item target must exist in
  //      the same snapshot (otherwise `viewsOf(target)!` above would hide a table bug as an agreement).
  // proves: CLAIM(MC7)
  it("[MC7] the literal world is consistent: every item target exists in its own snapshot", () => {
    const dangling: string[] = [];
    for (const [snapshotId, entities] of Object.entries(WORLD_TABLE)) {
      for (const [entityId, row] of Object.entries(entities)) {
        expect(entityId in ENT, `${snapshotId}/${entityId} is a known entity`).toBe(true);
        expect(row.initial in row.views, `${snapshotId}/${entityId} initial view exists`).toBe(true);
        for (const [view, items] of Object.entries(row.views)) {
          for (const [item, target] of Object.entries(items)) {
            if (target !== null && entities[target] === undefined) dangling.push(`${snapshotId}/${entityId}/${view}/${item} -> ${target}`);
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});
