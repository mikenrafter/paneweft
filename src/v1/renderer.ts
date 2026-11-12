// Repo-owned custom renderers: trust, delivery headers, capability tokens and the frame message contract (S4, N3; IV12, IV13).
//
// Three trust boundaries (spec section 5): submitted JSON is data and cannot grant execution; repository renderer code runs only when its
// content digest was trusted by the session owner (CLI only, outside every bundle); the host's token, session and roots are never
// reachable from the frame, which lives in an opaque-origin sandbox and talks over one private MessagePort.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../core/canonical.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import { componentSchemaId } from "../schemas/index.ts";
import { createAjv } from "../schemas/ajv.ts";
import { createV1SchemaRegistry, validateAgainstV1 } from "./schemas.ts";

/** Response headers of every /renderer/<digest>/<token>/<file> response. The S4 directives verbatim, plus base-uri, form-action and
 * frame-ancestors, which do NOT fall back to default-src and which spec section 5 requires. */
export function rendererResponseHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/** The allowlisted files of a renderer directory; nothing else is served or hashed. */
export const RENDERER_FILES = ["renderer.json", "bundle.js", "style.css"] as const;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** sha256 over the allowlisted files of `<root>/<dir>`, in a fixed order with their names. Never runs npm lifecycle scripts. */
export async function digestRenderer(root: string, dir: string): Promise<Result<{ digest: string; files: string[]; buffers: Record<string, Buffer> }>> {
  if (!SAFE_NAME.test(dir)) return err("INVALID_PATH", `"${dir}" is not a renderer directory name (lowercase letters, digits and dashes)`);
  const lines: string[] = [];
  const buffers: Record<string, Buffer> = Object.create(null);
  for (const file of RENDERER_FILES) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, dir, file));
    } catch {
      return err("NOT_FOUND", `the renderer "${dir}" has no ${file}; a renderer is exactly ${RENDERER_FILES.join(", ")}`);
    }
    buffers[file] = bytes;
    lines.push(`${file}\0${sha256(bytes)}\n`);
  }
  return ok({ digest: sha256(lines.join("")), files: [...RENDERER_FILES], buffers });
}

export interface RendererIdentity {
  id: string;
  apiVersion: number;
  /** The digest `trust` and the `assetDigest` of a `defineRenderer` declaration name: sha256 over `<file>\0<sha256(file)>\n` for the three files. */
  assetDigest: string;
  /** sha256 of the canonical JSON of renderer.json's `payloadSchema`. */
  payloadSchemaDigest: string;
}

/** Both digests a renderer declaration needs, read from the files of `<root>/<dir>` (F26): what the author would otherwise compute by hand. */
export async function identifyRenderer(root: string, dir: string): Promise<Result<RendererIdentity>> {
  const digested = await digestRenderer(root, dir);
  if (!digested.ok) return digested;
  let definition: { apiVersion?: unknown; payloadSchema?: unknown };
  try {
    definition = JSON.parse((digested.value.buffers["renderer.json"] as Buffer).toString("utf8"));
  } catch (cause) {
    return err("INVALID_ARGUMENT", `renderers/${dir}/renderer.json is not JSON: ${(cause as Error).message}`.slice(0, 300));
  }
  if (definition === null || typeof definition !== "object" || definition.payloadSchema === undefined || definition.payloadSchema === null || typeof definition.payloadSchema !== "object") return err("INVALID_ARGUMENT", `renderers/${dir}/renderer.json has no payloadSchema object: the payload schema digest is the digest of that schema`);
  if (!Number.isInteger(definition.apiVersion)) return err("INVALID_ARGUMENT", `renderers/${dir}/renderer.json has no integer apiVersion (this host speaks ${SUPPORTED_RENDERER_API.join(", ")})`);
  return ok({ id: dir, apiVersion: definition.apiVersion as number, assetDigest: digested.value.digest, payloadSchemaDigest: sha256(canonicalJson(definition.payloadSchema)) });
}

export interface TrustEntry {
  repo: string;
  id: string;
  digest: string;
}

/** The trust store lives in the session directory (renderers.trust.json), outside every submitted bundle; no MCP tool writes it. */
export interface TrustStore {
  trust(entry: TrustEntry): Promise<Result<void>>;
  isTrusted(entry: TrustEntry): Promise<boolean>;
  list(): Promise<TrustEntry[]>;
}

export function openTrustStore(sessionDir: string): TrustStore {
  const path = join(sessionDir, "renderers.trust.json");
  const read = async (): Promise<TrustEntry[]> => {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { trusted?: TrustEntry[] };
      return Array.isArray(parsed.trusted) ? parsed.trusted : [];
    } catch {
      return [];
    }
  };
  const same = (a: TrustEntry, b: TrustEntry): boolean => a.repo === b.repo && a.id === b.id && a.digest === b.digest;
  return {
    async trust(entry) {
      if (!/^[0-9a-f]{64}$/.test(entry.digest)) return err("INVALID_ARGUMENT", `"${entry.digest}" is not a renderer digest (64 lowercase hex characters); compute it with: paneweft renderers list`);
      if (!SAFE_NAME.test(entry.id) || entry.repo.length === 0) return err("INVALID_ARGUMENT", "a trust entry names a repository and a renderer id");
      const trusted = await read();
      if (trusted.some((candidate) => same(candidate, entry))) return ok(undefined);
      // A new digest for the same renderer replaces the old one: trust follows the reviewed bytes, not the name.
      const next = [...trusted.filter((candidate) => !(candidate.repo === entry.repo && candidate.id === entry.id)), { repo: entry.repo, id: entry.id, digest: entry.digest }];
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ trusted: next }, null, 2)}\n`);
      await rename(temporary, path);
      return ok(undefined);
    },
    async isTrusted(entry) {
      return (await read()).some((candidate) => same(candidate, entry));
    },
    list: read,
  };
}

export interface CapabilityIssuer {
  /** A short-lived token scoped to ONE renderer digest and one frame. */
  mint(args: { digest: string; frameId: string }): { token: string; expiresAt: number };
  verify(token: string, digest: string): boolean;
}

export function createCapabilityIssuer(options: { now: () => number; ttlMs: number }): CapabilityIssuer {
  const issued = new Map<string, { digest: string; expiresAt: number }>();
  return {
    mint({ digest }) {
      const token = randomBytes(24).toString("base64url");
      const expiresAt = options.now() + options.ttlMs;
      issued.set(token, { digest, expiresAt });
      for (const [key, value] of issued) if (value.expiresAt < options.now()) issued.delete(key);
      return { token, expiresAt };
    },
    verify(token, digest) {
      const entry = issued.get(token);
      return entry !== undefined && entry.digest === digest && options.now() <= entry.expiresAt;
    },
  };
}

export * from "./frame.ts";

const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });

/** The renderer API versions this host speaks. */
export const SUPPORTED_RENDERER_API = [1];

function remoteReferences(schema: unknown, found: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((item) => remoteReferences(item, found));
  else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if ((key === "$ref" || key === "$dynamicRef") && typeof value === "string" && !value.startsWith("#")) found.push(value);
      else remoteReferences(value, found);
    }
  }
  return found;
}


/** The payload of a renderer against its LOCALLY registered schema: no network loading, only local $refs, and the registered schema must
 * hash to the digest it is registered under. */
export function validateRendererPayload(renderer: { payloadSchemaDigest: string }, payload: unknown, schemas: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const view = { renderer, payload };
  const schema = schemas[view.renderer.payloadSchemaDigest];
  if (schema === undefined) issues.push(issue("DANGLING_REFERENCE", "/renderer/payloadSchemaDigest", "the payload schema digest names a locally registered schema", "Register the renderer's payload schema with the trusted renderer; schemas are never loaded from a URL."));
  else {
    const remote = remoteReferences(schema);
    if (remote.length > 0) issues.push(issue("CONSTRAINT", "/renderer/payloadSchemaDigest", "payload schemas may only use local $refs", `The registered schema loads a remote $ref (${remote[0]}); no network schema loading is permitted. Inline the definition.`));
    else if (sha256(canonicalJson(schema)) !== view.renderer.payloadSchemaDigest) issues.push(issue("CONSTRAINT", "/renderer/payloadSchemaDigest", "the registered schema hashes to the digest it is registered under", "The registry entry is not the schema the digest names."));
    else {
      try {
        const validate = createAjv({ strict: false }).compile(schema as object);
        if (!(validate(view.payload) as boolean)) for (const fault of validate.errors ?? []) issues.push(issue("CONSTRAINT", `/payload${fault.instancePath}`, `${fault.keyword}: ${fault.message ?? ""}`, "The payload does not satisfy the renderer's registered payload schema."));
      } catch (cause) {
        issues.push(issue("CONSTRAINT", "/renderer/payloadSchemaDigest", "the registered payload schema compiles locally", `The registered schema cannot be compiled without loading anything remote: ${(cause as Error).message}`.slice(0, 300)));
      }
    }
  }
  return issues;
}

/** Validates the data of a `custom` view: the renderer is trusted, the payload satisfies the locally registered schema (no network
 * loading; only bounded local $refs), a standard fallback is present and valid, every named object id is a string `oN`. */
export function validateCustomView(data: unknown, registry: { trustedDigests: string[]; schemas: Record<string, unknown> }): Result<true> {
  const shape = validateAgainstV1("urn:paneweft:schema:v1:component:custom:1", data);
  if (shape.length > 0) return err("VALIDATION_FAILED", `the custom view does not match its component schema (${shape.length} fault${shape.length === 1 ? "" : "s"})`, { errors: shape });
  const view = data as { renderer: { id: string; apiVersion: number; payloadSchemaDigest: string; assetDigest: string }; payload: unknown; fallback: { component: string; data: unknown } };
  const issues: ValidationIssue[] = [];
  if (!registry.trustedDigests.includes(view.renderer.assetDigest)) issues.push(issue("CONSTRAINT", "/renderer/assetDigest", "the asset digest is one the session owner trusted", "A submitted document cannot authorize code. Show the digest to the owner and have them run: paneweft renderers trust --repo <repo> --id <id> --digest <digest>. The standard fallback below is still readable."));
  if (!SUPPORTED_RENDERER_API.includes(view.renderer.apiVersion)) issues.push(issue("OUT_OF_RANGE", "/renderer/apiVersion", `apiVersion is one of ${SUPPORTED_RENDERER_API.join(", ")}`, "This host does not speak that renderer API; update the renderer or the host."));
  issues.push(...validateRendererPayload(view.renderer, view.payload, registry.schemas));
  const validateFallback = createV1SchemaRegistry().getSchema(componentSchemaId(view.fallback.component as Parameters<typeof componentSchemaId>[0]));
  if (validateFallback === undefined) issues.push(issue("ENUM", "/fallback/component", "a built-in component", "The fallback is a standard component."));
  else if (!(validateFallback(view.fallback.data) as boolean)) {
    const faults = validateFallback.errors ?? [];
    issues.push(issue("CONSTRAINT", "/fallback/data", `valid ${view.fallback.component} data (${faults.length} fault${faults.length === 1 ? "" : "s"}; first: ${faults[0]?.instancePath ?? ""} ${faults[0]?.message ?? ""})`, "The required fallback must validate as a standard component so agents and humans always read the same facts."));
    for (const fault of faults.slice(0, 20)) issues.push(issue("CONSTRAINT", `/fallback/data${fault.instancePath}`, `${fault.keyword}: ${fault.message ?? ""}`, "Fix the fallback data."));
  }
  return issues.length > 0 ? err("VALIDATION_FAILED", `the custom view is not acceptable (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues }) : ok(true);
}
