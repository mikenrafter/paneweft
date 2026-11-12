// CLAIM(S28): JCS key ordering is UTF-16, independent of JavaScript's array-index property enumeration [canonical-hashes.json].
// Numbers and strings use ECMAScript JSON serialization. Undefined object members are omitted; array slots become null.
export function canonicalJson(value: unknown): string {
  const encode = (item: unknown): string | undefined => {
    if (Array.isArray(item)) return `[${Array.from(item, (entry) => encode(entry) ?? "null").join(",")}]`;
    if (item !== null && typeof item === "object") {
      const entries: string[] = [];
      for (const key of Object.keys(item).sort()) {
        const encoded = encode((item as Record<string, unknown>)[key]);
        if (encoded !== undefined) entries.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${entries.join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return encode(value) as string;
}
