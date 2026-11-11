// Builds the viewer bundle once so server and bundle tests see dist/viewer.
import { execFileSync } from "node:child_process";

export default function setup(): void {
  execFileSync(process.execPath, ["scripts/build-viewer.mjs"], { stdio: "inherit" });
}
