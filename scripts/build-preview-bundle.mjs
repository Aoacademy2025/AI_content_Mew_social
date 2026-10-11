// W4 (get_preview_frame): builds the Remotion bundle the preview stills render from, in its OWN
// short-lived process. Spawned by src/lib/render/preview-still.ts only when neither the render
// worker's bundle nor a cached one matches the current src/remotion sources. Running webpack here,
// not in the web process, keeps a multi-second synchronous build off the server's event loop.
//
// Usage: node scripts/build-preview-bundle.mjs <entryPoint> <publicDir> <outDir>
import { bundle } from "@remotion/bundler";

const [entryPoint, publicDir, outDir] = process.argv.slice(2);
if (!entryPoint || !publicDir || !outDir) {
  console.error("usage: node scripts/build-preview-bundle.mjs <entryPoint> <publicDir> <outDir>");
  process.exit(2);
}

const location = await bundle({ entryPoint, publicDir, outDir, webpackOverride: (config) => config });
process.stdout.write(`${location}\n`);
