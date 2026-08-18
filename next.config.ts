import type { NextConfig } from "next";
import fs from "fs";

// Windows: create a short temp path so Remotion's ffmpeg audio-mixing doesn't
// exceed the 260-char MAX_PATH limit (AppData\Local\Temp\remotion-... is too long).
if (process.platform === "win32") {
  try { fs.mkdirSync("C:\\Tmp", { recursive: true }); } catch {}
  process.env.TEMP   = "C:\\Tmp";
  process.env.TMP    = "C:\\Tmp";
  process.env.TMPDIR = "C:\\Tmp";
}

const nextConfig: NextConfig = {
  // Build output dir. deploy/deploy.sh builds into .next-staging (via
  // NEXT_DIST_DIR) and atomically swaps it into .next only on success, so a
  // failed/OOM build can never delete the dist dir the running app serves
  // from (the old in-place flow caused a 1,014-line ".next not found" crash
  // loop). Runtime (pm2 `next start`) never sets NEXT_DIST_DIR, so it always
  // reads the default .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Runtime renders and stock cache entries are mutable media (hundreds of GB in
  // production), served through API storage adapters and never required inside
  // a Next server bundle. Without both exclusions, dynamic filesystem access
  // makes every route trace thousands of media files and can exhaust the VPS
  // while webpack collects dependencies.
  outputFileTracingExcludes: {
    "/**": ["./public/renders/**/*", "./stocks/**/*"],
  },
  images: {
    localPatterns: [
      // Preserve Next's secure default: ordinary local images cannot add an
      // arbitrary query string.
      { pathname: "/**", search: "" },
      // The five reviewed Brand Visual cards use their manifest content hash
      // as a query so a replaced file cannot retain a stale optimized image.
      { pathname: "/brand-visual-formats/**" },
    ],
  },
  experimental: {
    // Limit parallel workers to 1 to prevent OOM on low-RAM VPS during build
    workerThreads: false,
    cpus: 1,
    // src/proxy.ts runs for authenticated API routes. Next.js buffers/clones
    // proxied request bodies and otherwise truncates them at its 10 MB default,
    // leaving upload-avatar with an invalid multipart body. Match the route's
    // 500 MB file limit plus its documented 10 MB form overhead allowance.
    proxyClientMaxBodySize: "510mb",
  },
  async rewrites() {
    return [
      // Serve dynamically-written renders via API route (static public/ doesn't serve runtime files in prod)
      { source: "/renders/:filename", destination: "/api/renders/:filename" },
    ];
  },
  // Prevent Next.js from bundling Remotion server-side packages.
  // @remotion/bundler and @remotion/renderer include esbuild native binaries
  // and non-JS files (.md, .node) that webpack/turbopack cannot handle.
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "esbuild",
    "puppeteer-core",
    // fluent-ffmpeg + ffmpeg-installer
    "fluent-ffmpeg",
    "@ffmpeg-installer/ffmpeg",
    "@ffmpeg-installer/win32-x64",
    "@ffmpeg-installer/win32-ia32",
    "@ffmpeg-installer/linux-x64",
    "@ffmpeg-installer/linux-arm64",
    "@ffmpeg-installer/darwin-x64",
    "@ffmpeg-installer/darwin-arm64",
    // @imgly/background-removal-node + onnxruntime
    "@imgly/background-removal-node",
    "onnxruntime-node",
    "sharp",
    // prisma CLI (not client)
    "prisma",
    "@prisma/engines",
    // esbuild platform-specific packages (nested inside @remotion/bundler)
    "@esbuild/win32-x64",
    "@esbuild/win32-ia32",
    "@esbuild/win32-arm64",
    "@esbuild/linux-x64",
    "@esbuild/linux-arm64",
    "@esbuild/darwin-x64",
    "@esbuild/darwin-arm64",
  ],
  webpack: (config) => {
    // Treat .wasm files as asset/resource so webpack emits them as separate files
    // instead of inlining — inlining large WASM through WasmHash causes OOM/crash.
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    // Ignore non-JS files (README.md, .txt) that leak into the
    // webpack dependency graph through esbuild sub-packages.
    config.module.rules.push({
      test: /\.(md|txt)$/,
      type: "asset/source",
    });

    return config;
  },
};

export default nextConfig;
