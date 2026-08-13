// The large legacy Hero Script verifier runs service modules directly under
// Node (not through Next's RSC loader). Stub only the marker package; server
// modules and Prisma still execute normally against the throwaway test DB.
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
