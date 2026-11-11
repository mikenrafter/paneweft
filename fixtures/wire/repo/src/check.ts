// access check
export function check(allowed: boolean): string {
  const denied = "denied";
  if (!allowed) return denied;
  return "ok";
}
