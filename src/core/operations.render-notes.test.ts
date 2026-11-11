// T6 (tier-2 review): the validator can attach non-fatal notes to a valid document (`ValidationReport.notes`); `validate` printed them, but `render`
// (importBundle / putView) dropped them and always answered `validation: { valid: true, notes: [] }`. The notes are carried through the session's import
// summary into the render reply, in both formats, bounded.
// The real validator emits no notes today, so these tests wrap validateSubmission to add known ones to a valid document; what is pinned is that render
// reports exactly what the validator reported (and agrees with the `validate` operation), not which rule produces a note.
// proves: CLAIM(render-reports-notes) CLAIM(bounded-exit)
import { describe, expect, it, vi } from "vitest";
import { bundleFixture } from "../../test/helpers/store-session.ts";
import { useOps } from "../../test/helpers/ops-env.ts";
import { allBundle } from "../../test/helpers/fixtures.ts";

const injected = vi.hoisted(() => ({ notes: [] as Array<{ pointer: string; message: string }> }));
vi.mock("./validate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./validate.ts")>();
  return {
    ...actual,
    validateSubmission: (input: unknown, context?: unknown) => {
      const report = actual.validateSubmission(input, context as never);
      return report.ok && injected.notes.length > 0 ? { ...report, notes: injected.notes } : report;
    },
  };
});

const open = useOps();
const NOTES = [
  { pointer: "/views/0/title", message: "title is long for a pane header" },
  { pointer: "/entities/1", message: "entity has no relations" },
];
const withNotes = (notes: Array<{ pointer: string; message: string }>) => { injected.notes = notes; };
const modulesView = () => (bundleFixture().views as unknown as Array<Record<string, unknown>>).find((view) => view.id === "modules");

describe("render reports the validator's notes (T6)", () => {
  // why: the finding. JSON form: validation.notes is the validator's list, in order, with valid: true.
  it("[T6] render of a bundle (JSON) carries the notes", async () => {
    withNotes(NOTES);
    const { call } = await open();
    const outcome = await call("render", { input: allBundle(), format: "json" });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(outcome.body);
    expect(body.validation).toEqual({ valid: true, notes: NOTES });
  });

  // why: text form: one `note: <pointer>: <message>` line per note, the same wording `validate` uses, before the reply header.
  it("[T6] render of a bundle (text) prints a note line per note, in the validate wording", async () => {
    withNotes(NOTES);
    const { call } = await open();
    const outcome = await call("render", { input: allBundle() });
    const lines = outcome.body.split("\n");
    expect(lines).toContain("note: /views/0/title: title is long for a pane header");
    expect(lines).toContain("note: /entities/1: entity has no relations");
    expect(lines.indexOf("note: /entities/1: entity has no relations")).toBeLessThan(lines.findIndex((line) => line.startsWith("paneweft.reply/1")));
  });

  // why: putView is the other path into render (a single envelope); it must report notes too.
  it("[T6] render of a single envelope (putView) carries the notes", async () => {
    const { call, session } = await open();
    withNotes([]);
    expect((await session.importBundle({ ...allBundle(), views: [] })).ok).toBe(true); // entities + definitions first, so the envelope validates alone
    withNotes([NOTES[0] as (typeof NOTES)[number]]);
    const outcome = await call("render", { input: modulesView(), format: "json" });
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.body).validation).toEqual({ valid: true, notes: [NOTES[0]] });
  });

  // why: parity. `validate` and `render` of the same document report the same notes, since both come from the validator.
  it("[T6] render and validate report identical notes for one input", async () => {
    withNotes(NOTES);
    const { call } = await open();
    const validated = JSON.parse((await call("validate", { input: allBundle(), format: "json" })).body);
    const rendered = JSON.parse((await call("render", { input: allBundle(), format: "json" })).body);
    expect(rendered.validation.notes).toEqual(validated.notes);
  });

  // why: control. A document with no notes keeps the empty list and prints no note line (nothing is invented).
  it("[T6] without notes: validation.notes is [] and no note line is printed", async () => {
    withNotes([]);
    const { call } = await open();
    expect(JSON.parse((await call("render", { input: allBundle(), format: "json" })).body).validation).toEqual({ valid: true, notes: [] });
    const text = (await call("render", { input: { ...allBundle(), views: [] } })).body;
    expect(text).not.toMatch(/^note:/m);
  });

  // why: bounded exit. Many notes cannot push the reply over its budget: at most 20 are listed, the rest are counted, and the JSON still parses.
  it("[T6] 50 notes are capped at 20 listed plus a count, within a 2048-byte budget", async () => {
    withNotes(Array.from({ length: 50 }, (_, index) => ({ pointer: `/views/0/n${index}`, message: "m" })));
    const { call } = await open();
    const json = await call("render", { input: allBundle(), format: "json", maxBytes: 2048 });
    expect(json.ok).toBe(true);
    expect(Buffer.byteLength(json.body)).toBeLessThanOrEqual(2048);
    const validation = JSON.parse(json.body).validation;
    expect(validation.notes).toHaveLength(20);
    expect(validation.omitted).toBe(30);
    const text = await call("render", { input: allBundle(), maxBytes: 4096 });
    expect(Buffer.byteLength(text.body)).toBeLessThanOrEqual(4096);
    expect(text.body.split("\n").filter((line) => line.startsWith("note: "))).toHaveLength(20);
    expect(text.body).toContain("(+30 more notes)");
  });
});
