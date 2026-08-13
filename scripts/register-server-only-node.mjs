// Next.js maps the `server-only` marker to an empty module inside its server
// bundler. Direct Node runtimes (tsx workers and integration verifiers) do not
// have that loader and would execute the marker's deliberate throw instead.
// Preload this tiny compatibility shim only for trusted server-side processes;
// application modules and Prisma still execute normally.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const markerPath = require.resolve("server-only");
require.cache[markerPath] = {
  id: markerPath,
  filename: markerPath,
  loaded: true,
  exports: {},
  children: [],
  paths: [],
};
