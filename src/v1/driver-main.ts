// The detached process of a job driver (driver.ts): `node driver-main.ts <session directory> <job id>`. Opens the session, builds the same job service the CLI and the MCP server
// build, and follows the job until it is terminal.
import { openSession } from "../core/session.ts";
import { driveJob } from "./driver.ts";
import { createSessionJobService } from "./service.ts";

const [sessionDir, jobId] = process.argv.slice(2);
if (sessionDir === undefined || jobId === undefined) {
  console.error("usage: driver-main.ts <session directory> <job id>");
  process.exit(64);
}
const opened = await openSession(sessionDir);
if (!opened.ok) {
  console.error(`driver: cannot open the session ${sessionDir}: ${opened.error.message}`);
  process.exit(1);
}
const jobs = await createSessionJobService(opened.value, sessionDir, { drive: false });
const outcome = await driveJob(jobs, jobId);
console.log(`driver: job ${jobId} ended as ${outcome}`);
await opened.value.close();
process.exit(0);
