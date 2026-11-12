// Reading what a worker left in its staging directory (docs/v1-red-contract.md section 7).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StagingBudget } from "./bounded-read.ts";
import { SDK_LIMITS } from "./limits.ts";

/** Fixed allowances for what a worker stages besides its captures (bytes). Each artifact kind has its own pool, so one kind cannot spend another's.
 * The staging ceiling is the sum: `captures x collectionBytes + invocations + catalogue + reporter + typecheck`. A capture is bounded by
 * `collectionBytes` alone (contract sections 2 and 5), so the capture pool can never be spent by valid captures, however many there are. */
export const STAGING_ALLOWANCES = { invocations: 16 * 1024 * 1024, catalogue: 16 * 1024 * 1024, reporter: 16 * 1024 * 1024, typecheck: 1024 * 1024 } as const;

/** CLAIM(S39): `collectionBytes` bounds EACH capture document: its size is read with fstat and a bounded read before it is parsed (bounded-read.ts),
 * and a capture over it is returned with `bytes` above the bound and no document, for the caller to quarantine. [staging.test.ts] */
export async function readStaging(stagingDir: string, collectionBytes = SDK_LIMITS.collectionBytes): Promise<{ invocations: Array<{ started: Record<string, unknown> | null; completed: Record<string, unknown> | null }>; captures: Map<string, { document: unknown; file: string; bytes: number }>; reporter: unknown; typecheck: { exitCode: number; output: string } | undefined; parts: Array<{ name: string; document: Record<string, unknown> }> }> {
  const list = async (sub: string): Promise<string[]> => (await readdir(join(stagingDir, sub)).catch(() => [])).sort();
  const captureNames = await list("captures");
  const pools = { captures: new StagingBudget(captureNames.length * collectionBytes), invocations: new StagingBudget(STAGING_ALLOWANCES.invocations), catalogue: new StagingBudget(STAGING_ALLOWANCES.catalogue), reporter: new StagingBudget(STAGING_ALLOWANCES.reporter), typecheck: new StagingBudget(STAGING_ALLOWANCES.typecheck) };
  const readArtifact = async <T>(pool: StagingBudget, path: string): Promise<T | undefined> => pool.json<T>(path).catch(() => undefined);
  const started = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, Record<string, unknown>>();
  for (const name of await list("invocations")) {
    const document = await readArtifact<Record<string, unknown>>(pools.invocations, join(stagingDir, "invocations", name));
    if (document === undefined || typeof document.id !== "string") continue;
    if (name.endsWith(".started.json")) started.set(document.id, document);
    else completed.set(document.id, document);
  }
  const ids = [...new Set([...started.keys(), ...completed.keys()])];
  const timeOf = (id: string): string => String((started.get(id) ?? completed.get(id))?.startedAt ?? "");
  const natural = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  ids.sort((a, b) => (timeOf(a) < timeOf(b) ? -1 : timeOf(a) > timeOf(b) ? 1 : natural(a, b)));
  const captures = new Map<string, { document: unknown; file: string; bytes: number }>();
  for (const name of captureNames) {
    // the size of a capture is the size of the file the worker wrote, which is the text its SDK counted
    const file = join(stagingDir, "captures", name);
    let bytes = 0;
    let document: unknown;
    try {
      // The bounded reader checks the opened file and refuses growth; no full read or parse can precede its cap.
      const read = await pools.captures.jsonWithBytes<unknown>(file, collectionBytes);
      document = read.document;
      bytes = read.bytes;
    } catch { bytes = collectionBytes + 1; }
    captures.set(name.replace(/\.json$/, ""), { document, file, bytes });
  }
  const parts: Array<{ name: string; document: Record<string, unknown> }> = [];
  for (const name of await list("catalogue")) {
    const document = await readArtifact<Record<string, unknown>>(pools.catalogue, join(stagingDir, "catalogue", name));
    if (document !== undefined) parts.push({ name: name.replace(/\.json$/, ""), document });
  }
  return { invocations: ids.map((id) => ({ started: started.get(id) ?? null, completed: completed.get(id) ?? null })), captures, reporter: await readArtifact<unknown>(pools.reporter, join(stagingDir, "reporter.json")), typecheck: await readArtifact<{ exitCode: number; output: string }>(pools.typecheck, join(stagingDir, "typecheck.json")), parts };
}
