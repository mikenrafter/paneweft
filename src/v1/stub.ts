// RED PHASE marker. Every host stub in src/v1 answers `notImplemented()` (or an inert value) so tests fail on assertions.
// Green deletes every use: `grep -r NOT_IMPLEMENTED src` must be empty.
import { err, type Result } from "../core/errors.ts";

export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";

export function notImplemented<T = never>(what: string): Result<T> {
  return err("INTERNAL", `${NOT_IMPLEMENTED}: ${what}`);
}
