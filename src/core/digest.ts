// sha256 digests of bytes and of canonical JSON (node only; the browser never hashes).
// Reason: snapshots, stored objects and run outputs are identified by the hash of their canonical JSON (design section 5).
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
