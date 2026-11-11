// The deterministic teaching-benchmark harness (spec S9; research note 13): role orchestration with mocked models, schemas,
// no-tool/no-file student context, planted-error detection, why-not keys citing recorded evidence. No model is called by default.
import type { Result } from "../core/errors.ts";
import type { Benchmark } from "../generated/v1/Benchmark.ts";
import { notImplemented } from "./stub.ts";

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

export interface BenchmarkRun {
  topicId: string;
  condition: Condition;
  questions: Array<Extract<Benchmark, { schemaVersion: "paneweft.benchmark-question/1" }>>;
  scores: Array<Extract<Benchmark, { schemaVersion: "paneweft.benchmark-score/1" }>>;
  summary: {
    accuracyByKind: Record<string, { correct: number; total: number }>;
    calibration: { brier: number; overconfidentWrong: number };
    plantedErrorDetected: boolean | null;
    sameFamilyGrading: boolean;
  };
  transcript: ModelCall[];
}

/** Assigns roles, feeds the student only its material, asks one question at a time, records answer + confidence, grades. STUB. */
export function runBenchmark(config: HarnessConfig): Promise<Result<BenchmarkRun>> {
  return Promise.resolve(notImplemented("runBenchmark"));
}

/** A topic is admissible when every planted error is detectable from the supplied material (its `contradictedBy` evidence appears in
 * `material`) and every why-not key cites a trail entry or other recorded evidence, not code alone. STUB. */
export function validateTopic(topic: unknown, keys: unknown[], material: { text?: string; trail?: string }): Result<true> {
  return notImplemented("validateTopic");
}

/** Brier score (confidence/100 against correctness) and the count of wrong answers given with confidence >= 80. STUB. */
export function calibration(scores: Array<{ correct: boolean; confidence: number }>): { brier: number; overconfidentWrong: number } {
  return { brier: Number.NaN, overconfidentWrong: -1 };
}
