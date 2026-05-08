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
  experimental: {
    // Limit parallel workers to 1 to prevent OOM on low-RAM VPS during build
    workerThreads: false,
    cpus: 1,
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
    // fluent-ffmpeg + ffmpeg-installer (all platforms — never bundle native binaries)
    "fluent-ffmpeg",
    "@ffmpeg-installer/ffmpeg",
    "@ffmpeg-installer/win32-x64",
    "@ffmpeg-installer/win32-ia32",
    "@ffmpeg-installer/win32-arm64",
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
    // Replace WasmHash with md4 to avoid OOM on VPS.
    // WasmHash (xxhash via WASM) requires contiguous WASM memory that VPS kernels
    // cannot allocate. md4 is CPU-only and always works.
    // Always force md4 — it's safe on all platforms.
    config.output = config.output ?? {};
    config.output.hashFunction = "md4";
    config.optimization = config.optimization ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config.optimization as any).realContentHash = false;

    // .node native addons must never enter webpack's module graph.
    const prevExternals = config.externals ?? [];
    config.externals = [
      ...(Array.isArray(prevExternals) ? prevExternals : [prevExternals]),
      ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
        if (request && request.endsWith(".node")) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    ];

    // Treat .wasm files as asset/resource so webpack emits them as separate files
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    // Ignore non-JS files (README.md, .txt) that leak into the webpack graph
    config.module.rules.push({
      test: /\.(md|txt)$/,
      type: "asset/source",
    });

    return config;
  },
};

export default nextConfig;
