#!/usr/bin/env node
import { runCli } from "./main.ts";

// stdin is read to its end ONLY when the request asks for it (`--args-file -`). `paneweft mcp` and
// `paneweft serve` keep stdin open for their whole lifetime, so draining it up front would hang them.
const argv = process.argv.slice(2);
const wantsStdin = argv.some((argument, index) => argument === "--args-file" && argv[index + 1] === "-");
const chunks: Buffer[] = [];
if (wantsStdin) for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

const exitCode = await runCli(argv, {
  stdin: wantsStdin ? Buffer.concat(chunks).toString("utf8") : null,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = exitCode;
