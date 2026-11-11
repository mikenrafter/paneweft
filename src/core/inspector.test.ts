// MC7 pane navigation: literal scenarios for reduceInspector.
// Rules are normative in docs/red-contract.md section 4; design section 3 ("Inspector model") and the
// MC7 row of section 7. The world is a literal data table (test/helpers/nav-world.ts); every expected
// state below is written by hand with its derivation in a comment. The model-based sibling suite is
// inspector.model.test.ts.
//
// Notation: A(a-b) = pane of entity A with selection ["a-b"]; B* = pinned pane; all panes carry
// filters {}; "past n" = past.length; F_k = frame {trail, retained} after k scenario steps.
import { describe, expect, it } from "vitest";
import { initialInspectorState, reduceInspector } from "./inspector.ts";
import type { InspectorAction, InspectorFrame, InspectorState, PaneState } from "./inspector.ts";
import { ENT, P, WORLD, deepFreeze } from "../../test/helpers/nav-world.ts";

const S = (trail: PaneState[], retained: PaneState[] = [], past: InspectorFrame[] = []): InspectorState => ({ trail, retained, past });
const F = (trail: PaneState[], retained: PaneState[] = []): InspectorFrame => ({ trail, retained });
const step = (state: InspectorState, action: InspectorAction) => reduceInspector(state, action, WORLD);

// ---------------------------------------------------------------------------------------------
// The design's scenario: A -> B -> C, pin B, select a different child of A, switch a view, Back.
// ---------------------------------------------------------------------------------------------
// Frames (hand-derived, see each step):
//  F0 = {trail [], retained []}
//  step 1 open A@s1                        -> trail [A]                          retained []     past [F0]
//  step 2 select(0,"a-b")  a-b -> B        -> trail [A(a-b), B]                  retained []     past [F0,F1]
//  step 3 select(1,"b-c")  b-c -> C        -> trail [A(a-b), B(b-c), C]          retained []     past [F0..F2]
//  step 4 pin(1)                           -> trail [A(a-b), B*(b-c), C]         retained []     past [F0..F3]
//  step 5 select(0,"a-x")  a-x -> D        -> cut [B*, C]: B* pinned -> retained, C unpinned -> dropped
//                                             trail [A(a-x), D]                  retained [B*]   past [F0..F4]
//  step 6 switchView(0,"va-graph")         -> va-graph has no a-x: selection []; D untouched
//                                             trail [A(va-graph), D]             retained [B*]   past [F0..F5]
const F0 = F([]);
const F1 = F([P("A", "s1", "va-list")]);
const F2 = F([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")]);
const F3 = F([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list")]);
const F4 = F([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"], true), P("C", "s1", "vc-list")]);
const F5 = F([P("A", "s1", "va-list", ["a-x"]), P("D", "s1", "vd-list")], [P("B", "s1", "vb-list", ["b-c"], true)]);
const F6 = F([P("A", "s1", "va-graph", []), P("D", "s1", "vd-list")], [P("B", "s1", "vb-list", ["b-c"], true)]);
const FRAMES = [F0, F1, F2, F3, F4, F5, F6];
/** State after k steps: frame k with past = frames 0..k-1. */
const AFTER = (k: number): InspectorState => ({ trail: FRAMES[k]!.trail, retained: FRAMES[k]!.retained, past: FRAMES.slice(0, k) });

const SCENARIO: InspectorAction[] = [
  { type: "open", entity: ENT.A, snapshotId: "s1" },
  { type: "select", paneIndex: 0, itemId: "a-b" },
  { type: "select", paneIndex: 1, itemId: "b-c" },
  { type: "pin", paneIndex: 1 },
  { type: "select", paneIndex: 0, itemId: "a-x" },
  { type: "switchView", paneIndex: 0, viewDefinitionId: "va-graph" },
];

describe("the design scenario A -> B -> C, pin B, select another child of A, switch view, Back", () => {
  // why: MC7's headline route; every intermediate {trail, retained, past depth} is pinned, so a reducer that
  //      forgets to retain the pinned branch, keeps the unpinned descendant, or forgets history fails at the exact step.
  // proves: CLAIM(MC7)
  it("[MC7] each forward step yields the hand-derived state and no notice", () => {
    let state = initialInspectorState();
    expect(state, "initial state is empty").toStrictEqual(AFTER(0));
    SCENARIO.forEach((action, index) => {
      const outcome = step(state, action);
      expect(outcome.state, `after step ${index + 1} (${action.type})`).toStrictEqual(AFTER(index + 1));
      expect(outcome.notice, `step ${index + 1} has no notice`).toBeUndefined();
      state = outcome.state;
    });
  });

  // why: Back restores EXACTLY the previous {trail, retained}; starting from the literal final state (not from the
  //      forward run) keeps this independent of the forward direction. Walks all the way down to the empty state.
  // proves: CLAIM(MC7)
  it("[MC7] Back from the final state peels the six frames in reverse, then reports NOTHING_TO_GO_BACK", () => {
    let state = AFTER(6);
    for (let k = 5; k >= 0; k -= 1) {
      const outcome = step(state, { type: "back" });
      expect(outcome.state, `back to F${k}`).toStrictEqual(AFTER(k));
      expect(outcome.notice).toBeUndefined();
      state = outcome.state;
    }
    const empty = step(state, { type: "back" });
    expect(empty.state).toStrictEqual(AFTER(0));
    expect(empty.notice?.code).toBe("NOTHING_TO_GO_BACK");
  });

  // why: the retained branch must be the PINNED pane with its own selection, and Back must bring the unpinned C
  //      pane back too (it was dropped by step 5, not destroyed in history). This is the user-visible point of MC7.
  // proves: CLAIM(MC7)
  it("[MC7] after step 5 the pinned B survives in retained; one Back from step 6 keeps retained, two Backs bring C back", () => {
    const afterSwitch = AFTER(6);
    const once = step(afterSwitch, { type: "back" }).state;
    expect(once.retained.map((pane) => pane.entity.id)).toEqual(["B"]);
    expect(once.trail.map((pane) => pane.entity.id)).toEqual(["A", "D"]);
    const twice = step(once, { type: "back" }).state;
    expect(twice.trail.map((pane) => `${pane.entity.id}${pane.pinned ? "*" : ""}`)).toEqual(["A", "B*", "C"]);
    expect(twice.retained).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------------------------
describe("select", () => {
  // why: selecting an item with a target entity appends a pane for it (design section 3 "Selecting an inspectable
  //      item opens the next pane"); the new pane uses the entity's initial view and an empty selection.
  // proves: CLAIM(MC7)
  it("[MC7] an item with an entity appends a pane at its initial view; the source pane's selection becomes [item]", () => {
    const before = S([P("A", "s1", "va-list")], [], [F0]);
    const { state, notice } = step(before, { type: "select", paneIndex: 0, itemId: "a-b" });
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F0, F([P("A", "s1", "va-list")])]));
    expect(notice).toBeUndefined();
  });

  // why: contract section 4: the trail is cut to paneIndex+1 and UNPINNED cut panes are dropped (not retained).
  //      Negative control for the pinned case in the next test.
  // proves: CLAIM(MC7)
  it("[MC7] selecting in a middle pane drops unpinned descendants and keeps earlier panes", () => {
    const trail = [P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list")];
    const { state, notice } = step(S(trail), { type: "select", paneIndex: 1, itemId: "b-none" });
    // pane 1 selection [b-none] (no entity -> no new pane); cut = [C] unpinned -> dropped.
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-none"])], [], [F(trail)]));
    expect(notice?.code).toBe("NO_TARGET");
  });

  // why: same cut rule when the selection DOES open an entity: B re-selects b-c in the middle of A,B,C,A; the later panes are
  //      dropped and the freshly spawned C pane has an empty selection (the old C had c-a), so the trail ends [A,B,C].
  // proves: CLAIM(MC7)
  it("[MC7] selecting an entity item in a middle pane replaces everything after it with the new pane", () => {
    const trail = [P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list", ["c-a"]), P("A", "s1", "va-list")];
    const { state } = step(S(trail), { type: "select", paneIndex: 1, itemId: "b-c" });
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list")], [], [F(trail)]));
  });

  // why: an item WITHOUT an entity must not invent a pane, but the click is still a navigation step: selection set,
  //      descendants dropped, history pushed (contract: "NO_TARGET ... state still changed"). Pinned descendants go to retained.
  // proves: CLAIM(MC7)
  it("[MC7] NO_TARGET: selection set, unpinned descendants dropped, pinned descendants retained, history pushed, item named", () => {
    const trail = [P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"], true), P("C", "s1", "vc-list", ["c-a"]), P("A", "s1", "va-list")];
    const { state, notice } = step(S(trail), { type: "select", paneIndex: 0, itemId: "a-none" });
    // cut = [B*, C, A]: only B* is pinned -> retained [B*]; trail = [A(a-none)], no new pane.
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-none"])], [P("B", "s1", "vb-list", ["b-c"], true)], [F(trail)]));
    expect(notice?.code).toBe("NO_TARGET");
    expect(notice?.message).toContain("a-none");
  });

  // why: contract: pinned cut panes move to `retained` IN TRAIL ORDER, appended after what was already retained.
  //      A reducer that prepends, reverses or replaces retained fails.
  // proves: CLAIM(MC7)
  it("[MC7] pinned cut panes are appended to existing retained panes in trail order", () => {
    const trail = [P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"], true), P("C", "s1", "vc-list", ["c-a"]), P("A", "s1", "va-list", [], true)];
    const retained = [P("D", "s1", "vd-list", [], true)];
    const { state } = step(S(trail, retained), { type: "select", paneIndex: 0, itemId: "a-c" });
    expect(state).toStrictEqual(
      S([P("A", "s1", "va-list", ["a-c"]), P("C", "s1", "vc-list")], [P("D", "s1", "vd-list", [], true), P("B", "s1", "vb-list", ["b-c"], true), P("A", "s1", "va-list", [], true)], [F(trail, retained)]),
    );
  });

  // why: an unresolvable item is a named failure and must leave EVERYTHING alone (state, past); positive control
  //      is the same state with a resolvable item. The two further rows catch an itemTarget lookup against the wrong view.
  // proves: CLAIM(MC7)
  it.each([
    ["an item id that exists nowhere", [P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], 1, "ghost"],
    ["an item that exists only in another view of the same entity", [P("A", "s1", "va-graph")], 0, "a-x"],
    ["an item of another entity", [P("A", "s1", "va-list")], 0, "b-c"],
  ] as const)("[MC7] UNRESOLVED_TARGET leaves state and history untouched: %s", (_name, trail, paneIndex, itemId) => {
    const before = S([...trail], [], [F0]);
    const { state, notice } = step(before, { type: "select", paneIndex, itemId });
    expect(state).toStrictEqual(S([...trail], [], [F0]));
    expect(notice?.code).toBe("UNRESOLVED_TARGET");
    expect(notice?.message).toContain(itemId);
  });

  // why: negative control for the table above: the resolvable sibling DOES change the state, so the rows above are
  //      not unchanged merely because select never works.
  // proves: CLAIM(MC7)
  it("[MC7] a resolvable item in the same state does change it (control for UNRESOLVED_TARGET)", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F0]);
    const { state } = step(before, { type: "select", paneIndex: 1, itemId: "b-c" });
    expect(state.trail.map((pane) => pane.entity.id)).toEqual(["A", "B", "C"]);
    expect(state.past).toHaveLength(2);
  });

  // why: "Every action that changes {trail, retained} (by deep equality) pushes the previous frame": the converse is
  //      that an action which changes nothing must not grow history. Re-selecting the item whose child pane is untouched
  //      rebuilds an identical trail (B has no selection of its own); re-selecting when B has a selection changes it.
  // proves: CLAIM(MC7)
  it.each([
    ["child pane untouched: identical trail, no history entry", [], 1],
    ["child pane has its own selection: the rebuilt child pane differs, history entry pushed", ["b-c"], 2],
  ] as const)("[MC7] re-selecting the same item: %s", (_name, childSelection, expectedPast) => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", [...childSelection])], [], [F1]);
    const { state, notice } = step(before, { type: "select", paneIndex: 0, itemId: "a-b" });
    expect(state.trail).toStrictEqual([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")]);
    expect(state.past).toHaveLength(expectedPast);
    expect(notice).toBeUndefined();
  });

  // why: cyclic entity relations are legal and tracked, not deduplicated or refused (design section 3);
  //      A -> B -> C -> A yields FOUR panes and a four-deep history.
  // proves: CLAIM(MC7)
  it("[MC7] A -> B -> C -> A keeps the repeated entity as its own pane", () => {
    let state = S([P("A", "s1", "va-list")]);
    state = step(state, { type: "select", paneIndex: 0, itemId: "a-b" }).state;
    state = step(state, { type: "select", paneIndex: 1, itemId: "b-c" }).state;
    state = step(state, { type: "select", paneIndex: 2, itemId: "c-a" }).state;
    expect(state.trail).toStrictEqual([
      P("A", "s1", "va-list", ["a-b"]),
      P("B", "s1", "vb-list", ["b-c"]),
      P("C", "s1", "vc-list", ["c-a"]),
      P("A", "s1", "va-list"),
    ]);
    expect(state.past).toHaveLength(3);
  });

  // why: a select must change only selection of the source pane; filters, view and pinned flag of that pane survive.
  // proves: CLAIM(MC7)
  it("[MC7] the selecting pane keeps its filters, view and pinned flag", () => {
    const source: PaneState = { ...P("A", "s1", "va-graph", [], true), filters: { text: "x", limit: 3, tags: ["p", "q"] } };
    const { state } = step(S([source]), { type: "select", paneIndex: 0, itemId: "a-b" });
    expect(state.trail[0]).toStrictEqual({ ...source, selection: ["a-b"] });
    expect(state.trail[1]).toStrictEqual(P("B", "s1", "vb-list"));
  });
});

// ---------------------------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------------------------
describe("snapshots are never mixed", () => {
  // why: design section 3 "Navigation never silently mixes snapshots". B exists in s1 AND in the newer s2 with a
  //      different initial view (vb-list vs vb-s2). A pane opened from an s1 pane must be s1/vb-list; from an s2 pane s2/vb-s2.
  //      A reducer that resolves the target in the latest snapshot returns s2 for the first row.
  // proves: CLAIM(MC7)
  it.each([
    ["s1", "vb-list"],
    ["s2", "vb-s2"],
  ] as const)("[MC7] a pane spawned from an %s pane is an %s pane at that snapshot's initial view", (snapshotId, expectedView) => {
    const before = S([P("A", snapshotId, "va-list")]);
    const { state } = step(before, { type: "select", paneIndex: 0, itemId: "a-b" });
    expect(state.trail).toStrictEqual([P("A", snapshotId, "va-list", ["a-b"]), P("B", snapshotId, expectedView)]);
  });

  // why: the spawned pane inherits the SOURCE pane's snapshot, not the snapshot of the pane before it or of the
  //      trail root, when one trail legitimately holds panes of two snapshots (open s1, then a pane opened in s2).
  // proves: CLAIM(MC7)
  it("[MC7] in a mixed trail the new pane takes the snapshot of the pane it was selected in", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s2", "vb-s2")]);
    const { state } = step(before, { type: "select", paneIndex: 1, itemId: "b-c" });
    expect(state.trail[2]).toStrictEqual(P("C", "s2", "vc-list"));
    expect(state.trail[0]).toStrictEqual(P("A", "s1", "va-list", ["a-b"]));
  });

  // why: item existence is checked in the pane's own snapshot: a-x exists in s1's va-list but not in s2's, so the same
  //      selection is unresolved in an s2 pane (it must not fall through to the older or newer snapshot).
  // proves: CLAIM(MC7)
  it("[MC7] an item present in s1 but absent from s2 is UNRESOLVED_TARGET in an s2 pane", () => {
    const resolved = step(S([P("A", "s1", "va-list")]), { type: "select", paneIndex: 0, itemId: "a-x" });
    expect(resolved.notice).toBeUndefined();
    expect(resolved.state.trail.map((pane) => pane.entity.id)).toEqual(["A", "D"]);
    const unresolved = step(S([P("A", "s2", "va-list")]), { type: "select", paneIndex: 0, itemId: "a-x" });
    expect(unresolved.notice?.code).toBe("UNRESOLVED_TARGET");
    expect(unresolved.state).toStrictEqual(S([P("A", "s2", "va-list")]));
  });
});

// ---------------------------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------------------------
describe("open", () => {
  // why: contract section 4: view = preferred if the world has it, else the world's initial view. Positive control
  //      (available preference wins over B's initial vb-list) beside two fallbacks (an id B does not have: a view of
  //      another entity, and an id nobody has). A fallback is silent: no notice.
  // proves: CLAIM(MC7)
  it.each([
    ["no preference", undefined, "vb-list"],
    ["preferred view available", "vb-tree", "vb-tree"],
    ["preferred view belongs to another entity (unavailable here)", "va-graph", "vb-list"],
    ["preferred view id unknown everywhere", "nope", "vb-list"],
  ] as const)("[MC7] open B with %s", (_name, preferred, expectedView) => {
    const action: InspectorAction = preferred === undefined ? { type: "open", entity: ENT.B, snapshotId: "s1" } : { type: "open", entity: ENT.B, snapshotId: "s1", viewDefinitionId: preferred };
    const { state, notice } = step(initialInspectorState(), action);
    expect(state).toStrictEqual(S([P("B", "s1", expectedView)], [], [F0]));
    expect(notice).toBeUndefined();
  });

  // why: an entity with no view at all in that snapshot (Z is unknown; D does not exist in s2) cannot be opened:
  //      UNKNOWN_VIEW, state and history unchanged, the entity named. Even an explicit preference cannot rescue it.
  // proves: CLAIM(MC7)
  it.each([
    ["an entity absent from the world", ENT.Z, "s1", undefined],
    ["an entity present only in an older snapshot", ENT.D, "s2", undefined],
    ["a preference does not help an entity without views", ENT.Z, "s1", "vb-list"],
  ] as const)("[MC7] UNKNOWN_VIEW, state unchanged: %s", (_name, entity, snapshotId, preferred) => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F1]);
    const action: InspectorAction = preferred === undefined ? { type: "open", entity, snapshotId } : { type: "open", entity, snapshotId, viewDefinitionId: preferred };
    const { state, notice } = step(before, action);
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F1]));
    expect(notice?.code).toBe("UNKNOWN_VIEW");
    expect(notice?.message).toContain(entity.id);
  });

  // why: open replaces the trail but must not lose pinned panes: they move to `retained` in trail order AFTER the
  //      panes already retained; unpinned panes are dropped. The previous frame (with its trail) is pushed to history.
  // proves: CLAIM(MC7)
  it("[MC7] open keeps pinned trail panes in retained (after existing retained), drops unpinned, pushes history", () => {
    const trail = [P("A", "s1", "va-list", ["a-b"], true), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list", [], true)];
    const retained = [P("D", "s1", "vd-list", [], true)];
    const { state, notice } = step(S(trail, retained), { type: "open", entity: ENT.B, snapshotId: "s1" });
    expect(state).toStrictEqual(
      S([P("B", "s1", "vb-list")], [P("D", "s1", "vd-list", [], true), P("A", "s1", "va-list", ["a-b"], true), P("C", "s1", "vc-list", [], true)], [F(trail, retained)]),
    );
    expect(notice).toBeUndefined();
  });

  // why: opening exactly what is already shown changes nothing (deep equality), so it must not add a history frame.
  // proves: CLAIM(MC7)
  it("[MC7] opening the single pane that is already open pushes no history", () => {
    const before = S([P("A", "s1", "va-list")], [], [F0]);
    const { state, notice } = step(before, { type: "open", entity: ENT.A, snapshotId: "s1" });
    expect(state).toStrictEqual(S([P("A", "s1", "va-list")], [], [F0]));
    expect(notice).toBeUndefined();
  });

  // why: control for the previous test: the same entity at another snapshot is a different pane, so it IS a change.
  // proves: CLAIM(MC7)
  it("[MC7] opening the same entity at another snapshot replaces the pane and pushes history", () => {
    const before = S([P("A", "s1", "va-list")], [], [F0]);
    const { state } = step(before, { type: "open", entity: ENT.A, snapshotId: "s2" });
    expect(state).toStrictEqual(S([P("A", "s2", "va-list")], [], [F0, F([P("A", "s1", "va-list")])]));
  });
});

// ---------------------------------------------------------------------------------------------
// switchView
// ---------------------------------------------------------------------------------------------
describe("switchView", () => {
  // why: design section 3 "Changing tabs preserves the entity and its valid selection". a-b exists in va-graph, so it is
  //      kept; a-x does not, so it is dropped. Other panes (including their selection and pinned flag) and retained are untouched.
  // proves: CLAIM(MC7)
  it.each([
    ["the selected item exists in the new view: kept", ["a-b"], ["a-b"]],
    ["the selected item does not exist in the new view: dropped", ["a-x"], []],
    ["no selection stays empty", [], []],
  ] as const)("[MC7] switching A to va-graph, %s", (_name, selection, expectedSelection) => {
    const other = P("B", "s1", "vb-list", ["b-c"], true);
    const retained = [P("D", "s1", "vd-list", ["d-leaf"], true)];
    const before = S([P("A", "s1", "va-list", [...selection]), other], retained, [F0]);
    const { state, notice } = step(before, { type: "switchView", paneIndex: 0, viewDefinitionId: "va-graph" });
    expect(state).toStrictEqual(S([P("A", "s1", "va-graph", [...expectedSelection]), other], retained, [F0, F(before.trail, retained)]));
    expect(notice).toBeUndefined();
  });

  // why: switching only the LAST pane's view (index = trail.length - 1) and a middle pane both leave siblings alone; the
  //      middle pane's descendant is NOT cut (unlike select), per "other panes untouched".
  // proves: CLAIM(MC7)
  it("[MC7] switching a middle pane's view does not cut the panes after it", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list")]);
    const { state } = step(before, { type: "switchView", paneIndex: 1, viewDefinitionId: "vb-tree" });
    expect(state.trail).toStrictEqual([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-tree", ["b-c"]), P("C", "s1", "vc-list")]);
  });

  // why: a view the pane's entity does not have is UNKNOWN_VIEW and must not change anything; vb-list exists in the world
  //      but belongs to B, so it also must be refused for A (checks hasView is asked about THIS entity).
  // proves: CLAIM(MC7)
  it.each([
    ["an id nobody has", "ghost-view"],
    ["a real view of another entity", "vb-list"],
  ] as const)("[MC7] UNKNOWN_VIEW, state unchanged: %s", (_name, viewDefinitionId) => {
    const before = S([P("A", "s1", "va-list", ["a-b"])], [], [F0]);
    const { state, notice } = step(before, { type: "switchView", paneIndex: 0, viewDefinitionId });
    expect(state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"])], [], [F0]));
    expect(notice?.code).toBe("UNKNOWN_VIEW");
    expect(notice?.message).toContain(viewDefinitionId);
  });

  // why: switching to the view already shown is not a change (deep equality), so no history frame.
  // proves: CLAIM(MC7)
  it("[MC7] switching to the current view pushes no history", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"])], [], [F0]);
    const first = step(before, { type: "switchView", paneIndex: 0, viewDefinitionId: "va-graph" });
    expect(first.state.past).toHaveLength(2);
    const second = step(first.state, { type: "switchView", paneIndex: 0, viewDefinitionId: "va-graph" });
    expect(second.state).toStrictEqual(first.state);
    expect(second.notice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------------------------
describe("pin", () => {
  // why: pinning sets the flag on exactly that trail pane and records history once; pinning an already pinned pane is
  //      idempotent and must not push a second frame (contract: "already pinned: unchanged state").
  // proves: CLAIM(MC7)
  it("[MC7] pin sets the flag on that pane only, and pinning twice pushes no further history", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"]), P("C", "s1", "vc-list")], [], [F0]);
    const once = step(before, { type: "pin", paneIndex: 1 });
    expect(once.state).toStrictEqual(
      S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list", ["b-c"], true), P("C", "s1", "vc-list")], [], [F0, F(before.trail)]),
    );
    expect(once.notice).toBeUndefined();
    const twice = step(once.state, { type: "pin", paneIndex: 1 });
    expect(twice.state).toStrictEqual(once.state);
    expect(twice.state.past).toHaveLength(2);
  });

  // why: pinning must keep the pane's other fields (filters, selection, view).
  // proves: CLAIM(MC7)
  it("[MC7] pin keeps filters and selection", () => {
    const pane: PaneState = { ...P("B", "s1", "vb-tree", ["b-c"]), filters: { text: "q" } };
    const { state } = step(S([pane]), { type: "pin", paneIndex: 0 });
    expect(state.trail[0]).toStrictEqual({ ...pane, pinned: true });
  });

  // why: pinning then Back un-pins: pin is a history-producing change like any other.
  // proves: CLAIM(MC7)
  it("[MC7] Back after pin restores the unpinned pane", () => {
    const start = S([P("A", "s1", "va-list")], [], [F0]);
    const pinned = step(start, { type: "pin", paneIndex: 0 }).state;
    expect(pinned.trail[0]?.pinned, "control: the pin took effect").toBe(true);
    const back = step(pinned, { type: "back" }).state;
    expect(back).toStrictEqual(start);
  });
});

// ---------------------------------------------------------------------------------------------
// back
// ---------------------------------------------------------------------------------------------
describe("back", () => {
  // why: with no history Back is a named no-op; a non-empty trail with an empty past is the sharper case (a reducer that
  //      "goes back" to an empty frame would wipe the visible trail).
  // proves: CLAIM(MC7)
  it.each([
    ["the initial state", initialInspectorState()],
    ["a visible trail but no history", S([P("A", "s1", "va-list")])],
  ] as const)("[MC7] NOTHING_TO_GO_BACK on %s", (_name, before) => {
    const { state, notice } = step(before, { type: "back" });
    expect(state).toStrictEqual(before);
    expect(notice?.code).toBe("NOTHING_TO_GO_BACK");
  });

  // why: Back restores the frame including `retained` (here the pinned D that open moved out of the trail), and consumes
  //      exactly one past frame; it must not push the abandoned frame as new history.
  // proves: CLAIM(MC7)
  it("[MC7] Back after open restores trail AND retained and pops exactly one frame", () => {
    const trail = [P("D", "s1", "vd-list", ["d-leaf"], true), P("A", "s1", "va-list")];
    const retained = [P("C", "s1", "vc-list", [], true)];
    const opened = step(S(trail, retained, [F0]), { type: "open", entity: ENT.B, snapshotId: "s1" }).state;
    expect(opened.retained.map((pane) => pane.entity.id)).toEqual(["C", "D"]);
    const back = step(opened, { type: "back" });
    expect(back.state).toStrictEqual(S(trail, retained, [F0]));
    expect(back.notice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// purity and unknown actions
// ---------------------------------------------------------------------------------------------
describe("purity", () => {
  // why: the reducer is pure (header of inspector.ts). Inputs are deep-frozen, so any in-place mutation throws a
  //      TypeError in this strict-mode module; a JSON snapshot taken before is compared after as a second line of
  //      defence (a mutation of a non-frozen alias would still be seen). Runs the whole scenario, forward and back,
  //      plus the refusal paths, because refusals are where "restore from a mutated copy" bugs hide.
  // proves: CLAIM(MC7)
  it("[MC7] no action mutates its input state or action", () => {
    const actions: InspectorAction[] = [
      ...SCENARIO,
      { type: "select", paneIndex: 9, itemId: "a-b" },
      { type: "select", paneIndex: 0, itemId: "ghost" },
      { type: "select", paneIndex: 0, itemId: "a-none" },
      { type: "switchView", paneIndex: 0, viewDefinitionId: "ghost-view" },
      { type: "pin", paneIndex: 0 },
      { type: "open", entity: ENT.Z, snapshotId: "s1" },
      { type: "open", entity: ENT.C, snapshotId: "s2", viewDefinitionId: "vc-list" },
      { type: "back" },
      { type: "back" },
    ];
    let state = deepFreeze(initialInspectorState());
    for (const action of actions) {
      const frozenAction = deepFreeze(structuredClone(action));
      const stateBefore = JSON.stringify(state);
      const outcome = step(state, frozenAction);
      expect(JSON.stringify(state), `${action.type} left its input state untouched`).toBe(stateBefore);
      expect(JSON.stringify(frozenAction)).toBe(JSON.stringify(action));
      state = deepFreeze(structuredClone(outcome.state));
    }
    // Trace after the scenario (state_6): select(9) NO_SUCH_PANE, select ghost UNRESOLVED, select a-none UNRESOLVED
    // (a-none is not in va-graph), switchView ghost UNKNOWN_VIEW, pin(0) +1 frame, open Z UNKNOWN_VIEW, open C@s2 +1 frame,
    // back, back -> exactly state_6 again. A non-trivial round trip, so the run is not vacuous.
    expect(state).toStrictEqual(AFTER(6));
  });

  // why: design section 3 / red-contract section 4: "Tree expansion is not an action: it never creates a pane". The reducer
  //      therefore has no expand action; an expand-shaped action handed to it (from untyped code) must be IGNORED
  //      visibly - state returned unchanged, a notice that names the ignored action type - and spawn no pane.
  //      The DOM-level "expanding a tree row does not spawn a pane" is asserted in the dom agent's slice, not here.
  // proves: CLAIM(MC7)
  it("[MC7] an unknown 'expand' action leaves the state unchanged with a notice naming it", () => {
    const before = S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F0, F1]);
    const outcome = step(before, { type: "expand", paneIndex: 0, itemId: "a-b" } as unknown as InspectorAction);
    expect(outcome.state).toStrictEqual(S([P("A", "s1", "va-list", ["a-b"]), P("B", "s1", "vb-list")], [], [F0, F1]));
    expect(outcome.notice, "a notice is reported").toBeDefined();
    expect(outcome.notice?.message).toContain("expand");
  });
});

// ---------------------------------------------------------------------------------------------
// out-of-range pane indexes
// ---------------------------------------------------------------------------------------------
describe("pane index range", () => {
  const ACTIONS: Array<[string, (paneIndex: number) => InspectorAction]> = [
    ["select", (paneIndex) => ({ type: "select", paneIndex, itemId: "a-b" })],
    ["switchView", (paneIndex) => ({ type: "switchView", paneIndex, viewDefinitionId: "va-graph" })],
    ["pin", (paneIndex) => ({ type: "pin", paneIndex })],
  ];
  // why: an index outside [0, trail.length) is NO_SUCH_PANE for every pane-addressed action, state and history unchanged.
  //      Rows: one past the end (2 = trail length), far past the end, negative. The in-range control at index 1
  //      for the same action proves the action itself works in that state.
  // proves: CLAIM(MC7)
  describe.each(ACTIONS)("%s", (name, make) => {
    it.each([2, 7, -1] as const)(`[MC7] ${name} at index %i is NO_SUCH_PANE; nothing changes`, (paneIndex) => {
      const before = S([P("A", "s1", "va-list"), P("B", "s1", "vb-list")], [P("D", "s1", "vd-list", [], true)], [F0]);
      const { state, notice } = step(before, make(paneIndex));
      expect(state).toStrictEqual(S([P("A", "s1", "va-list"), P("B", "s1", "vb-list")], [P("D", "s1", "vd-list", [], true)], [F0]));
      expect(notice?.code).toBe("NO_SUCH_PANE");
      expect(notice?.message).toContain(String(paneIndex));
    });
  });
  // why: control for the table above - index 1 is valid for pin and switchView on this trail (select's item belongs to A, so it
  //      is checked at index 0), so the refusals are about the index, not about the action or the world.
  // proves: CLAIM(MC7)
  it("[MC7] the same actions at a valid index succeed", () => {
    const before = S([P("A", "s1", "va-list"), P("B", "s1", "vb-list")]);
    expect(step(before, { type: "pin", paneIndex: 1 }).state.trail[1]?.pinned).toBe(true);
    expect(step(before, { type: "switchView", paneIndex: 1, viewDefinitionId: "vb-tree" }).state.trail[1]?.viewDefinitionId).toBe("vb-tree");
    expect(step(before, { type: "select", paneIndex: 0, itemId: "a-c" }).state.trail.map((pane) => pane.entity.id)).toEqual(["A", "C"]);
  });
  // why: on an empty trail every index is out of range (a reducer that special-cases index 0 as "the root" fails).
  // proves: CLAIM(MC7)
  it("[MC7] index 0 on an empty trail is NO_SUCH_PANE", () => {
    const outcome = step(initialInspectorState(), { type: "pin", paneIndex: 0 });
    expect(outcome.state).toStrictEqual(initialInspectorState());
    expect(outcome.notice?.code).toBe("NO_SUCH_PANE");
  });
});
