// CLAIM(S27): stat and a bounded read precede JSON parsing; every read is bounded by its own maximum and by what is left of its allowance [bounded-read.test.ts].
import { open } from "node:fs/promises";

export class StagingBudget {
  private remaining: number;
  constructor(bytes: number) { this.remaining = bytes; }
  async json<T>(path: string, maximum = this.remaining): Promise<T> {
    return (await this.jsonWithBytes<T>(path, maximum)).document;
  }
  async jsonWithBytes<T>(path: string, maximum = this.remaining): Promise<{ document: T; bytes: number }> {
    const handle = await open(path, "r");
    try {
      const cap = Math.max(0, Math.min(maximum, this.remaining));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > cap) throw new RangeError(`artifact exceeds remaining staging budget (${cap} bytes)`);
      const chunks: Buffer[] = [];
      let used = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, cap - used + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        // a file is charged at most its cap, so an allowance sized as n files of `cap` bytes is never spent by a file that grew
        this.remaining -= Math.max(0, Math.min(bytesRead, cap - used));
        used += bytesRead;
        if (used > cap) throw new RangeError(`artifact grew beyond staging budget (${cap} bytes)`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return { document: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T, bytes: used };
    } finally { await handle.close(); }
  }
}
