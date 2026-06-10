import path from "path";
import { execSync } from "child_process";

export function getFfmpegPath(): string {
  if (process.platform === "win32") {
    return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
  }
  // Linux/Mac: try system ffmpeg first, fallback to which
  const candidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
  for (const p of candidates) {
    try {
      const fs = require("fs");
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  try {
    return execSync("which ffmpeg").toString().trim();
  } catch {}
  return "ffmpeg";
}
