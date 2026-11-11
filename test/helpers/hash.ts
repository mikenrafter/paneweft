import { createHash } from "node:crypto";
export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
