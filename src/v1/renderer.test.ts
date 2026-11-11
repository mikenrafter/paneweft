// Renderer trust, delivery headers, capability tokens and the frame message contract (S4, N3; IV12, IV13), pure parts.
// The sandbox itself is tested in a REAL browser in test/v1/renderer.browser.test.ts.
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { FRAME_MESSAGE_MAX_BYTES, PARENT_FRAME_SRC, RENDERER_IFRAME_SANDBOX, RENDERER_REFERRER_POLICY, createCapabilityIssuer, digestRenderer, openTrustStore, rendererResponseHeaders, validateCustomView, validateFrameMessage, type FrameState } from "./renderer.ts";

const tmp = useTempDirs();
const digests = loadFixture<any>("renderers/DIGESTS.json").renderers;
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

describe("[IV12] delivery contract", () => {
  // why: S4 (+ section 5). The renderer response headers are exactly these: the S4 directives plus base-uri/form-action none (they do not
  // fall back to default-src) and frame-ancestors self (only the viewer may frame it). No unsafe-inline/eval, no CORS.
  // proves: CLAIM(IV12) CLAIM(S4-renderer-delivery)
  it("serves the production headers", () => {
    const headers = rendererResponseHeaders();
    expect(headers["Content-Security-Policy"]).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(JSON.stringify(headers)).not.toMatch(/unsafe-inline|unsafe-eval|Access-Control/i);
  });

  // why: S4. The sandbox attribute is scripts-only: none of the capabilities the spec withholds may appear.
  // proves: CLAIM(IV12)
  it("sandboxes scripts only", () => {
    expect(RENDERER_IFRAME_SANDBOX).toBe("allow-scripts");
    for (const forbidden of ["allow-same-origin", "allow-forms", "allow-popups", "allow-downloads", "allow-top-navigation", "allow-modals"]) expect(RENDERER_IFRAME_SANDBOX).not.toContain(forbidden);
    expect(RENDERER_REFERRER_POLICY).toBe("no-referrer");
    expect(PARENT_FRAME_SRC).toBe("frame-src 'self'");
  });
});

describe("[IV12] trust is bound to a content digest", () => {
  const root = (id: string) => join(FIXTURES, "renderers", id);

  // why: IV12. The renderer digest is the hash of the allowlisted files in a fixed order with their names, computed here independently
  // and equal to the reviewed fixture digest; files outside the allowlist (a package.json with a lifecycle script) are neither
  // hashed nor ever executed.
  // proves: CLAIM(IV12)
  it("digests exactly the allowlisted files", async () => {
    const result = must(await digestRenderer(join(FIXTURES, "renderers"), "mapping-card"), "digest");
    const expected = sha(["renderer.json", "bundle.js", "style.css"].map((f) => `${f}\0${sha(readFileSync(join(root("mapping-card"), f)))}\n`).join(""));
    expect(result.digest).toBe(expected);
    expect(result.digest).toBe(digests["mapping-card"].digest);
    expect(result.files).toEqual(["renderer.json", "bundle.js", "style.css"]);
  });

  it("is unchanged by files outside the allowlist and changed by an edit to bundle.js", async () => {
    const dir = tmp("renderer-edit");
    cpSync(join(FIXTURES, "renderers"), dir, { recursive: true });
    const before = must(await digestRenderer(dir, "mapping-card"), "before").digest;
    writeFileSync(join(dir, "mapping-card/package.json"), JSON.stringify({ scripts: { postinstall: "touch /tmp/pwned" } }));
    expect(must(await digestRenderer(dir, "mapping-card"), "extra file").digest).toBe(before);
    writeFileSync(join(dir, "mapping-card/bundle.js"), readFileSync(join(dir, "mapping-card/bundle.js"), "utf8") + "\n// edit\n");
    expect(must(await digestRenderer(dir, "mapping-card"), "edited").digest).not.toBe(before);
  });

  // why: IV12. Trust is explicit and recorded outside any bundle (renderers.trust.json in the session directory); a source edit
  // invalidates it because trust is keyed by the digest; an untrusted digest is not trusted by default.
  // proves: CLAIM(IV12)
  it("trusts a digest, persists it in the session directory, and distrusts another digest", async () => {
    const dir = tmp("trust");
    const store = openTrustStore(dir);
    const entry = { repo: "cm", id: "mapping-card", digest: digests["mapping-card"].digest };
    expect(await store.isTrusted(entry), "untrusted by default").toBe(false);
    must(await store.trust(entry), "trust");
    expect(await store.isTrusted(entry)).toBe(true);
    expect(await store.isTrusted({ ...entry, digest: "f".repeat(64) }), "an edited renderer has another digest").toBe(false);
    expect(await openTrustStore(dir).list(), "a new handle sees the persisted entry").toEqual([entry]);
    expect(JSON.parse(readFileSync(join(dir, "renderers.trust.json"), "utf8"))).toMatchObject({ trusted: [entry] });
  });

  // why: IV12. Trust refuses a malformed digest (not 64 lowercase hex): it must not store a free-form string.
  // proves: CLAIM(IV12)
  it("refuses to trust a malformed digest", async () => {
    const store = openTrustStore(tmp("trust2"));
    expect(mustFail(await store.trust({ repo: "cm", id: "mapping-card", digest: "latest" }), "bad digest").code).toBe("INVALID_ARGUMENT");
  });
});

describe("[IV12] capability tokens", () => {
  // why: S4. Asset requests carry a per-frame capability token in the path: short-lived, scoped to ONE renderer digest.
  // proves: CLAIM(IV12) CLAIM(S4-renderer-delivery)
  it("verifies for its digest only, expires, and cannot be forged", () => {
    let now = 1_000_000;
    const issuer = createCapabilityIssuer({ now: () => now, ttlMs: 60_000 });
    const a = issuer.mint({ digest: digests["mapping-card"].digest, frameId: "f1" });
    const b = issuer.mint({ digest: digests["mapping-card"].digest, frameId: "f2" });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(22);
    expect(a.expiresAt).toBe(1_060_000);
    expect(issuer.verify(a.token, digests["mapping-card"].digest)).toBe(true);
    expect(issuer.verify(a.token, digests.hostile.digest), "scoped to one digest").toBe(false);
    expect(issuer.verify(`${a.token}x`, digests["mapping-card"].digest), "tampered").toBe(false);
    expect(issuer.verify("", digests["mapping-card"].digest)).toBe(false);
    now += 60_001;
    expect(issuer.verify(a.token, digests["mapping-card"].digest), "expired").toBe(false);
  });
});

describe("[IV12] frame messages", () => {
  const state = (over: Partial<FrameState> = {}): FrameState => ({ frameId: "f1", nonce: "n-1", viewId: "inv-1.o1.mapping.card", snapshotId: "snap-run-2", permittedObjects: ["o1"], lastSeq: 0, closed: false, requestsInWindow: 0, ...over });
  const good = (over: Record<string, unknown> = {}) => ({ protocol: 1, type: "open_object", frameId: "f1", viewId: "inv-1.o1.mapping.card", snapshotId: "snap-run-2", requestId: "r1", seq: 1, body: { object: "o1" }, ...over });
  const open = { windowMatches: true, handshakeDone: true };

  // why: IV12 positive control: a well formed message for a permitted object is accepted and advances the sequence number.
  // proves: CLAIM(IV12)
  it("accepts a valid open_object for a permitted object and advances seq", () => {
    const verdict = validateFrameMessage(state(), good(), open);
    expect(verdict).toEqual({ accept: true, state: state({ lastSeq: 1 }) });
  });

  // why: IV12. Each protocol violation is rejected with its own reason; only an unexpected window or a closed frame revokes the port.
  // The case list is pinned by hand (test-quality: not iterating over the implementation's set).
  // proves: CLAIM(IV12)
  it.each<[string, () => ReturnType<typeof validateFrameMessage>, string, boolean]>([
    ["closed frame", () => validateFrameMessage(state({ closed: true }), good(), open), "CLOSED", true],
    ["no handshake", () => validateFrameMessage(state(), good(), { windowMatches: true, handshakeDone: false }), "NO_HANDSHAKE", false],
    ["message from another window", () => validateFrameMessage(state(), good(), { windowMatches: false, handshakeDone: true }), "WINDOW_MISMATCH", true],
    ["not an object", () => validateFrameMessage(state(), "open_object", open), "BAD_SHAPE", false],
    ["missing request id", () => validateFrameMessage(state(), { ...good(), requestId: undefined }, open), "BAD_SHAPE", false],
    ["protocol 2", () => validateFrameMessage(state(), good({ protocol: 2 }), open), "PROTOCOL_VERSION", false],
    ["foreign frame id", () => validateFrameMessage(state(), good({ frameId: "f-other" }), open), "WRONG_FRAME", false],
    ["foreign view id", () => validateFrameMessage(state(), good({ viewId: "v-other" }), open), "WRONG_VIEW", false],
    ["foreign snapshot", () => validateFrameMessage(state(), good({ snapshotId: "snap-other" }), open), "WRONG_SNAPSHOT", false],
    ["repeated sequence number", () => validateFrameMessage(state({ lastSeq: 5 }), good({ seq: 5 }), open), "SEQ_NOT_MONOTONIC", false],
    ["decreasing sequence number", () => validateFrameMessage(state({ lastSeq: 5 }), good({ seq: 3 }), open), "SEQ_NOT_MONOTONIC", false],
    ["a fetch proxy message", () => validateFrameMessage(state(), good({ type: "fetch", body: { url: "http://x" } }), open), "UNKNOWN_TYPE", false],
    ["an eval message", () => validateFrameMessage(state(), good({ type: "eval", body: { code: "1" } }), open), "UNKNOWN_TYPE", false],
    ["a collect message", () => validateFrameMessage(state(), good({ type: "collect", body: {} }), open), "UNKNOWN_TYPE", false],
    ["an object the view did not permit", () => validateFrameMessage(state(), good({ body: { object: "o99" } }), open), "UNPERMITTED_OBJECT", false],
    ["over 64 KiB", () => validateFrameMessage(state(), good({ type: "render_error", body: { message: "x".repeat(FRAME_MESSAGE_MAX_BYTES) } }), open), "TOO_LARGE", false],
    ["too many requests in the window", () => validateFrameMessage(state({ requestsInWindow: 50 }), good(), open), "RATE_LIMITED", false],
  ])("rejects %s", (_name, run, reason, revokePort) => {
    expect(run()).toEqual({ accept: false, reason, revokePort });
  });

  // why: host-to-frame messages are not renderer messages: a renderer may not send `init` or `dispose` (it would impersonate the host).
  // proves: CLAIM(IV12)
  it("rejects host-only message types coming from the renderer", () => {
    for (const type of ["init", "page", "selection_changed", "dispose"]) expect(validateFrameMessage(state(), good({ type }), open)).toEqual({ accept: false, reason: "UNKNOWN_TYPE", revokePort: false });
  });
});

describe("[IV13] custom view data and its fallback", () => {
  const registry = { trustedDigests: [digests["mapping-card"].digest], schemas: { [digests["mapping-card"].payloadSchemaDigest]: JSON.parse(readFileSync(join(FIXTURES, "renderers/mapping-card/renderer.json"), "utf8")).payloadSchema } };
  const valid = () => ({
    renderer: { id: "mapping-card", apiVersion: 1, payloadSchemaDigest: digests["mapping-card"].payloadSchemaDigest, assetDigest: digests["mapping-card"].digest },
    payload: { originalIndex: 4, containerId: "firefox-container-3", backupName: "Work" },
    objects: ["o1"],
    fallback: { component: "shape", data: { basis: "observed", root: "details", fields: [{ id: "details", path: "$", type: "object", presence: "required", children: [], provenance: "observed", evidence: ["run"] }] } },
  });

  // why: IV13. A trusted renderer with a valid payload and a valid standard fallback is accepted (positive control for the refusals).
  // proves: CLAIM(IV13)
  it("accepts a trusted renderer with a valid payload and fallback", () => {
    expect(must(validateCustomView(valid(), registry), "valid")).toBe(true);
  });

  // why: IV13 / IV12. Each fault is refused with its own pointer: untrusted digest (foreign JSON cannot authorize code), missing
  // fallback, an invalid fallback, a payload outside the registered local schema, a remote schema reference, a bad object id and an
  // incompatible API version.
  // proves: CLAIM(IV13) CLAIM(IV12)
  it.each<[string, (v: any) => void, string, any?]>([
    ["an untrusted asset digest", (v) => void (v.renderer.assetDigest = "e".repeat(64)), "/renderer/assetDigest"],
    ["no fallback", (v) => void delete v.fallback, "/fallback"],
    ["an invalid fallback component", (v) => void (v.fallback.data = { basis: "nonsense" }), "/fallback/data"],
    ["a payload outside the local schema", (v) => void (v.payload.originalIndex = "four"), "/payload/originalIndex"],
    ["a malformed object id", (v) => void (v.objects = ["../o1"]), "/objects/0"],
    ["an incompatible API version", (v) => void (v.renderer.apiVersion = 99), "/renderer/apiVersion"],
  ])("refuses %s", (_name, mutate, pointer) => {
    const data = valid();
    mutate(data);
    const error = mustFail(validateCustomView(data, registry), "refused");
    expect(error.errors.map((e) => e.pointer)).toContain(pointer);
  });

  it("refuses a registered payload schema that loads a remote $ref", () => {
    const remote = { trustedDigests: registry.trustedDigests, schemas: { [digests["mapping-card"].payloadSchemaDigest]: { $ref: "https://example.invalid/schema.json" } } };
    const error = mustFail(validateCustomView(valid(), remote), "remote ref");
    expect(error.errors.map((e) => e.constraint).join(" ")).toMatch(/remote|network|local/i);
  });
});
