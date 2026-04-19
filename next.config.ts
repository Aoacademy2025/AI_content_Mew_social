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
    // Ignore non-JS files (README.md, .node binaries) that leak into the
    // webpack dependency graph through esbuild sub-packages.
    config.module.rules.push({
      test: /\.(md|txt)$/,
      type: "asset/source",
    });
    return config;
  },
};

export default nextConfig;
