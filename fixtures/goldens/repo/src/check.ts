// check.ts
import { allowed, audit, denied } from "./policy";

export type User = { id: string };

// The gate for every request.
//
// Returns denied when the user is not allowed.
//
export function check(user: User) {
  if (!allowed(user)) return denied;
  audit(user);
  return ok;
}
