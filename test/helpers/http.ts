import { request } from "node:http";

export interface HttpReply { status: number; headers: Record<string, string | string[] | undefined>; text: string; error?: string }

/** node:http (not fetch) so tests can set Host and Origin freely. Connection failures become status 0 so tests fail by assertion. */
export function httpRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, text: "", error: String(error) }));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
