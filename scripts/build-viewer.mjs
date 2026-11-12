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
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>paneweft</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:1em 1.5em;color:#222}[data-pw=pane]{margin:.5em 0 1.5em}[data-pw=status-strip]{font-size:12px;color:#555;margin:.25em 0 .75em}[data-pw=row]:focus,[data-pw=row][aria-selected=true]{outline:2px solid #06c;outline-offset:-2px}[data-pw=cell]{overflow-wrap:anywhere}</style></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>\n',
);
