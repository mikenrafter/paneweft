#!/usr/bin/env node
import { runCli } from "./main.ts";

const chunks: Buffer[] = [];
const stdinIsPipe = !process.stdin.isTTY;
if (stdinIsPipe) for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

const exitCode = await runCli(process.argv.slice(2), {
  stdin: stdinIsPipe ? Buffer.concat(chunks).toString("utf8") : null,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = exitCode;
