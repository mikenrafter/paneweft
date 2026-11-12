import type { Json, Limits } from "./types.js";
export declare const ENV: {
    readonly collect: "PANEWEFT_COLLECT";
    readonly runId: "PANEWEFT_RUN_ID";
    readonly stagingDir: "PANEWEFT_STAGING_DIR";
    readonly attempt: "PANEWEFT_ATTEMPT";
    readonly catalogue: "PANEWEFT_CATALOGUE";
    readonly limits: "PANEWEFT_LIMITS";
};
export interface Staging {
    runId: string;
    dir: string;
    attempt: number;
}
/** Reads the collector's environment. `null` when collection is not enabled. */
export declare function stagingFromEnv(env?: Record<string, string | undefined>): Staging | null;
/** The limits this process captures under: the defaults, lowered by PANEWEFT_LIMITS when the collector set it. */
export declare function limitsFromEnv(env?: Record<string, string | undefined>): Limits;
/** Writes `value` as JSON; see `writeArtifactText`. */
export declare function writeArtifact(path: string, value: Json | Record<string, unknown>): void;
/** Writes `text` through a temporary sibling and a rename, so a reader never sees half a document. A failed write is reported on stderr
 * and never masks a test result; the host counts the missing record. The text of a graph is the text the bounded serializer counted. */
export declare function writeArtifactText(path: string, text: string): void;
