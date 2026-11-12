import { type TypeToken } from "./capture.js";
export type NativeOutcome = {
    outcome: "passed";
} | {
    outcome: "failed";
    message: string;
} | {
    outcome: "error";
    message: string;
} | {
    outcome: "blocked";
    blockedBy: string;
} | {
    outcome: "skipped" | "cancelled" | "filtered";
};
export interface CheckRecord {
    claim: string;
    passed: boolean;
    /** Where a failed check failed: the first frame of the failure in the author's code (F30c). Absent for a passing check or a failure with no such frame. */
    source?: {
        path: string;
        line: number;
    };
}
/** The first frame of `error`'s stack that is the author's code: inside the working directory (the repository root a runner starts from), not in a dependency and not in the SDK's own
 * modules. A runner's frames are source-mapped, so the line is the one the author reads. */
export declare function failureSite(error: unknown): {
    path: string;
    line: number;
} | undefined;
export interface InvocationRecord {
    id: string;
    exampleId: string;
    attempt: number;
    parent: string | null;
    native: NativeOutcome;
    checks: CheckRecord[];
    /** passed AND at least one executed recorded check AND a captured result. A zero-check invocation is exploratory. */
    verified: boolean;
    expectedFailure?: {
        matched: boolean;
        diagnosticId: string | null;
    };
    result: {
        captureId: string;
        object: string;
    } | null;
}
export interface ExampleContext {
    /** Invokes the supplied native assertion callback and records whether it completed. Async callbacks must be awaited. */
    check(claim: string, assertion: () => void | Promise<void>): void | Promise<void>;
    /** Calls another example: fresh value each time, parent edge recorded, a failed child blocks this example. */
    use<T>(other: ExampleDefinition<T>): Promise<T>;
}
export interface ExampleSpec<T> {
    id: string;
    type: TypeToken<T>;
    claims: string[];
    kind?: "example" | "dead-end";
    run(cx: ExampleContext): T | Promise<T>;
}
export interface ExampleDefinition<T> extends ExampleSpec<T> {
    readonly typeId: string;
    /** The line of the call that defined the example (for the catalogue). */
    readonly definedAtLine?: number;
}
export declare function example<T>(spec: ExampleSpec<T>): ExampleDefinition<T>;
/** Drains the invocations recorded in this process, in start order. */
export declare function takeInvocations(): InvocationRecord[];
/** Runs an example: records the invocation, captures the result while it is borrowed, rethrows nothing. */
export type ExampleRun<T> = {
    failed: false;
    value: T | undefined;
    invocation: InvocationRecord;
    error?: undefined;
}
/** `error` is whatever was thrown, which may itself be `undefined`: `failed` is the discriminant, never `error !== undefined` (S18). */
 | {
    failed: true;
    value: T | undefined;
    invocation: InvocationRecord;
    error: unknown;
};
export declare function runExample<T>(definition: ExampleDefinition<T>, options?: {
    attempt?: number;
}): Promise<ExampleRun<T>>;
export type Matcher = {
    kind: "any";
} | {
    kind: "message";
    contains: string;
};
export declare const anyFailure: Matcher;
export declare function messageContains(text: string): Matcher;
/** `expectFailure(matcher, fn)` (spec N4): a matched failure inside is captured, not propagated as "blocked by"; unexpected success
 * and unrelated errors fail the example. */
export declare function expectFailure(matcher: Matcher, body: () => unknown | Promise<unknown>): Promise<{
    message: string;
    diagnosticId: string;
}>;
