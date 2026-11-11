// The deterministic teaching-benchmark harness (spec S9; research note 13): role orchestration with mocked models, schemas,
// no-tool/no-file student context, planted-error detection, why-not keys citing recorded evidence. No model is called by default.
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Benchmark } from "../generated/v1/Benchmark.ts";
import { validateAgainstV1 } from "./schemas.ts";

export type Role = "teacher" | "question-author" | "student" | "examiner" | "grader";
export type Condition = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
export type QuestionKind = "recall" | "trace" | "locate" | "causal" | "counterfactual" | "boundary" | "why-not";
export const QUESTION_KINDS: readonly QuestionKind[] = ["recall", "trace", "locate", "causal", "counterfactual", "boundary", "why-not"];

/** Exactly what one model call is given. The student's call is checked by the harness: no tools, no files. */
export interface ModelCall {
  role: Role;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  tools: unknown[];
  files: string[] | null;
  attachments: string[];
}
export interface Model {
  family: string;
  complete(call: ModelCall): Promise<string>;
}

export interface HarnessConfig {
  topic: unknown;
  condition: Condition;
  /** What each condition draws from (research note 13): `prose` is condition C, `text`/`screenshots` D-F, `planted` G, `trail` H. */
  material: { prose?: string; text?: string; screenshots?: string[]; planted?: string; trail?: string };
  /** Source excerpts for the question author and condition B. */
  code: Array<{ path: string; text: string }>;
  /** The examiner is harness code, not a model. The teacher is only called when no material is supplied. */
  models: { teacher?: Model; "question-author": Model; student: Model; grader: Model };
  /** The capabilities someone asks the student to have. Any tool or file is refused: the student is context-only. */
  student?: { tools?: unknown[]; files?: string[] };
}

type Question = Extract<Benchmark, { schemaVersion: "paneweft.benchmark-question/1" }>;
type Score = Extract<Benchmark, { schemaVersion: "paneweft.benchmark-score/1" }>;
type Key = Extract<Benchmark, { schemaVersion: "paneweft.benchmark-key/1" }>;

export interface BenchmarkRun {
  topicId: string;
  condition: Condition;
  questions: Question[];
  scores: Score[];
  summary: {
    accuracyByKind: Record<string, { correct: number; total: number }>;
    calibration: { brier: number; overconfidentWrong: number };
    plantedErrorDetected: boolean | null;
    sameFamilyGrading: boolean;
  };
  transcript: ModelCall[];
}

const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });
const BENCHMARK = "urn:paneweft:schema:v1:benchmark:1";

/** Brier score (confidence/100 against correctness) and the count of wrong answers given with confidence >= 80. */
export function calibration(scores: Array<{ correct: boolean; confidence: number }>): { brier: number; overconfidentWrong: number } {
  if (scores.length === 0) return { brier: 0, overconfidentWrong: 0 };
  const brier = scores.reduce((sum, score) => sum + (score.confidence / 100 - (score.correct ? 1 : 0)) ** 2, 0) / scores.length;
  return { brier, overconfidentWrong: scores.filter((score) => !score.correct && score.confidence >= 80).length };
}

/** A topic is admissible when every planted error is detectable from the supplied material (its `contradictedBy` evidence appears in
 * `material`) and every why-not key cites a trail entry or other recorded evidence, not code alone. A key carries no kind of its own: it
 * belongs to the QUESTION it answers, and the question's `kind` decides (S21). A question's id is a name and says nothing about its kind. */
export function validateTopic(topic: unknown, keys: unknown[], material: { text?: string; trail?: string }, questions: unknown[]): Result<true> {
  const shape = validateAgainstV1(BENCHMARK, topic);
  if (shape.length > 0) return err("VALIDATION_FAILED", "the topic does not match paneweft.benchmark-topic/1", { errors: shape });
  const document = topic as Extract<Benchmark, { schemaVersion: "paneweft.benchmark-topic/1" }>;
  const issues: ValidationIssue[] = [];
  document.plantedErrors.forEach((planted, index) => {
    const missing = planted.contradictedBy.filter((evidence) => !(material.text ?? "").includes(evidence));
    if (missing.length > 0) issues.push(issue("CONSTRAINT", `/plantedErrors/${index}/contradictedBy`, "the contradicting evidence appears in the material the student receives", `The planted error "${planted.id}" cannot be detected: ${missing.map((evidence) => JSON.stringify(evidence)).join(", ")} is not in the supplied material. An undetectable planted error makes the detection rate meaningless.`));
  });
  keys.forEach((key, index) => {
    const checked = validateAgainstV1(BENCHMARK, key);
    if (checked.length > 0) {
      issues.push(...checked.map((fault) => ({ ...fault, pointer: `/keys/${index}${fault.pointer}` })));
      return;
    }
    const typed = key as Key;
    const question = questions.find((candidate) => (candidate as { id?: unknown } | null)?.id === typed.questionId) as { kind?: string } | undefined;
    if (question === undefined) {
      issues.push(issue("DANGLING_REFERENCE", `/keys/${index}/questionId`, "a key answers a question of the topic", `No question "${typed.questionId}" was authored, so this key cannot be checked against a kind.`));
      return;
    }
    if (question.kind === "why-not" && !typed.citations.some((citation) => citation.kind === "trail" || citation.kind === "recorded-evidence")) {
      issues.push(issue("CONSTRAINT", `/keys/${index}/citations`, "a why-not key cites a trail entry or other recorded evidence", "Code shows what the system does, not why an alternative was abandoned; cite the trail entry or the recorded evidence."));
    }
  });
  const keyed = new Set(keys.map((key) => (key as { questionId?: string }).questionId));
  document.questionIds.forEach((id, index) => {
    if (!keyed.has(id)) issues.push(issue("DANGLING_REFERENCE", `/questionIds/${index}`, "every question has an answer key", `No key for "${id}".`));
  });
  return issues.length > 0 ? err("VALIDATION_FAILED", `the topic is not admissible (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues }) : ok(true);
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function studentMaterial(config: HarnessConfig): { text: string; attachments: string[] } {
  const { condition, material, code } = config;
  const screenshots = material.screenshots ?? [];
  switch (condition) {
    case "A": return { text: "", attachments: [] };
    case "B": return { text: code.map((file) => `// ${file.path}\n${file.text}`).join("\n\n"), attachments: [] };
    case "C": return { text: material.prose ?? "", attachments: [] };
    case "D": return { text: material.text ?? "", attachments: [] };
    case "E": return { text: "", attachments: screenshots };
    case "F": return { text: material.text ?? "", attachments: screenshots };
    case "G": return { text: material.planted ?? "", attachments: [] };
    case "H": return { text: [material.text ?? "", material.trail ?? ""].filter((part) => part.length > 0).join("\n\n"), attachments: screenshots };
  }
}

/** Assigns roles, feeds the student only its material, asks one question at a time, records answer + confidence, grades. */
export async function runBenchmark(config: HarnessConfig): Promise<Result<BenchmarkRun>> {
  if ((config.student?.tools ?? []).length > 0) return err("INVALID_ARGUMENT", "the student has no tools: it answers from the supplied material alone", { errors: [issue("FORBIDDEN_PROPERTY", "/student/tools", "the student context has no tools", "Remove the tools; the benchmark measures what the material teaches.")] });
  if ((config.student?.files ?? []).length > 0) return err("INVALID_ARGUMENT", "the student has no file access: it answers from the supplied material alone", { errors: [issue("FORBIDDEN_PROPERTY", "/student/files", "the student context has no file access", "Remove the files; put what the student may know in the material.")] });
  const topicShape = validateAgainstV1(BENCHMARK, config.topic);
  if (topicShape.length > 0) return err("VALIDATION_FAILED", "the topic does not match paneweft.benchmark-topic/1", { errors: topicShape });
  const topic = config.topic as Extract<Benchmark, { schemaVersion: "paneweft.benchmark-topic/1" }>;
  const transcript: ModelCall[] = [];
  const call = async (model: Model, request: ModelCall): Promise<string> => {
    transcript.push(request);
    return model.complete(request);
  };

  const authorOutput = parseJson(await call(config.models["question-author"], { role: "question-author", messages: [{ role: "system", content: "You write questions about the code below, and an answer key for each. You have not seen any view of it. Reply with JSON {questions, keys}." }, { role: "user", content: `Topic: ${topic.title}\n\n${config.code.map((file) => `// ${file.path}\n${file.text}`).join("\n\n")}` }], tools: [], files: null, attachments: [] })) as { questions?: unknown[]; keys?: unknown[] } | undefined;
  if (authorOutput === undefined || !Array.isArray(authorOutput.questions) || !Array.isArray(authorOutput.keys)) return err("RUNNER_OUTPUT_INVALID", "the question author did not reply with {questions, keys}");
  const questionIssues: ValidationIssue[] = [];
  authorOutput.questions.forEach((question, index) => questionIssues.push(...validateAgainstV1(BENCHMARK, question).map((fault) => ({ ...fault, pointer: `/questions/${index}${fault.pointer}` }))));
  if (questionIssues.length > 0) return err("VALIDATION_FAILED", "the question author's questions do not match paneweft.benchmark-question/1", { errors: questionIssues });
  const questions = authorOutput.questions as Question[];
  const admission = validateTopic(topic, authorOutput.keys, { text: config.material.planted ?? config.material.text ?? "", trail: config.material.trail ?? "" }, questions);
  if (!admission.ok) return admission;
  const keys = authorOutput.keys as Key[];

  const { text: material, attachments } = studentMaterial(config);
  const scores: Score[] = [];
  const flagged = new Set<string>();
  for (const question of questions) {
    const key = keys.find((candidate) => candidate.questionId === question.id);
    if (key === undefined) return err("VALIDATION_FAILED", `no answer key for ${question.id}`);
    const prompt = [config.condition === "A" ? `Topic: ${topic.title}` : "", material, `Question: ${question.text}`, "Reply with JSON {text, confidence (integer 0-100), declaredGap?, flaggedErrors?}."].filter((part) => part.length > 0).join("\n\n");
    const answerText = parseJson(await call(config.models.student, { role: "student", messages: [{ role: "system", content: "You answer from the material in this message only. You have no tools and no files." }, { role: "user", content: prompt }], tools: [], files: null, attachments }));
    const reply = (answerText !== null && typeof answerText === "object" && !Array.isArray(answerText) ? answerText : {}) as Record<string, unknown>;
    const faults: ValidationIssue[] = [];
    if (typeof reply.text !== "string") faults.push(issue("TYPE", `/answers/${question.id}/text`, "type: string", "The student replies with JSON {text, confidence}."));
    if (typeof reply.confidence !== "number" || !Number.isInteger(reply.confidence) || reply.confidence < 0 || reply.confidence > 100) faults.push(issue("OUT_OF_RANGE", `/answers/${question.id}/confidence`, "an integer from 0 to 100", `The student's confidence was ${JSON.stringify(reply.confidence)}; the harness records what the student said and does not clamp it.`));
    if (reply.flaggedErrors !== undefined && (!Array.isArray(reply.flaggedErrors) || reply.flaggedErrors.some((id) => typeof id !== "string"))) faults.push(issue("TYPE", `/answers/${question.id}/flaggedErrors`, "an array of strings", "Name the planted claim ids the student doubts."));
    if (faults.length > 0) return err("INVALID_ARGUMENT", `the student's answer to ${question.id} is not acceptable: ${faults[0]?.constraint ?? ""} at ${faults[0]?.pointer ?? ""}`, { errors: faults });
    const answer = { schemaVersion: "paneweft.benchmark-answer/1", questionId: question.id, ...reply };
    for (const id of (answer as unknown as { flaggedErrors?: string[] }).flaggedErrors ?? []) flagged.add(id);
    const verdict = parseJson(await call(config.models.grader, { role: "grader", messages: [{ role: "system", content: "You grade one answer against its key. Reply with JSON {correct: boolean}." }, { role: "user", content: `Question: ${question.text}\nKey: ${key.answer}\nAnswer: ${(answer as unknown as { text: string }).text}` }], tools: [], files: null, attachments: [] })) as { correct?: unknown } | undefined;
    if (typeof verdict?.correct !== "boolean") return err("RUNNER_OUTPUT_INVALID", `the grader did not reply with {correct: boolean} for ${question.id}`);
    scores.push({ schemaVersion: "paneweft.benchmark-score/1", questionId: question.id, kind: question.kind, correct: verdict.correct, confidence: (answer as unknown as { confidence: number }).confidence, grader: config.models.grader.family });
  }
  const accuracyByKind: Record<string, { correct: number; total: number }> = {};
  for (const kind of QUESTION_KINDS) {
    const ofKind = scores.filter((score) => score.kind === kind);
    if (ofKind.length > 0) accuracyByKind[kind] = { correct: ofKind.filter((score) => score.correct).length, total: ofKind.length };
  }
  const planted = topic.plantedErrors.map((error) => error.id);
  return ok({
    topicId: topic.id,
    condition: config.condition,
    questions,
    scores,
    summary: {
      accuracyByKind,
      calibration: calibration(scores),
      plantedErrorDetected: config.condition === "G" ? planted.some((id) => flagged.has(id)) : null,
      sameFamilyGrading: config.models.grader.family === config.models["question-author"].family || config.models.grader.family === config.models.student.family,
    },
    transcript,
  });
}
