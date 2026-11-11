// Minimal RFC 6901/6902 subset (add, replace, remove) for building invalid payloads from a valid fixture.
// Fails loudly on a bad pointer: a mutation that silently did nothing would make a negative test vacuous.
import { clone } from "./fixtures.ts";

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
function walk(root: any, tokens: string[]): any {
  let node = root;
  for (const token of tokens) {
    if (node === null || typeof node !== "object" || !(token in node)) throw new Error(`patch: pointer segment "${token}" not found`);
    node = node[token];
  }
  return node;
}

export function patch<T>(document: T, ...ops: PatchOp[]): T {
  const result: any = clone(document);
  for (const operation of ops) {
    if (operation.path === "") throw new Error("patch: the root cannot be patched");
    if (!operation.path.startsWith("/")) throw new Error(`patch: pointer must start with "/": ${operation.path}`);
    const tokens = operation.path.slice(1).split("/").map(unescapeToken);
    const last = tokens.pop() as string;
    const parent = walk(result, tokens);
    if (Array.isArray(parent)) {
      if (operation.op === "add") {
        if (last === "-") parent.push(clone(operation.value));
        else parent.splice(Number(last), 0, clone(operation.value));
      } else {
        const index = Number(last);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`patch: array index ${last} out of range`);
        if (operation.op === "replace") parent[index] = clone(operation.value);
        else parent.splice(index, 1);
      }
    } else if (parent !== null && typeof parent === "object") {
      if (operation.op !== "add" && !(last in parent)) throw new Error(`patch: "${operation.path}" does not exist`);
      if (operation.op === "remove") delete parent[last];
      else parent[last] = clone(operation.value);
    } else {
      throw new Error(`patch: parent of ${operation.path} is not a container`);
    }
  }
  return result as T;
}
