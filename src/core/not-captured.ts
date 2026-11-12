// What a reader is told when a row points at an object the capture did not keep (F19). The reason is the limit the capture named; the text is fixed
// per limit, so the message stays short whatever the captured data says. Spec section 4: "A missing target yields a bounded missing-capture explanation".
const WHY: Record<string, string> = {
  "object-limit": "the capture reached its limit on captured objects before this one",
  "depth-limit": "this object lies deeper than the capture's depth limit",
  "reference-limit": "the capture reached its limit on references before this one",
  "collection-limit": "the capture reached its limit on the size of one collection",
  "root-bytes-limit": "the byte budget of this capture's root was used up",
  "row-limit": "the capture reached its limit on rows",
  "string-limit": "the capture reached its limit on string size",
};

/** One sentence, at most 400 characters: which item, which limit, what to do. */
export function notCapturedMessage(itemId: string, reason: string): string {
  const id = itemId.length > 80 ? `${itemId.slice(0, 80)}...` : itemId;
  const limit = reason.length > 64 ? `${reason.slice(0, 64)}...` : reason;
  return `item ${id} points at an object that was not captured (${limit}: ${WHY[reason] ?? "a capture limit was reached"}); collect the example again with a higher limit to open it`;
}
