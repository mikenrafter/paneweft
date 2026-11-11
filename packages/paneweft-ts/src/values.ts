// Tagged values (docs/v1-red-contract.md section 2): every state JSON cannot carry is an explicit tagged object.
import type { Json, Limits } from "./types.ts";

/** A value the encoder understands beyond plain JSON. */
export class Redacted {
  constructor(readonly reason?: string) {}
}
export class Unsupported {
  constructor(readonly reason: string) {}
}
export const absent: unique symbol = Symbol.for("paneweft.absent");

export type CapturedValue = null | undefined | boolean | number | bigint | string | Uint8Array | Redacted | Unsupported | typeof absent | CapturedValue[] | Map<string, CapturedValue> | { [key: string]: CapturedValue };

export function redacted(reason?: string): Redacted {
  return new Redacted(reason);
}

/** The `paneweft.object-graph/1` encoding of `value` under `limits`. STUB: always null. */
export function encodeValue(value: CapturedValue, limits: Limits): Json {
  return null;
}

/** The display form used in shape examples and list cells. STUB: empty. */
export function displayValue(value: CapturedValue): string {
  return "";
}
