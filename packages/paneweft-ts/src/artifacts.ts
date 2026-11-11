// The artifact protocol between a test worker and the host collector (docs/v1-red-contract.md section 7).
export const ENV = { collect: "PANEWEFT_COLLECT", runId: "PANEWEFT_RUN_ID", stagingDir: "PANEWEFT_STAGING_DIR", attempt: "PANEWEFT_ATTEMPT", catalogue: "PANEWEFT_CATALOGUE" } as const;

export interface Staging {
  runId: string;
  dir: string;
  attempt: number;
}

/** Reads the collector's environment. STUB: always null. */
export function stagingFromEnv(env: Record<string, string | undefined> = process.env): Staging | null {
  return null;
}
