import { NextResponse } from "next/server";
import { execFileSync } from "child_process";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  downloadAndCrop,
  normalizeForRemotion,
  normalizedMarkerPath,
  isValidMp4Path,
  safeUnlink,
} from "@/lib/broll-asset-lib";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import { isAllowedStockUrl } from "@/lib/broll-window-search";

// POST /api/videos/broll-window/select — Phase 2 "เปลี่ยนสต็อก" tab (Task 7, HERO-120).
// Downloads the candidate the user picked in /search from an allow-listed CDN URL,
// re-encodes it Remotion-safe (same pipeline as fetch-stock), and hands back a
// locally-served src the editor can drop straight into the window's `bgVideos[]`
// entry. No stock provider API key is used here — only authenticated users +
// SSRF hostname allowlist + per-user download rate limit. Internal AI testers
// receive the beta before NEXT_PUBLIC_BROLL_WINDOW_EDIT opens publicly, matching /search.

export const runtime = "nodejs";

// In-process sliding-window rate limit — mirrors `tryConsumeKieImageRate`
// (src/lib/kie-image-guards.ts) but kept local since this isn't a kie/managed-key
// guard; caps how many stock downloads one user can trigger per hour regardless
// of BYOK key (protects disk/CPU from a runaway client loop).
const SELECT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SELECT_RATE_PER_HOUR = 30;
const selectHits = new Map<string, number[]>();

function tryConsumeSelectRate(userId: string, now: number = Date.now()): boolean {
  const cutoff = now - SELECT_WINDOW_MS;
  const recent = (selectHits.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= SELECT_RATE_PER_HOUR) {
    selectHits.set(userId, recent);
    return false;
  }
  recent.push(now);
  selectHits.set(userId, recent);
  return true;
}

// URL allowlist (`isAllowedStockUrl`) lives in `@/lib/broll-window-search` so the
// SSRF guard for client-echoed CDN URLs is directly unit-tested too.

// Same derivation as tts/route.ts's ffprobeDurationSec: ffprobe sits next to
// ffmpeg in the same install (node_modules on Windows, system path on Linux).
// The /select body carries no duration (unlike fetch-stock, which trusts the
// provider search response) — we own the downloaded file, so probe it directly.
function ffprobeDurationSec(filePath: string): number {
  const ffprobe = getFfmpegPath().replace(/ffmpeg(\.exe)?$/, (m) => m.replace("ffmpeg", "ffprobe"));
  try {
    const out = execFileSync(ffprobe, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], { encoding: "utf-8", timeout: 10_000 });
    return parseFloat(out.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  const publicEnabled = process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1";
  if (!user) return NextResponse.json({ error: publicEnabled ? "Unauthorized" : "not_enabled" }, { status: publicEnabled ? 401 : 404 });
  if (!isInternalAiBetaEnabledFor(user, publicEnabled)) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { videoUrl?: unknown; provider?: unknown; keyword?: unknown } | null;
  const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl.trim() : "";
  const provider = body?.provider === "pexels" || body?.provider === "pixabay" ? body.provider : null;
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim().slice(0, 200) : "";
  void keyword; // accepted per spec (client sends it for parity with /search) — not needed for the download itself

  if (!videoUrl || !provider) {
    return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ครบสำหรับเปลี่ยนคลิป" }, { status: 400 });
  }

  if (!isAllowedStockUrl(videoUrl)) {
    return NextResponse.json({ error: "invalid_url", message: "ลิงก์วิดีโอนี้ไม่ได้รับอนุญาต" }, { status: 400 });
  }

  if (!tryConsumeSelectRate(user.id)) {
    return NextResponse.json({ error: "rate_limited", message: "เปลี่ยนคลิปมากเกินไปในชั่วโมงนี้ กรุณาลองใหม่ภายหลัง" }, { status: 429 });
  }

  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });

  // Filename convention mirrors fetch-stock's `${userPrefix}${id}.mp4` (stocks/[filename]
  // route only serves flat basenames, no subdirs). Keyed by a hash of the source URL
  // (not a provider id, which fetch-stock has from search but we don't carry here) so
  // re-selecting the same clip twice hits the cache instead of re-downloading.
  const urlHash = crypto.createHash("sha1").update(videoUrl).digest("hex").slice(0, 16);
  const outFile = `stock-${user.id}-window-${provider}-${urlHash}.mp4`;
  const outPath = path.join(stocksDir, outFile);

  try {
    if (!isValidMp4Path(outPath)) {
      await downloadAndCrop(videoUrl, outPath);
    } else {
      console.log(`[broll-window/select] cache hit: ${outFile}`);
    }
    if (!isValidMp4Path(outPath)) {
      return NextResponse.json({ error: "download_failed", message: "ดาวน์โหลดคลิปไม่สำเร็จ" }, { status: 502 });
    }

    // Re-encode to Remotion-safe CFR/no-B-frame — no-op if already normalized
    // (cache hit), same guard fetch-stock applies to every downloaded/cached clip.
    const normalizeResult = await normalizeForRemotion(outPath);
    if (normalizeResult.status === "failed") {
      safeUnlink(outPath);
      safeUnlink(normalizedMarkerPath(outPath));
      return NextResponse.json({ error: "normalize_failed", message: "แปลงไฟล์วิดีโอไม่สำเร็จ" }, { status: 502 });
    }
  } catch (e) {
    safeUnlink(outPath);
    console.error("[broll-window/select] download/normalize error:", e);
    return NextResponse.json({ error: "download_failed", message: "ดาวน์โหลดคลิปไม่สำเร็จ" }, { status: 502 });
  }

  const clipDuration = ffprobeDurationSec(outPath);
  if (!clipDuration || clipDuration <= 0) {
    // Downloaded + normalized fine but we couldn't measure it (ffprobe missing/failed) —
    // fail closed rather than hand the client a 0-length clip it can't safely trim to.
    return NextResponse.json({ error: "probe_failed", message: "อ่านความยาวคลิปไม่สำเร็จ" }, { status: 502 });
  }

  return NextResponse.json({ src: `/api/stocks/${outFile}`, clipDuration });
}
