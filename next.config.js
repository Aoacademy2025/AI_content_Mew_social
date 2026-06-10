/** @type {import('next').NextConfig} */
// ⚠️ This file SHADOWS next.config.ts: Next.js resolves config in the order
// next.config.js → .mjs → .ts (CONFIG_FILES, next 15.3.9), so THIS file
// is the config production actually runs with — everything in next.config.ts
// (serverExternalPackages, webpack externals, the /renders rewrite, build OOM
// mitigations) is currently INACTIVE. Unifying the two files is a separate,
// coordinated change (wao's call — see PR body). Until then, settings the
// deploy pipeline depends on must live HERE.
const nextConfig = {
  // Build output dir. deploy/deploy.sh builds into .next-staging (via
  // NEXT_DIST_DIR) and atomically swaps it into .next only on success, so a
  // failed/OOM build can never delete the dist dir the running app serves
  // from. Runtime (pm2 `next start`) never sets NEXT_DIST_DIR, so it always
  // reads the default .next. Kept in sync with next.config.ts.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
