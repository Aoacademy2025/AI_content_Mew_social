import path from "path";
import { execSync } from "child_process";

export function getFfmpegPath(): string {
  if (process.platform === "win32") {
    return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
  }
  // Linux/Mac: prefer the system build used in production, then use the
  // platform binary already installed with the application. The packaged
  // fallback keeps CI and fresh hosts from depending on a global ffmpeg.
  const candidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
  for (const p of candidates) {
    try {
      const fs = require("fs");
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  try {
    const bundled = require("@ffmpeg-installer/ffmpeg") as { path?: unknown };
    if (typeof bundled.path === "string" && bundled.path) return bundled.path;
  } catch {}
  try {
    return execSync("which ffmpeg").toString().trim();
  } catch {}
  return "ffmpeg";
}
