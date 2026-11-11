// Bundles the browser viewer (plain DOM + SVG, no CDN) into dist/viewer/.
// The viewer entry is src/viewer/app.ts; assets are served by src/viewer/server.ts.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("dist/viewer", { recursive: true });
await build({
  entryPoints: { app: "src/viewer/app.ts" },
  outdir: "dist/viewer",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  logLevel: "warning",
});
await writeFile(
  "dist/viewer/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>paneweft</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>\n',
);
