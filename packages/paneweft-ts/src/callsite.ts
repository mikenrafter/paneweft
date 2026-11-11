// The source line of the call that defined a view or an example, read from the stack. The catalogue records it so discovery can point
// at the definition. `skip` is the number of frames between this function's caller and the author's call (0 = the direct caller).
export function callerLine(skip: number): number | undefined {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  // lines[0] is callerLine itself; lines[1] is its caller (the SDK function); lines[2 + skip] is the author's call site.
  const frame = lines[2 + skip];
  const match = frame === undefined ? null : /:(\d+):\d+\)?\s*$/.exec(frame);
  return match === null ? undefined : Number(match[1]);
}
