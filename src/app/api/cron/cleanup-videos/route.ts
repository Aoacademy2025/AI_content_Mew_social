import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { deleteLowResPreviewForVideoUrl } from "@/lib/low-res-preview-paths";
import { activeRemotionBundleNames } from "@/app/api/videos/render/cancel-registry";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

// PENDING payments older than this are auto-cancelled
const PENDING_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const REMOTION_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours; avoid active long renders
const TELEMETRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // keep last 90 days (DB-1)

function safePublicPath(publicDir: string, ...segments: string[]): string | null {
  const base = path.resolve(publicDir);
  const resolved = path.resolve(base, ...segments);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

function renderFile(publicDir: string, filename: string): string | null {
  if (!filename || /[/\\]/.test(filename)) return null;
  return safePublicPath(publicDir, "renders", filename);
}

function localFilePath(publicDir: string, url: string | null): string | null {
  if (!url || url.startsWith("http://") || url.startsWith("https://")) return null;
  if (url.startsWith("/api/renders/")) {
    return renderFile(publicDir, url.slice("/api/renders/".length));
  }
  if (url.startsWith("/renders/")) {
    return renderFile(publicDir, url.slice("/renders/".length));
  }
  if (!url.startsWith("/")) return null;
  return safePublicPath(publicDir, url.replace(/^\/+/, ""));
}

function cleanupOldChildren(dir: string, maxAgeMs: number, excludeNames: Iterable<string> = []): number {
  let deleted = 0;
  const excludes = new Set(excludeNames);
  try {
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (excludes.has(name)) continue;
      const child = path.join(dir, name);
      const stat = fs.statSync(child);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(child, { recursive: true, force: true });
      deleted++;
    }
  } catch (e) {
    console.error("[cron] Remotion tmp cleanup failed:", e);
  }
  return deleted;
}

// GET /api/cron/cleanup-videos
// Called by a cron job (or Vercel Cron) every day to delete expired videos.
// Protected by CRON_SECRET env variable — fails CLOSED if it's unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const result = { videosDeleted: 0, pendingPaymentsCancelled: 0, remotionTmpDeleted: 0, telemetryEventsDeleted: 0 };

  // ── 1. Expire stale PENDING payments (> 2 hours old) ───────────────────
  try {
    const stalePending = await prisma.payment.findMany({
      where: {
        status: "PENDING",
        createdAt: { lt: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
      },
      select: { id: true, stripeSessionId: true },
    });

    for (const p of stalePending) {
      try {
        await stripe.checkout.sessions.expire(p.stripeSessionId);
      } catch { /* may already be expired on Stripe */ }
    }

    if (stalePending.length > 0) {
      const { count } = await prisma.payment.updateMany({
        where: { id: { in: stalePending.map(p => p.id) } },
        data: { status: "FAILED" },
      });
      result.pendingPaymentsCancelled = count;
      console.log(`[cron] Cancelled ${count} stale PENDING payments`);
    }
  } catch (e) {
    console.error("[cron] PENDING cleanup failed:", e);
  }

  // ── 2. Delete stale Remotion temp/cache files ─────────────────────────
  // Render route also cleans before each render, but the daily cron catches
  // stale bundles when no new render arrives for a while.
  result.remotionTmpDeleted = cleanupOldChildren(
    path.join(process.cwd(), ".tmp", "remotion"),
    REMOTION_TMP_MAX_AGE_MS,
    activeRemotionBundleNames(),
  );

  // ── 3. Delete expired videos ──────────────────────────────────────────
  const expired = await prisma.video.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, videoUrl: true, avatarVideoUrl: true, audioUrl: true, thumbnail: true },
  });

  if (expired.length > 0) {
    const publicDir = path.join(process.cwd(), "public");
    for (const video of expired) {
      for (const url of [video.videoUrl, video.avatarVideoUrl, video.audioUrl, video.thumbnail]) {
        deleteLowResPreviewForVideoUrl(url);
        const filePath = localFilePath(publicDir, url);
        if (!filePath) continue;
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch { /* ignore file errors */ }
      }
    }

    const { count } = await prisma.video.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    result.videosDeleted = count;
    console.log(`[cron] Deleted ${count} expired videos`);
  }

  // ── 4. TelemetryEvent retention: keep last 90 days (DB-1) ─────────────────
  // Additive sweep for the largest, previously-unbounded table (~123k rows in prod,
  // no prior sweeper). Fail-open — a retention error must not break the cleanup response.
  try {
    const { count } = await prisma.telemetryEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - TELEMETRY_RETENTION_MS) } },
    });
    result.telemetryEventsDeleted = count;
    if (count > 0) console.log(`[cron] Deleted ${count} TelemetryEvent rows older than 90 days`);
  } catch (e) {
    console.error("[cron] TelemetryEvent retention sweep failed:", e);
  }

  writeCronHeartbeat("cleanup-videos");
  return NextResponse.json(result);
}
