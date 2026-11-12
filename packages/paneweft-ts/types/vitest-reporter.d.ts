export declare const EXAMPLE_PREFIX = "example:";
interface ReportedError {
    message?: string;
}
interface ReportedTest {
    name: string;
    result(): {
        state: string;
        errors?: ReadonlyArray<ReportedError>;
    };
    diagnostic(): {
        retryCount?: number;
    } | undefined;
}
interface ReportedModule {
    /** Vitest 5. */
    relativeModuleId?: string;
    /** Vitest 3 and 5: usually an absolute path. */
    moduleId?: string;
    /** Vitest 3 and 5: the project the module belongs to. */
    project?: {
        config?: {
            root?: string;
        };
    };
    errors(): ReadonlyArray<ReportedError>;
    children: {
        allTests(): Iterable<ReportedTest>;
        allSuites(): Iterable<{
            errors(): ReadonlyArray<ReportedError>;
        }>;
    };
}
/** The repository-relative, slash-separated file of a reported module. Vitest 3.2's TestModule has no `relativeModuleId`, so it is derived from
 * `moduleId` and the project root; "" when the module names no file (the host refuses such a record). */
export declare function moduleFile(entry: Pick<ReportedModule, "relativeModuleId" | "moduleId" | "project">): string;
/** A vitest reporter. Pin supported vitest versions: reporter hook signatures move between majors. */
export declare class PaneweftReporter {
    onTestRunEnd(testModules: ReadonlyArray<unknown>, unhandledErrors: ReadonlyArray<unknown>, _reason?: string): void;
}
export default PaneweftReporter;
