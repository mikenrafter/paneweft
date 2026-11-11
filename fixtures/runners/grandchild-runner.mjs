// Usage: grandchild-runner.mjs <out> <pidFile>
// Starts a grandchild that stays in THIS process's group, records {pid, pgid, grandchild} in <pidFile>, then waits forever (it exists to be killed:
// by a timeout or an abort). Never writes an output document.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extraArgs } from "./_common.mjs";

const [pidFile] = extraArgs;
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
grandchild.unref();
// /proc/self/stat is "pid (comm) state ppid pgrp ...": the fields after the last ") " start with the state
const pgid = Number((readFileSync("/proc/self/stat", "utf8").split(") ").pop() ?? "").split(" ")[2]);
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, pgid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
