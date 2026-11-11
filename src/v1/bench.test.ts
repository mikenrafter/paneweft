// The teaching-benchmark harness, deterministic (S9): role orchestration with mocked models, the student's context, conditions,
// scoring by question kind, calibration, planted-error detection and topic admission. No real model is ever called.
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { validateAgainstV1 } from "./schemas.ts";
import { QUESTION_KINDS, calibration, runBenchmark, validateTopic, type Condition, type HarnessConfig, type Model, type ModelCall } from "./bench.ts";

const fixture = loadFixture<any>("v1/benchmark/vigil-keepalive.topic.json");
const KINDS = fixture.questions.map((q: any) => q.kind);
const textOf = (call: ModelCall): string => call.messages.map((m) => m.content).join("\n");

interface Mocks { models: HarnessConfig["models"]; calls: ModelCall[] }
function mocks(options: { correct?: boolean[]; confidence?: number[]; flagged?: string[]; graderFamily?: string; badConfidence?: number } = {}): Mocks {
  const calls: ModelCall[] = [];
  const correct = options.correct ?? [true, true, false, true, false, true, false];
  const confidence = options.confidence ?? [90, 80, 95, 60, 85, 70, 40];
  let graded = 0;
  const authorOutput = JSON.stringify({ questions: fixture.questions, keys: fixture.keys });
  const model = (family: string, reply: (call: ModelCall) => string): Model => ({ family, complete: async (call) => { calls.push(call); return reply(call); } });
  const models: HarnessConfig["models"] = {
    "question-author": model("claude", () => authorOutput),
    student: model("claude", (call) => {
      const index = fixture.questions.findIndex((q: any) => textOf(call).includes(q.text));
      return JSON.stringify({ text: `answer-${index}`, confidence: options.badConfidence ?? confidence[index], ...(options.flagged ? { flaggedErrors: options.flagged } : {}) });
    }),
    grader: model(options.graderFamily ?? "claude", () => JSON.stringify({ correct: correct[graded++] })),
  };
  return { models, calls };
}
const config = (m: Mocks, over: Partial<HarnessConfig> = {}): HarnessConfig => ({ topic: fixture.topic, condition: "D", material: fixture.material, code: fixture.code, models: m.models, ...over });

describe("[S9] role orchestration and the student's context", () => {
  // why: S9 / research note 13. The question author is BLIND to the views and sees only code; the student gets only the view material
  // and ONE question at a time, with no tools and no files and no key; the grader sees question, key and answer but no material.
  // The sentinels make each statement checkable; every "absent" has a positive control in the same test.
  // proves: CLAIM(S9-harness) CLAIM(S9-student-context)
  it("keeps each role's context separate", async () => {
    const m = mocks();
    const run = must(await runBenchmark(config(m)), "run");
    const author = m.calls.filter((c) => c.role === "question-author");
    expect(author).toHaveLength(1);
    expect(textOf(author[0]!)).toContain("CODE-SENTINEL");
    for (const leak of ["VIEW-MATERIAL", "TRAIL-MATERIAL"]) expect(textOf(author[0]!), leak).not.toContain(leak);
    const students = m.calls.filter((c) => c.role === "student");
    expect(students).toHaveLength(7);
    students.forEach((call, index) => {
      expect(call.tools, "no tools").toEqual([]);
      expect(call.files, "no file access").toBeNull();
      const text = textOf(call);
      expect(text).toContain("VIEW-MATERIAL");
      expect(text, "the question is asked").toContain(fixture.questions[index].text);
      fixture.questions.forEach((q: any, other: number) => { if (other !== index) expect(text, `question ${other} must not be visible in call ${index}`).not.toContain(q.text); });
      for (const key of fixture.keys) expect(text, "answer keys never reach the student").not.toContain(key.answer);
      expect(text).not.toContain("CODE-SENTINEL");
    });
    const graders = m.calls.filter((c) => c.role === "grader");
    expect(graders).toHaveLength(7);
    expect(textOf(graders[0]!)).toContain("tick and a redelivered flag");
    expect(textOf(graders[0]!)).toContain("answer-0");
    expect(textOf(graders[0]!)).not.toContain("VIEW-MATERIAL");
    expect(run.transcript.map((c) => c.role)).toEqual(["question-author", ...Array(7).fill(["student", "grader"]).flat()]);
  });

  // why: S9. The student must have no tools and no file access: asking for either is refused by the harness, not silently ignored.
  // proves: CLAIM(S9-student-context)
  it.each([[{ tools: [{ name: "read_file" }] }], [{ files: ["/repo/src/watch.rs"] }]])("refuses a student with capabilities %j", async (student) => {
    const error = mustFail(await runBenchmark(config(mocks(), { student })), "refused");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toMatch(/no tools|no file/i);
  });

  // why: S9 / research note 13 conditions: what the student receives per condition is pinned by hand (A nothing, B code, C prose,
  // D view text, E screenshots only, F text and screenshots, G the misleading view, H F plus the trail).
  // proves: CLAIM(S9-harness)
  it.each<[Condition, { has: string[]; hasNot: string[]; attachments: string[] }]>([
    ["A", { has: [], hasNot: ["CODE-SENTINEL", "VIEW-MATERIAL", "PROSE-MATERIAL", "TRAIL-MATERIAL"], attachments: [] }],
    ["B", { has: ["CODE-SENTINEL"], hasNot: ["VIEW-MATERIAL", "PROSE-MATERIAL", "TRAIL-MATERIAL"], attachments: [] }],
    ["C", { has: ["PROSE-MATERIAL"], hasNot: ["CODE-SENTINEL", "VIEW-MATERIAL", "TRAIL-MATERIAL"], attachments: [] }],
    ["D", { has: ["VIEW-MATERIAL"], hasNot: ["CODE-SENTINEL", "PROSE-MATERIAL", "TRAIL-MATERIAL"], attachments: [] }],
    ["E", { has: [], hasNot: ["VIEW-MATERIAL", "CODE-SENTINEL", "TRAIL-MATERIAL"], attachments: ["shot-1.png"] }],
    ["F", { has: ["VIEW-MATERIAL"], hasNot: ["CODE-SENTINEL", "TRAIL-MATERIAL"], attachments: ["shot-1.png"] }],
    ["G", { has: ["VIEW-MATERIAL (planted)"], hasNot: ["CODE-SENTINEL", "TRAIL-MATERIAL"], attachments: [] }],
    ["H", { has: ["VIEW-MATERIAL", "TRAIL-MATERIAL"], hasNot: ["CODE-SENTINEL"], attachments: ["shot-1.png"] }],
  ])("condition %s", async (condition, expectation) => {
    const m = mocks();
    must(await runBenchmark(config(m, { condition, material: { ...fixture.material, prose: "PROSE-MATERIAL", screenshots: ["shot-1.png"] } })), "run");
    const first = m.calls.find((c) => c.role === "student")!;
    for (const needle of expectation.has) expect(textOf(first), needle).toContain(needle);
    for (const needle of expectation.hasNot) expect(textOf(first), needle).not.toContain(needle);
    expect(first.attachments).toEqual(expectation.attachments);
    if (condition === "A") expect(textOf(first)).toContain(fixture.topic.title);
  });
});

describe("[S9] scoring", () => {
  // why: S9. Accuracy by question kind, from the grader's verdicts [t,t,f,t,f,t,f] over the seven kinds, and calibration: Brier is the
  // mean of (confidence/100 - correct)^2 = 2.085 / 7 = 0.2978571...; wrong answers given at confidence >= 80: locate (95), counterfactual (85) = 2.
  // proves: CLAIM(S9-harness)
  it("computes accuracy by kind and calibration with hand-computed numbers", async () => {
    const run = must(await runBenchmark(config(mocks())), "run");
    expect(run.summary.accuracyByKind).toEqual({ recall: { correct: 1, total: 1 }, trace: { correct: 1, total: 1 }, locate: { correct: 0, total: 1 }, causal: { correct: 1, total: 1 }, counterfactual: { correct: 0, total: 1 }, boundary: { correct: 1, total: 1 }, "why-not": { correct: 0, total: 1 } });
    expect(run.summary.calibration.brier).toBeCloseTo(2.085 / 7, 6);
    expect(run.summary.calibration.overconfidentWrong).toBe(2);
    expect(run.scores.map((s) => [s.questionId, s.correct, s.confidence])).toEqual([["q-recall", true, 90], ["q-trace", true, 80], ["q-locate", false, 95], ["q-causal", true, 60], ["q-counterfactual", false, 85], ["q-boundary", true, 70], ["q-why-not", false, 40]]);
  });

  it("the calibration function alone agrees (and a perfectly calibrated, correct set has Brier 0.25 at 50)", () => {
    expect(calibration([{ correct: true, confidence: 90 }, { correct: false, confidence: 85 }]).brier).toBeCloseTo((0.01 + 0.7225) / 2, 6);
    expect(calibration([{ correct: true, confidence: 50 }, { correct: false, confidence: 50 }])).toEqual({ brier: 0.25, overconfidentWrong: 0 });
  });

  // why: S9 planted-error detection (condition G): the student flagging the planted claim id is a detection; not flagging it is a miss;
  // other conditions have no planted error (null).
  // proves: CLAIM(S9-planted-error)
  it("detects a flagged planted error in condition G only", async () => {
    expect(must(await runBenchmark(config(mocks({ flagged: ["planted-1"] }), { condition: "G" })), "G flagged").summary.plantedErrorDetected).toBe(true);
    expect(must(await runBenchmark(config(mocks(), { condition: "G" })), "G missed").summary.plantedErrorDetected).toBe(false);
    expect(must(await runBenchmark(config(mocks({ flagged: ["planted-1"] }), { condition: "D" })), "D").summary.plantedErrorDetected).toBeNull();
  });

  // why: S9. Confidence is an integer 0-100; the harness records what the student said and refuses an out-of-range value instead of
  // clamping it (a clamped 150 would hide a miscalibrated student).
  // proves: CLAIM(S9-harness)
  it.each([150, -1, 55.5])("refuses confidence %s", async (badConfidence) => {
    const error = mustFail(await runBenchmark(config(mocks({ badConfidence }))), "bad confidence");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.errors[0]!.pointer).toMatch(/confidence/);
  });

  // why: research note 13 risk: teacher and grader from one family share blind spots. The harness records whether grading was done by
  // the same family as the question author/student, rather than hiding it.
  // proves: CLAIM(S9-harness)
  it("flags same-family grading", async () => {
    expect(must(await runBenchmark(config(mocks())), "same").summary.sameFamilyGrading).toBe(true);
    expect(must(await runBenchmark(config(mocks({ graderFamily: "codex" }))), "different").summary.sameFamilyGrading).toBe(false);
  });

  // why: determinism: same mocks, same run (transcript and summary); a flaky harness could not be a regression suite.
  // proves: CLAIM(S9-harness)
  it("is deterministic", async () => {
    const one = must(await runBenchmark(config(mocks())), "one");
    const two = must(await runBenchmark(config(mocks())), "two");
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

describe("[S9] topic admission", () => {
  const material = fixture.material;
  // why: S9. The pinned pilot topic is schema-valid, covers all seven question kinds, and is admissible: its planted error is detectable
  // from the planted material and its why-not key cites the trail. (The schema part is also a scaffold self-check.)
  // proves: CLAIM(S9-harness) CLAIM(S9-planted-error)
  it("admits the pinned vigil topic and covers all seven kinds", () => {
    expect(KINDS.sort()).toEqual([...QUESTION_KINDS].sort());
    expect(fixture.topic.title).toBe("Where can a keepalive result stop being delivered?");
    for (const doc of [fixture.topic, ...fixture.questions, ...fixture.keys]) expect(validateAgainstV1("urn:paneweft:schema:v1:benchmark:1", doc), doc.id ?? doc.questionId).toEqual([]);
    expect(must(validateTopic(fixture.topic, fixture.keys, { text: material.planted, trail: material.trail }), "admit")).toBe(true);
  });

  // why: S9. A planted error that the supplied material does not contradict is undetectable: admitting it would make the detection
  // rate meaningless. The pointer names the planted error.
  // proves: CLAIM(S9-planted-error)
  it("refuses an undetectable planted error", () => {
    const error = mustFail(validateTopic(fixture.topic, fixture.keys, { text: "VIEW-MATERIAL says nothing relevant", trail: material.trail }), "undetectable");
    expect(error.errors.map((e) => e.pointer)).toContain("/plantedErrors/0/contradictedBy");
  });

  // why: S9. A why-not key must cite a trail entry or other recorded evidence, not code alone: code cannot show why an alternative was
  // abandoned.
  // proves: CLAIM(S9-why-not)
  it("refuses a why-not key that cites code alone", () => {
    const keys = structuredClone(fixture.keys);
    keys.find((k: any) => k.questionId === "q-why-not").citations = [{ kind: "code", ref: "src/write-lock.ts:1" }];
    const error = mustFail(validateTopic(fixture.topic, keys, { text: material.planted, trail: material.trail }), "code only");
    expect(error.errors.map((e) => e.pointer)).toContain("/keys/6/citations");
  });
});
