// A deterministic check-to-use race for filesystem tests (review S1). The code under test resolves a path with
// `fs/promises.realpath` (the containment CHECK) and reads it afterwards (the USE); this helper runs `action` exactly once,
// immediately after a matching realpath call returns and before the caller can act on the answer, so a test can swap a
// file or an ancestor directory for a symlink in that window with no timing race.
// Limit (claimed, not hidden): it observes `fs/promises.realpath` only, which is the call every confined reader makes for its check.
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

export interface RealpathSwap {
  /** True once the action ran: a test that never fires the swap proves nothing, so assert this. */
  fired(): boolean;
  restore(): void;
}

export function swapAfterRealpath(matches: (resolved: string) => boolean, action: () => void | Promise<void>): RealpathSwap {
  const original = fsPromises.realpath;
  let hasFired = false;
  const wrapper = async function (this: unknown, ...args: unknown[]) {
    const resolved = await Reflect.apply(original, this, args);
    if (!hasFired && typeof resolved === "string" && matches(resolved)) {
      hasFired = true;
      await action();
    }
    return resolved;
  };
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original));
  (fsPromises as unknown as Record<string, unknown>).realpath = wrapper;
  syncBuiltinESMExports();
  return {
    fired: () => hasFired,
    restore() {
      (fsPromises as unknown as Record<string, unknown>).realpath = original;
      syncBuiltinESMExports();
    },
  };
}
