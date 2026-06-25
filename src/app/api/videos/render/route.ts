import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { createNotification } from "@/lib/notifications";
import { limitsForPlan, nextPlanFor, PLAN_LABEL } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";
import { checkClipQuota, reserveClipUsage } from "@/lib/usage-limits";
import { checkMinuteQuota, minutesFromSeconds } from "@/lib/minute-limits";
import { reserveMinutesOrCredits, refundReservation } from "@/lib/minute-credits";
import { isBurnAlreadyPaid, recordChargedClip } from "@/lib/clip-charge";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { isSafeFetchUrl } from "@/lib/safe-fetch";
import { stripDangerousCss } from "@/lib/sanitize-caption-style";
import { execFileSync, spawn } from "child_process";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { runRender, SupersededError } from "@/lib/render/run-render";
import type { ResolvedRenderInput } from "@/lib/render/run-render";
import { enqueueRenderJob, supersedeScope } from "@/lib/render/job-store";
import {
  activeRenderCancel,
  cancelByJobId,
  renderJobDoneByUser,
  getActiveRenderCount,
  incrementActiveRenderCount,
  decrementActiveRenderCount,
  getRenderSlotQueueLength,
  activeRemotionBundleNames,
} from "./cancel-registry";

function getRenderTmpDir(): string {
  const base =
    process.env.RENDER_TMP_ROOT
      ? path.resolve(process.env.RENDER_TMP_ROOT)
      : path.join(process.cwd(), ".tmp", "remotion");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}
  return base;
}

function getRemotionBundlePublicDir(): string {
  // Remotion inputs are absolute /api/renders and /api/stocks URLs, not staticFile().
  // Use an empty public dir so bundle() does not duplicate public/renders into cache.
  const base = path.join(process.cwd(), ".tmp", "remotion-public");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}
  return base;
}

function runTmpCleanup(baseDir: string, pattern: string, minMinutes: number, excludeNames?: Iterable<string>) {
  if (process.platform === "win32") return;
  try {
    // execFile (no shell) — avoids any command-injection surface from interpolated names.
    // Never delete the bundle that's currently cached/in use: a concurrent render may be
    // between its existsSync check and selectComposition (TOCTOU), and removing it under
    // that job's feet causes "index.html could not be found" 404s.
    const excludes = Array.from(excludeNames ?? []).filter(Boolean);
    const args = [
      baseDir, "-maxdepth", "1", "-name", pattern,
      ...excludes.flatMap((name) => ["!", "-name", name]),
      "-mmin", `+${minMinutes}`,
      "-exec", "rm", "-rf", "{}", "+",
    ];
    execFileSync("find", args, { stdio: "ignore" });
  } catch {}
}

/** Download external image URL to local public/renders and return a full absolute URL
 *  so Remotion's Chromium (which runs on its own port) can fetch from Next.js server */
async function cacheImageLocally(url: string, rendersDir: string, baseUrl: string): Promise<string> {
  if (!url) return url;
  // Already a full URL pointing to our own server — keep as-is
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // SSRF guard: never fetch a private/internal target, and don't pass it downstream
    // to Remotion's Chromium either (drop to "" → scene renders without this image).
    if (!(await isSafeFetchUrl(url))) return "";
    // external URL — download and re-serve via Next.js
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return url;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = url.includes(".png") ? "png" : "jpg";
      const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      fs.writeFileSync(path.join(rendersDir, filename), buf);
      return `${baseUrl}/api/renders/${filename}`;
    } catch {
      return url;
    }
  }
  // Local path e.g. "/renders/foo.png" — make it absolute
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

export const maxDuration = 60; // only needs to start the background job, not wait for it
export const runtime = "nodejs";

// Job state persisted to disk so hot-reload and pm2 restarts don't lose in-flight jobs.
type RenderJob = {
  status: "running" | "done" | "error";
  videoUrl?: string;
  error?: string;
  startedAt: number;
  progress?: number; // 0–100
  userId?: string; // owner — used by the render-status legacy branch for ownership checks
  // Receipt fields, set only when the render was funded by credit overflow (CREDITS_LIVE).
  // Absent (undefined) on every minute/clip-funded render → no change to the persisted
  // job JSON when CREDITS_LIVE is off. The render-status route can surface these (Task 5).
  creditsSpent?: number;
  creditBalanceAfter?: number;
};

// activeRenderCount is now stored in global via cancel-registry to survive hot-reloads.

function jobsDir(): string {
  const d = path.join(process.cwd(), ".tmp", "render-jobs");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function jobFilePath(jobId: string): string {
  return path.join(jobsDir(), `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function persistJob(jobId: string, job: RenderJob) {
  try { fs.writeFileSync(jobFilePath(jobId), JSON.stringify(job)); } catch {}
}

function readPersistedJob(jobId: string): RenderJob | undefined {
  try {
    const raw = fs.readFileSync(jobFilePath(jobId), "utf-8");
    return JSON.parse(raw) as RenderJob;
  } catch { return undefined; }
}

// In-memory cache so same process doesn't re-read file on every poll
const renderJobs = new Map<string, RenderJob>();

// Track the latest jobId per render scope. The scope is user + draft/session, so
// one account can queue multiple clips without those clips cancelling each other.
const latestJobPerRenderScope = new Map<string, string>();

function normalizeRenderScopeId(value: unknown): string {
  if (typeof value !== "string") return "default";
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 96);
  return cleaned || "default";
}

function setRenderJob(jobId: string, job: RenderJob) {
  // Carry forward the owner userId across status updates so it's always recorded
  // (the render-status legacy branch uses it for an ownership check). Avoids having
  // to thread userId through every setRenderJob call site.
  if (job.userId === undefined) {
    const prev = renderJobs.get(jobId) ?? readPersistedJob(jobId);
    if (prev?.userId) job = { ...job, userId: prev.userId };
  }
  renderJobs.set(jobId, job);
  persistJob(jobId, job);
}

function getRenderJob(jobId: string): RenderJob | undefined {
  if (renderJobs.has(jobId)) return renderJobs.get(jobId);
  // Fallback: read from disk (hot-reload created a new module instance)
  const persisted = readPersistedJob(jobId);
  if (persisted) {
    renderJobs.set(jobId, persisted);
    return persisted;
  }
  return undefined;
}

// Cache the Remotion webpack bundle across requests AND across pm2 restarts.
// Bundle path + mtime saved to the render tmp dir so pm2 restarts
// don't re-bundle from scratch (bundling takes 2-5 min on low-CPU VPS).
let cachedBundleLocation: string | null = null;
let cachedBundleMtime: string = "";

function loadBundleCache() {
  const tmpDir = getRenderTmpDir();
  const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
  if (cachedBundleLocation) return; // already loaded in this process
  try {
    if (!fs.existsSync(cacheFile)) return;
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (
      data.bundleLocation &&
      data.entryMtime &&
      fs.existsSync(path.join(data.bundleLocation, "index.html"))
    ) {
      cachedBundleLocation = data.bundleLocation;
      cachedBundleMtime = data.entryMtime;
      console.log(`[Render] restored bundle cache from disk: ${cachedBundleLocation}`);
    }
  } catch {}
}

function saveBundleCache() {
  const tmpDir = getRenderTmpDir();
  const cacheFile = path.join(tmpDir, "remotion-bundle-cache.json");
  try {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ bundleLocation: cachedBundleLocation, entryMtime: cachedBundleMtime })
    );
  } catch {}
}

// Design-doc §8 error contract: { code, provider, message, userAction, retryable }.
// `detail` duplicates the Thai message as a plain string for legacy clients that
// render data.error / data.detail directly (e.g. video-creator's ApiCallError message).
function quotaExceededResponse(message: string, opts?: { canBuyCredits?: boolean }) {
  return NextResponse.json(
    {
      error: {
        code: "quota_exceeded",
        provider: "heroai",
        message,
        userAction: opts?.canBuyCredits
          ? "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ"
          : "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
        retryable: false,
        ...(opts?.canBuyCredits ? { canBuyCredits: true } : {}),
      },
      detail: message,
    },
    { status: 403 }
  );
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  loadBundleCache();
  let quotaReserved = false;
  let reservedUserId: string | null = null;
  // Funding source of THIS reservation when it overflowed minutes → credits. Stays null
  // for the minute/clip path → every refund/record below routes to the original bucket
  // (byte-identical when CREDITS_LIVE is off, since reserveMinutesOrCredits never enters
  // the credit branch and these stay null).
  let creditsSpent: number | null = null;
  let creditBalanceAfter: number | null = null;
  // Minute-quota flag (default OFF → byte-identical clip-cap behavior). When ON, the
  // unit reserved/refunded/recorded is whole minutes-by-output-duration instead of clips.
  const useMinuteQuota = process.env.MINUTE_QUOTA === "1";
  // Credit-overflow flag (default OFF → byte-identical). When ON, an out-of-minutes
  // reserve silently spends purchased credits instead of walling.
  const creditsLive = process.env.CREDITS_LIVE === "1";
  // Minutes to reserve, computed once the output duration is known (after
  // requestedDurationSec below, before the reserve). Initialized to 0 only to keep it
  // definitely-assigned for the outer setup-error refund; it is reassigned to the real
  // (>=1) value before any reserve runs, so the reserve never under-charges with 0.
  let reservedMinutes = 0;
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const renderTmpDir = getRenderTmpDir();
    // Windows uses TEMP / TMP — TMPDIR is a Unix-only convention and is ignored on Windows.
    // Set all three so Remotion picks up the correct temp dir on every platform.
    process.env.TMPDIR = renderTmpDir;
    process.env.TEMP  = renderTmpDir;
    process.env.TMP   = renderTmpDir;

    // Ensure renderTmpDir itself exists so Remotion's mkdirSync(newDir) (non-recursive) succeeds
    // when it creates its per-job subfolder inside our custom temp dir.
    try { fs.mkdirSync(renderTmpDir, { recursive: true }); } catch {}

    const userId = authUser.id;

    // Parse the body up-front. We need it BEFORE the quota pre-check to decide whether
    // this request is a FREE burn — a BURN (subtitle overlay) of a base render THIS
    // user already paid for must never be pre-checked OR reserved (otherwise a near-cap
    // user who finished a clip can't export it). `isSubtitleOverlay` is client-controlled,
    // so it alone CANNOT grant the skip; we verify the burn's source video resolves to a
    // ChargedClip we recorded for THIS user (recorded only when a base render actually
    // reserved + completed). Foreign/external/fabricated sources are not found → charge.
    // This still runs before any heavy work (job cancellation / bundle / render), so the
    // PR-1 fail-fast property is preserved.
    const { scenes, audioUrl, videoDuration, captions, captionSegments, avatarVideoUrl, captionStyleId, positionY, fontSizeOverride, fontWeightOverride, customCaptionStyle, width: customWidth, height: customHeight, shortVideoConfig, subtitleOverlayConfig, fps: requestedFps, jpegQuality: requestedJpegQuality, jobScopeId, videoId, parentJobId } = await req.json();

    // Support both old `captionSegments` and new `captions` field names
    const captionsData = captions ?? captionSegments ?? [];

    // avatarVideoUrl mode: render avatar video + caption overlay
    const isAvatarMode = !!avatarVideoUrl;
    const isShortVideo = !!shortVideoConfig;
    const isSubtitleOverlay = !!subtitleOverlayConfig;
    const renderScopeId = normalizeRenderScopeId(jobScopeId);
    const renderOwnerKey = `${userId}:${renderScopeId}`;

    // A burn is free IFF it references a base render this user already paid for.
    // NOT-found (external / another user's render / fabricated) → falls through and is
    // charged like a normal render below. Server-side check — not gameable from the client.
    const burnAlreadyPaid =
      isSubtitleOverlay && (await isBurnAlreadyPaid(userId, subtitleOverlayConfig?.videoUrl));

    // PR-1 fail-fast: เช็คโควต้าก่อนทำงานหนักทุกอย่าง (ก่อนยกเลิก job เดิม + ก่อน bundle/render).
    // อ่านอย่างเดียว ไม่กินโควต้า — reserveClipUsage ด้านล่างยังเป็นตัวจองจริง (atomic) ตัวเดียว.
    // ข้าม pre-check เฉพาะ burn ที่จ่ายแล้ว (ของตัวเอง) — burn แบบนั้น "ห้ามถูกบล็อก".
    if (!burnAlreadyPaid) {
      if (useMinuteQuota) {
        const quotaCheck = await checkMinuteQuota(userId);
        if (!quotaCheck.allowed) return quotaExceededResponse(quotaCheck.message ?? "โควต้านาทีรอบนี้ใช้ครบแล้ว");
      } else {
        const quotaCheck = await checkClipQuota(userId);
        if (!quotaCheck) return NextResponse.json({ error: "User not found" }, { status: 404 });
        if (!quotaCheck.allowed) return quotaExceededResponse(quotaCheck.message);
      }
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (!isSubtitleOverlay && !isShortVideo && !isAvatarMode && (!Array.isArray(scenes) || scenes.length === 0)) {
      return NextResponse.json({ error: "scenes, avatarVideoUrl, shortVideoConfig, or subtitleOverlayConfig is required" }, { status: 400 });
    }

    const fps = [24, 30, 50, 60].includes(Number(requestedFps)) ? Number(requestedFps) : 30;
    const explicitDurationSec = Number(videoDuration);
    const configDurationFrames = Number(shortVideoConfig?.durationInFrames ?? subtitleOverlayConfig?.durationInFrames);
    const requestedDurationSec =
      Number.isFinite(explicitDurationSec) && explicitDurationSec > 0
        ? explicitDurationSec
        : Number.isFinite(configDurationFrames) && configDurationFrames > 0
          ? configDurationFrames / fps
          : null;

    // Minutes to reserve, from the best available output duration at reserve-time.
    // requestedDurationSec is null only when no explicit duration AND no config frames
    // were supplied; minutesFromSeconds then falls back to 60s → 1 min (never 0/under-charge).
    // This is computed BEFORE the reserve (~below) and stays in scope for every refund path.
    reservedMinutes = minutesFromSeconds(requestedDurationSec ?? 60);

    const planLimits = limitsForPlan(dbUser.plan);
    if (requestedDurationSec && requestedDurationSec > planLimits.durationSec) {
      // Backstop only — the editor pre-flights this before TTS/HeyGen (see runAll).
      // Structured shape so handlePlanError shows the right upgrade tier (Pro→Business).
      const next = nextPlanFor(dbUser.plan);
      const capMin = planLimits.durationSec / 60;
      const message = `คลิปยาว ${(requestedDurationSec / 60).toFixed(1)} นาที เกินเพดานแผน ${PLAN_LABEL[dbUser.plan] ?? dbUser.plan} (${capMin} นาที/คลิป)`;
      const userAction = next
        ? `อัปเกรดเป็น ${PLAN_LABEL[next]} (รองรับสูงสุด ${limitsForPlan(next).durationSec / 60} นาที/คลิป) หรือตัดคลิปให้สั้นลง`
        : "ตัดคลิปให้สั้นลง";
      return NextResponse.json(
        { error: { code: "duration_exceeded", message, userAction, plan: dbUser.plan, neededPlan: next } },
        { status: 403 }
      );
    }

    // jobId doubles as the bearer token for the cookie-less, sendBeacon-driven
    // render-cancel route, so it must be unguessable: 128-bit crypto randomness,
    // not Math.random (which left the suffix only 6 base36 chars + a known userId prefix,
    // letting one user enumerate & cancel another user's in-flight render).
    const jobId = `${userId}-${Date.now()}-${randomBytes(16).toString("hex")}`;
    // Register this as the latest job for this render scope before cancelling the old one, so its
    // background catch can identify itself as superseded and refund the reserved usage.
    latestJobPerRenderScope.set(renderOwnerKey, jobId);

    const prevCancel = activeRenderCancel.get(renderOwnerKey);
    if (prevCancel) {
      console.log(`[Render] cancelling previous job for scope ${renderOwnerKey}`);
      prevCancel();
      // Wait only when the previous job is already inside renderMedia and has a
      // real cancel handle. Queued/bundling jobs are superseded by latestJobPerRenderScope
      // and will self-cancel before entering renderMedia; waiting for them here
      // makes the next request inherit the old queue delay.
      const prevDone = renderJobDoneByUser.get(renderOwnerKey);
      if (prevDone) {
        console.log(`[Render] waiting for previous active render to finish before starting ${jobId}`);
        await prevDone;
        console.log(`[Render] previous active render finished — starting ${jobId}`);
      }
    } else if (renderJobDoneByUser.has(renderOwnerKey)) {
      console.log(`[Render] superseding queued/pre-render job for scope ${renderOwnerKey} without waiting`);
    }

    // Queue-path scope identity. The in-memory cancel-registry above (legacy path)
    // can't supersede a prior render here because the queue renders in a SEPARATE
    // worker process and this route returns at enqueue. So for the queue path we
    // supersede via the RenderJob table (DB-level, cross-process) using the SAME scope
    // identity as the legacy path — `renderOwnerKey` (`${userId}:${renderScopeId}`).
    // Only when jobScopeId was actually supplied: without it renderScopeId defaults to
    // "default", and we must NOT collapse unrelated MCP jobs (which dedupe via
    // idempotencyKey) into one shared scope → leave scopeKey null + skip supersede.
    const queueScopeKey =
      process.env.RENDER_VIA_QUEUE === "1" && typeof jobScopeId === "string" && jobScopeId.trim()
        ? renderOwnerKey
        : null;
    if (queueScopeKey) {
      // Cancel any in-flight job (QUEUED → CANCELLED+refund; RUNNING → cancelRequested,
      // worker finishes it) for this scope+user before reserving/enqueuing a new one.
      // Targets only QUEUED/RUNNING of the SAME scope, so a normal sequential
      // RENDER→BURN is unaffected (the prior RENDER is already DONE by burn time).
      await supersedeScope(queueScopeKey, userId).catch((e) => {
        console.error(`[Render] supersedeScope failed for scope ${queueScopeKey}:`, e);
        return 0;
      });
    }

    // Count a clip ONCE per video. Skip reserve IFF this is a BURN of a base render
    // THIS user already paid for (burnAlreadyPaid, verified server-side above) — that
    // video's clip was already charged at its base RENDER, so re-reserving would charge
    // it twice (and a free burn never reaches any refund path, so a second reserve would
    // leak quota permanently). An UNPAID burn (external / foreign / fabricated source)
    // is NOT skipped: it reserves like a normal render — no free-render bypass. Both the
    // legacy and queue paths share this single gate.
    if (burnAlreadyPaid) {
      // FREE: burn of this user's own paid render — never reserve, never block.
    } else if (useMinuteQuota) {
      // Reserve minutes; with CREDITS_LIVE on, silently overflow to credits when the
      // monthly minute quota is exhausted. CREDITS_LIVE off → reserveMinutesOrCredits
      // never enters the credit branch, so this is byte-identical to reserveMinutes.
      const result = await reserveMinutesOrCredits(userId, reservedMinutes, { creditsLive, ref: jobId });
      // Race guard: คำขออื่นของ user เดียวกันอาจกินโควต้าไประหว่าง precheck → reserve
      if (!result.allowed) return quotaExceededResponse(result.message ?? "โควต้านาทีรอบนี้ใช้ครบแล้ว", { canBuyCredits: creditsLive });
      quotaReserved = true;
      reservedUserId = userId;
      if (result.via === "credits") {
        // Funded by credits (minute meter untouched). Carry the spend + post-spend
        // balance for the bucket-aware refund and the receipt surfaced on the job.
        creditsSpent = result.creditsSpent;
        creditBalanceAfter = result.balanceAfter;
      }
    } else {
      const quota = await reserveClipUsage(userId);
      if (!quota) return NextResponse.json({ error: "User not found" }, { status: 404 });
      // Race guard: คำขออื่นของ user เดียวกันอาจกินโควต้าคลิปสุดท้ายไประหว่าง precheck → reserve
      if (!quota.allowed) return quotaExceededResponse(quota.message);
      quotaReserved = true;
      reservedUserId = userId;
    }

    const progressFile = path.join(renderTmpDir, `render-progress-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    const writeProgress = (data: Record<string, unknown>) => {
      try {
        fs.writeFileSync(progressFile, JSON.stringify({ jobId, updatedAt: Date.now(), ...data }));
      } catch {}
    };

    const safeDuration = requestedDurationSec ?? 60;
    const durationInFrames = Math.max(Math.round(safeDuration * fps), fps);
    // Note: AvatarComposition uses calculateMetadata to auto-detect duration from video,
    // so durationInFrames below is only used as fallback for non-avatar mode.

    // webpackIgnore prevents Turbopack from statically analyzing these imports
    // and traversing into esbuild native binaries (README.md, .node files).
    // serverExternalPackages ensures they're loaded from node_modules at runtime.
    // The bundle/selectComposition/renderMedia core now lives in runRender; the
    // route only needs makeCancelSignal to own the cancel handle (registered in
    // the cancel-registry exactly as before).
    const { makeCancelSignal } = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);

    // Ensure output directory exists (moved up so cacheImageLocally can use rendersDir)
    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Clean up stale Remotion bundles from render temp dir to prevent disk full
    try {
      if (process.platform !== "win32") {
        // Clean assets older than 30 min and webpack bundles older than 60 min.
        // Exclude the active cached bundle so an aging-but-in-use bundle isn't deleted
        // out from under a concurrent render.
        const activeBundleNames = new Set(activeRemotionBundleNames());
        if (cachedBundleLocation) activeBundleNames.add(path.basename(cachedBundleLocation));
        runTmpCleanup(renderTmpDir, "remotion-*assets*", 30);
        runTmpCleanup(renderTmpDir, "remotion-webpack-bundle-*", 60, activeBundleNames);
        runTmpCleanup(renderTmpDir, "react-motion-render*", 60);
      }
    } catch {}

    // Derive base URL from request so Remotion's Chromium can fetch assets from Next.js server.
    // Force http for localhost — Next.js runs plain HTTP internally even behind an HTTPS reverse proxy.
    // Using https://localhost causes SSL handshake failures (EPROTO wrong version number).
    const reqUrl = new URL(req.url);
    const isLocalhost = reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1";
    // On VPS behind nginx, req.url is localhost:3000 — use NEXTAUTH_URL (public domain) instead
    const baseUrl = (isLocalhost && process.env.NEXTAUTH_URL)
      ? process.env.NEXTAUTH_URL.replace(/\/$/, "")
      : isLocalhost
      ? `http://${reqUrl.host}`
      : `${reqUrl.protocol}//${reqUrl.host}`;


    const entryPoint = path.resolve(process.cwd(), "src/remotion/index.tsx");

    // Pre-download external image URLs so Remotion doesn't fetch them during render
    // (external URLs may expire or be rate-limited → causes white frames)
    let resolvedScenes = scenes;
    if (!isAvatarMode && Array.isArray(scenes)) {
      resolvedScenes = await Promise.all(
        scenes.map(async (sc: { imageUrl?: string | null; [key: string]: unknown }) => ({
          ...sc,
          imageUrl: sc.imageUrl ? await cacheImageLocally(sc.imageUrl, rendersDir, baseUrl) : sc.imageUrl,
        }))
      );
    }

    // For ShortVideo: resolve all relative paths → absolute URL so Remotion's Chromium can fetch
    // Remotion runs its own Chromium instance on a separate port — it cannot use relative paths.
    const stocksDir = path.join(process.cwd(), "stocks");
    function resolveStockUrl(url: string | undefined | null): string {
      if (!url) return url ?? "";
      // Normalise absolute URLs pointing to our own server → relative path
      if (url.startsWith("http://") || url.startsWith("https://")) {
        try {
          const u = new URL(url);
      if (
        u.pathname.startsWith("/api/stocks/") ||
        u.pathname.startsWith("/api/renders/stock-") ||
        u.pathname.startsWith("/renders/stock-")
      ) {
        url = u.pathname;
      } else {
        return url; // external URL, leave as-is
      }
    } catch {
      return url;
    }
  }
  // Client may send old /api/renders/stock-xxx.mp4 or /renders/stock-xxx.mp4 URLs
  // Only redirect to stocks/ if the file actually exists there — otherwise keep serving from renders/
  if (url.startsWith("/api/renders/stock-") || url.startsWith("/renders/stock-")) {
    const filename = url.startsWith("/api/renders/")
      ? url.slice("/api/renders/".length)
      : url.slice("/renders/".length);

    // Helper: find file by exact name or fuzzy numeric ID match
    function findInDir(dir: string, target: string): string | null {
      const exact = path.join(dir, target);
      if (fs.existsSync(exact) && fs.statSync(exact).size > 1_500) return target;
      // Extract numeric ID suffix e.g. "9001028" from "stock-xxx-student-studying-tex-9001028.mp4"
      const numMatch = target.match(/-(\d{5,10})\.mp4$/);
      if (!numMatch) return null;
      const numId = numMatch[1];
      try {
        const files = fs.readdirSync(dir);
        const found = files.find(f => f.endsWith(".mp4") && f.includes(numId));
        if (found) {
          const fp = path.join(dir, found);
          if (fs.statSync(fp).size > 1_500) return found;
        }
      } catch {}
      return null;
    }

    const stockFound = findInDir(stocksDir, filename);
    if (stockFound) {
      url = `/api/stocks/${stockFound}`;
    } else {
      const renderFound = findInDir(rendersDir, filename);
      if (renderFound) {
        url = `/api/renders/${renderFound}`;
      } else {
        throw new Error(`Stock file missing: ${url} — please re-fetch stock videos`);
      }
    }
  }
      if (!url.startsWith("/api/stocks/")) return url;

      const filename = url.slice("/api/stocks/".length);
      const srcPath = path.join(stocksDir, filename);
      const srcStat = fs.existsSync(srcPath) ? fs.statSync(srcPath) : null;
      if (!srcStat || srcStat.size <= 1_500) {
        throw new Error(`Stock file missing or too small: ${url} — please re-fetch stock videos`);
      }

      const symlinkPath = path.join(rendersDir, filename);
      if (!fs.existsSync(symlinkPath)) {
        try {
          fs.copyFileSync(srcPath, symlinkPath);
        } catch (copyErr) {
          console.warn(`[render] copy to renders/ failed for ${filename}, serving from stocks/ directly:`, copyErr);
        }
      }
      // Always serve from /api/stocks/ — renders/ copy is just a convenience mirror, not required
      return `${baseUrl}/api/stocks/${filename}`;
    }

    // Security: resolve a user-supplied path fragment against a known base directory
    // and return the absolute path only if it stays inside that base.
    // Handles URL-encoded traversal sequences (e.g. %2e%2e) via decodeURIComponent.
    function withinDir(baseDir: string, rest: string): string | null {
      let decoded: string;
      try { decoded = decodeURIComponent(rest); } catch { return null; }
      const resolved = path.resolve(baseDir, decoded);
      // Must be the base dir itself or strictly inside it
      if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;
      return resolved;
    }

    const musicDir = path.join(process.cwd(), "public", "music");

    function toLocalFilePath(url: string): string | null {
      if (!url) return null;
      if (url.startsWith("/api/renders/")) return withinDir(rendersDir, url.slice("/api/renders/".length));
      if (url.startsWith("/renders/")) return withinDir(rendersDir, url.slice("/renders/".length));
      if (url.startsWith("/api/stocks/")) return withinDir(stocksDir, url.slice("/api/stocks/".length));
      if (url.startsWith("/api/music/")) return withinDir(musicDir, url.slice("/api/music/".length));
      if (url.startsWith("/music/")) return withinDir(musicDir, url.slice("/music/".length));
      // absolute URL pointing to our own server
      try {
        const u = new URL(url);
        if (u.pathname.startsWith("/renders/")) return withinDir(rendersDir, u.pathname.slice("/renders/".length));
        if (u.pathname.startsWith("/api/renders/")) return withinDir(rendersDir, u.pathname.slice("/api/renders/".length));
        if (u.pathname.startsWith("/api/stocks/")) return withinDir(stocksDir, u.pathname.slice("/api/stocks/".length));
        if (u.pathname.startsWith("/api/music/")) return withinDir(musicDir, u.pathname.slice("/api/music/".length));
        if (u.pathname.startsWith("/music/")) return withinDir(musicDir, u.pathname.slice("/music/".length));
      } catch {}
      return null;
    }

    function toLocalFilePathIfInternal(url: string): string | null {
      if (!url) return null;
      if (url.startsWith("/api/") || url.startsWith("/music/")) return toLocalFilePath(url);
      if (/^https?:\/\//.test(url)) {
        try {
          const parsed = new URL(url);
          const baseOrigin = new URL(baseUrl).origin;
          if (parsed.origin === `${new URL(req.url).origin}` || parsed.origin === baseOrigin) {
            return toLocalFilePath(parsed.pathname);
          }
        } catch {
          return null;
        }
      }
      return null;
    }

    function assertExistingAsset(url: string, label: string) {
      const localPath = toLocalFilePathIfInternal(url);
      if (!localPath) return;
      if (!fs.existsSync(localPath) || fs.statSync(localPath).size <= 1_500) {
        throw new Error(`Missing ${label} asset: ${url}`);
      }
    }

    // BGM is decorative + best-effort: NEVER fail the whole render over music. Return
    // the value only if it's a real playable asset, else drop it (render with no music).
    // Guards against a stray bgm value (e.g. a bare track name "Groove" the MCP client
    // sent) that isn't an internal path → would otherwise crash Remotion's <Audio>.
    function safeBgmOrDrop(bgm: string | undefined | null): string | undefined {
      if (!bgm) return undefined;
      const localPath = toLocalFilePathIfInternal(bgm);
      if (localPath) {
        if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1_500) return bgm;
        console.warn(`[render] dropping bgm (file missing): ${bgm}`);
        return undefined;
      }
      if (bgm.startsWith("http://") || bgm.startsWith("https://")) return bgm; // external, trust
      console.warn(`[render] dropping bgm (not a playable src): ${bgm}`);
      return undefined;
    }

    function toAbsolute(url: string | undefined | null): string {
      if (!url) return url ?? "";
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      // Rewrite /music/ → /api/music/ so Next.js API route serves the file dynamically
      if (url.startsWith("/music/")) return `${baseUrl}/api/music/${url.slice("/music/".length)}`;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return url;
    }

    // Probe actual video duration with ffmpeg — avoids "No frame found" errors
    // when config asks for a frame beyond the actual stock file length.
    // ffmpeg writes duration to stderr in format: "Duration: 00:00:51.30, ..."
    async function probeVideoDurationSec(localPath: string): Promise<number | null> {
      const ffmpeg = getFfmpegPath();
      return new Promise((resolve) => {
        const proc = spawn(ffmpeg, ["-i", localPath], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 5000);
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", () => {
          clearTimeout(timer);
          const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
          if (!m) { resolve(null); return; }
          const h = parseInt(m[1], 10), mn = parseInt(m[2], 10), s = parseFloat(m[3]);
          const total = h * 3600 + mn * 60 + s;
          resolve(Number.isFinite(total) && total > 0 ? total : null);
        });
        proc.on("error", () => { clearTimeout(timer); resolve(null); });
      });
    }

    let resolvedShortConfig = shortVideoConfig;
    if (isShortVideo && shortVideoConfig) {
      // Resolve each bgVideo — skip files that aren't in stocks/ (stale client state)
      // Also probe duration and clamp clipDuration/end-start to avoid out-of-range frames
      const resolvedBgVideos: typeof shortVideoConfig.bgVideos = [];
      for (const v of shortVideoConfig.bgVideos ?? []) {
        try {
          const resolvedSrc = toAbsolute(resolveStockUrl(v.src));
          // Probe local file for actual duration
          const localPath = toLocalFilePathIfInternal(resolvedSrc);
          let actualDur: number | null = null;
          if (localPath) actualDur = await probeVideoDurationSec(localPath);

          let safeClipDuration = v.clipDuration;
          let safeEnd = v.end;
          let safeClipOffset = v.clipOffset ?? 0;
          if (actualDur != null) {
            // 0.5s safety margin — compositor errors happen when the last frames
            // are missing from the container even though the duration header claims they exist
            const safeMax = Math.max(0.5, actualDur - 0.5);
            if (!safeClipDuration || safeClipDuration > safeMax) safeClipDuration = safeMax;
            const segLen = v.end - v.start;
            if (segLen > safeMax) {
              safeEnd = v.start + safeMax;
              console.warn(`[render] clamped bgVideo segment ${(v.end - v.start).toFixed(2)}s → ${(safeEnd - v.start).toFixed(2)}s (file is ${actualDur.toFixed(2)}s)`);
            }
            // Clamp clipOffset so startFrom never exceeds safe duration
            if (safeClipOffset >= safeMax) {
              safeClipOffset = safeClipOffset % safeMax;
            }
          }
          resolvedBgVideos.push({ ...v, src: resolvedSrc, end: safeEnd, clipDuration: safeClipDuration, clipOffset: safeClipOffset });
        } catch (e) {
          console.warn(`[render] skipping missing bgVideo: ${v.src} — ${(e as Error).message}`);
        }
      }
      if (resolvedBgVideos.length === 0) {
        throw new Error("ไม่มี stock video ที่ใช้ได้ — กรุณา RERUN ขั้นตอน Stock แล้วลองใหม่");
      }

      // Gap-fill pass: if a segment was clamped short, extend the NEXT segment's start
      // back to fill the gap — prevents black screen between clips (which makes subs
      // look out of sync even when timing is correct)
      for (let i = 0; i < resolvedBgVideos.length - 1; i++) {
        const cur  = resolvedBgVideos[i];
        const next = resolvedBgVideos[i + 1];
        if (next.start > cur.end + 0.04) {
          console.warn(`[render] gap ${cur.end.toFixed(2)}s→${next.start.toFixed(2)}s — extending next segment back`);
          next.start = cur.end;
        }
      }

      resolvedShortConfig = {
        ...shortVideoConfig,
        voiceFile: toAbsolute(resolveStockUrl(shortVideoConfig.voiceFile)),
        bgmFile: safeBgmOrDrop(toAbsolute(resolveStockUrl(shortVideoConfig.bgmFile))),
        bgVideos: resolvedBgVideos,
      };
      if (resolvedShortConfig.voiceFile) assertExistingAsset(resolvedShortConfig.voiceFile, "voice");
      // bgm: safeBgmOrDrop already removed any unplayable value — never throws on music
      console.log("[render] stock assets prepared from stocks -> renders");
      console.log(`[render] voiceFile: ${resolvedShortConfig.voiceFile}`);
      console.log(`[render] bgmFile: ${resolvedShortConfig.bgmFile}`);
      resolvedShortConfig.bgVideos?.forEach((v: { src: string; start: number; end: number; clipDuration?: number; clipOffset?: number }, i: number) =>
        console.log(`[render] bgVideo[${i}]: start=${v.start.toFixed(2)} end=${v.end.toFixed(2)} dur=${((v.end-v.start)).toFixed(2)} clipDuration=${v.clipDuration ?? "?"} clipOffset=${v.clipOffset ?? 0} src=${v.src.split("/").pop()}`)
      );
    }

    // For SubtitleOverlay: resolve videoUrl → absolute URL, and bgmFile (if any)
    // to a real on-disk asset so Remotion's <Audio> can load it (the avatar path
    // mixes BGM in at this burn step).
    let resolvedSubtitleConfig = subtitleOverlayConfig;
    if (isSubtitleOverlay && subtitleOverlayConfig) {
      const videoUrl = subtitleOverlayConfig.videoUrl;
      const resolvedUrl = videoUrl?.startsWith("/") ? `${baseUrl}${videoUrl}` : videoUrl;
      const resolvedBgm = subtitleOverlayConfig.bgmFile
        ? safeBgmOrDrop(toAbsolute(resolveStockUrl(subtitleOverlayConfig.bgmFile)))
        : undefined;
      resolvedSubtitleConfig = { ...subtitleOverlayConfig, videoUrl: resolvedUrl, bgmFile: resolvedBgm };
      if (resolvedSubtitleConfig.videoUrl) assertExistingAsset(videoUrl!, "subtitle video");
      // bgm: best-effort, dropped if unplayable (no throw)
      console.log(`[render] subtitle-overlay bgmFile: ${resolvedBgm ?? "(none)"}`);
      // Warmup /api/stocks route so Remotion doesn't timeout on first compile
      if (resolvedUrl?.includes("/api/stocks/")) {
        try { await fetch(resolvedUrl, { method: "HEAD" }); } catch {}
      }
    }

    // FREE-tier watermark: only add the overlay for FREE plan renders.
    // Paid plans (PRO / BUSINESS) must never be watermarked. Default false when plan unknown.
    const watermark = dbUser.plan === "FREE";

    // Fully-resolved render core input. The legacy in-process path consumes this
    // directly; the queue path persists the JSON-serializable subset (everything
    // EXCEPT bundleCache, which is a process-level object passed by reference) and
    // a future worker reconstructs the full input with its own bundleCache.
    const renderInput: ResolvedRenderInput = {
      isSubtitleOverlay,
      isShortVideo,
      isAvatarMode,
      resolvedSubtitleConfig,
      resolvedShortConfig,
      resolvedScenes,
      audioUrl: audioUrl ?? null,
      captionsData,
      avatarVideoUrl: avatarVideoUrl ?? null,
      captionStyleId,
      // Strip url()/expression()/@import from the unvalidated style before it reaches
      // Remotion inline styles (covers both the queue payload and the legacy path).
      customCaptionStyle: stripDangerousCss(customCaptionStyle),
      positionY,
      fontSizeOverride,
      fontWeightOverride,
      durationInFrames,
      customWidth,
      customHeight,
      fps,
      requestedJpegQuality,
      entryPoint,
      bundlePublicDir: getRemotionBundlePublicDir(),
      rendersDir,
      watermark,
      // Shared bundle cache — process-level, on the caller, passed by reference so
      // it is reused across requests/hot-reloads. NEVER persisted (has methods).
      bundleCache: {
        get: () => ({ location: cachedBundleLocation, mtime: cachedBundleMtime }),
        set: (location: string | null, mtime: string) => {
          cachedBundleLocation = location;
          cachedBundleMtime = mtime;
          saveBundleCache();
        },
      },
    };

    // PR-7: durable queue path (behind RENDER_VIA_QUEUE). Enqueue a RenderJob row
    // and return its id instead of rendering in-process. This request reserved a clip
    // above EXACTLY when `quotaReserved` is true (base RENDER, or an UNPAID burn) and
    // did NOT reserve when `burnAlreadyPaid` (a free burn of the user's own render). We
    // flag the row with markReserved=quotaReserved so failRenderJob refunds iff this job
    // actually charged — a free burn holds no reservation, an unpaid burn refunds on fail
    // just like a render. The worker claims the row, rebuilds the full input (adding its
    // own bundleCache), renders, and records the ChargedClip on success (RENDER only).
    if (process.env.RENDER_VIA_QUEUE === "1") {
      const isBurn = isSubtitleOverlay; // !!body.subtitleOverlayConfig
      // The bundleCache reference cannot cross to a separate worker process — strip it.
      // Everything else in ResolvedRenderInput is plain data/URLs/numbers (serializable).
      const { bundleCache: _bundleCache, ...serializablePayload } = renderInput;
      const { id } = await enqueueRenderJob({
        userId,
        type: isBurn ? "BURN" : "RENDER",
        payload: serializablePayload,
        videoId: typeof videoId === "string" ? videoId : undefined,
        parentJobId: typeof parentJobId === "string" ? parentJobId : undefined,
        // Globally-unique key (NOT content-derived). Use the route's own jobId.
        idempotencyKey: jobId,
        // Flag the row so failRenderJob refunds iff THIS job reserved a clip. True for a
        // base RENDER and for an UNPAID burn (both reserved above); false only for a FREE
        // burn (burnAlreadyPaid) which holds no reservation to refund.
        markReserved: quotaReserved,
        // Minutes already reserved by THIS route above (MINUTE_QUOTA on). Persisted on
        // RenderJob.reservedMinutes so failRenderJob/supersedeScope refund the SAME unit
        // (minutes) the route charged — never refundClipUsage on a minutes-mode job.
        // Only when this job actually reserved (quotaReserved): a free burn holds nothing.
        // Flag off → undefined → row stays clips-mode (reservedMinutes null), unchanged.
        reservedMinutes: useMinuteQuota && quotaReserved ? reservedMinutes : undefined,
        // Credits spent if THIS reserve overflowed minutes → credits (CREDITS_LIVE on).
        // Persisted on RenderJob.creditsSpent so failRenderJob/supersedeScope refund the
        // SAME bucket (credits, not minutes/clips) and the receipt can be surfaced.
        // Null/flag-off → undefined → row stays minute/clip-funded (creditsSpent null),
        // byte-identical to before.
        creditsSpent: creditsSpent ?? undefined,
        // Scope identity for cross-process supersession (null when no jobScopeId).
        // Applied to both RENDER and BURN: supersede only targets QUEUED/RUNNING of the
        // same scope, so a sequential RENDER→BURN is unaffected (prior step is DONE).
        scopeKey: queueScopeKey,
      });
      return NextResponse.json({ jobId: id });
    }

    // Clear stale progress file and register job immediately — before bundle build
    writeProgress({ progress: 0, stage: "preparing", queued: false, queuePosition: null });
    setRenderJob(jobId, { status: "running", startedAt: Date.now(), userId });
    incrementActiveRenderCount();

    // Fire-and-forget: bundle + render in background so HTTP response returns immediately.
    // Client polls /api/videos/render-progress for % and /api/videos/render-status?jobId= for result.
    let resolveDone!: () => void;
    const donePromise = new Promise<void>(resolve => { resolveDone = resolve; });
    renderJobDoneByUser.set(renderOwnerKey, donePromise);

    (async () => {
      let renderStartedAt = Date.now();
      let jobFinalized = false;
      let quotaRefunded = false;
      let renderCancelFn: (() => void) | null = null;
      const clearCancelHandles = () => {
        if (renderCancelFn && activeRenderCancel.get(renderOwnerKey) === renderCancelFn) {
          activeRenderCancel.delete(renderOwnerKey);
        }
        cancelByJobId.delete(jobId);
      };
      const finishJob = () => {
        if (jobFinalized) return;
        jobFinalized = true;
        decrementActiveRenderCount();
        resolveDone();
      };
      const refundReservedClip = async () => {
        // Only refund if THIS request actually reserved a clip. A FREE burn
        // (burnAlreadyPaid → quotaReserved=false) never spent quota here — the
        // charge lives on the base render — so refunding it would wrongly credit
        // a clip back (quota leak). Matches the outer setup-error guard.
        if (quotaRefunded || !quotaReserved) return;
        quotaRefunded = true;
        // Bucket-aware: credit-funded (creditsSpent>0) → refundCredits; minute-funded
        // (MINUTE_QUOTA on → reservedMinutes) → refundMinutes; else (clips-mode/flag-off)
        // → refundClipUsage. With CREDITS_LIVE off, creditsSpent stays null, so this is
        // identical to the prior refundMinutes/refundClipUsage branch.
        await refundReservation(
          userId,
          { reservedMinutes: useMinuteQuota ? reservedMinutes : null, creditsSpent },
          `render-refund:${jobId}`
        ).catch(() => {});
      };
      const stopSupersededJob = async (stage: string) => {
        if (latestJobPerRenderScope.get(renderOwnerKey) === jobId) return false;

        console.log(`[Render] job=${jobId} superseded at ${stage} — skipping`);
        clearCancelHandles();
        const existing = getRenderJob(jobId);
        setRenderJob(jobId, {
          status: "error",
          error: "superseded",
          startedAt: existing?.startedAt ?? Date.now(),
        });
        writeProgress({ progress: -1, stage: "cancelled", error: "superseded", queued: false, queuePosition: null });
        await refundReservedClip();
        await recordTelemetryEvent(userId, {
          name: "render_server_cancelled",
          category: "pipeline",
          source: "server",
          step: "render",
          status: "cancelled",
          durationMs: Date.now() - renderStartedAt,
          properties: { jobId, stage },
        }).catch(() => {});
        finishJob();
        return true;
      };
      // Telemetry: a Remotion bundle had to be rebuilt mid-render.
      const recordBundleRetry = async (stage: string, reason: string) => {
        await recordTelemetryEvent(userId, {
          name: "render_bundle_rebuilt",
          category: "performance",
          source: "server",
          step: "render",
          status: "retry",
          durationMs: Date.now() - renderStartedAt,
          properties: { jobId, stage, reason },
        }).catch(() => {});
      };

      // The cancel signal is owned by the route (registered in the cancel-registry
      // exactly as before); runRender consumes it. Created up-front so the registry
      // wiring stays identical; the live handle is (re)registered via onCancelHandle
      // at the same point the legacy code registered it (just before renderMedia).
      const { cancel, cancelSignal } = makeCancelSignal();
      renderCancelFn = cancel;

      // The render core input was fully resolved above (renderInput) — the legacy
      // path reuses it directly. (req-bound asset resolution, baseUrl, caching, and
      // the shared by-reference bundle cache all happened before the queue branch.)

      try {
        console.log(`[Render] job=${jobId} starting, activeJobs=${getActiveRenderCount()}`);

        const { videoUrl } = await runRender(renderInput, {
          jobId,
          cancelSignal,
          cancel,
          onProgress: (pct, phase) => {
            // Mirror the legacy per-phase progress + job-state writes. queued is its
            // own hook (carries position); done is finalized after runRender returns.
            if (phase === "done") return;
            const p = Math.round(pct);
            writeProgress({ progress: p, stage: "rendering", queued: false, queuePosition: null });
            setRenderJob(jobId, { status: "running", startedAt: getRenderJob(jobId)?.startedAt ?? renderStartedAt, progress: p });
          },
          hooks: {
            recordBundleRetry,
            onQueued: (position) => {
              writeProgress({ progress: 0, stage: "queued", queued: true, queuePosition: position, queuedAt: Date.now() });
            },
            checkSuperseded: async (stage) => {
              if (latestJobPerRenderScope.get(renderOwnerKey) === jobId) return false;
              await stopSupersededJob(stage);
              return true;
            },
            onRenderStart: async (info) => {
              renderStartedAt = Date.now();
              writeProgress({ progress: 0, stage: "rendering", queued: false, queuePosition: null, renderQueueWaitMs: info.renderQueueWaitMs });
              await recordTelemetryEvent(userId, {
                name: "render_server_started",
                category: "performance",
                source: "server",
                step: "render",
                status: "started",
                properties: {
                  jobId,
                  compositionId: info.compositionId,
                  activeJobs: info.activeJobs,
                  activeRenderSlots: info.activeRenderSlots,
                  renderSlotLimit: info.renderSlotLimit,
                  renderQueueWaitMs: info.renderQueueWaitMs,
                  queuedJobs: getRenderSlotQueueLength(),
                  cpuCount: info.cpuCount,
                  renderConcurrency: info.renderConcurrency,
                  freeMemGb: info.freeMemGb,
                  fps: info.fps,
                  jpegQuality: info.jpegQuality,
                },
              }).catch(() => {});
            },
            onCancelHandle: (cancelFn) => {
              // Register the live render cancel handle exactly as the legacy route did,
              // right before renderMedia starts.
              activeRenderCancel.set(renderOwnerKey, cancelFn);
              cancelByJobId.set(jobId, cancelFn);
            },
            // Runs after renderMedia succeeds, before success telemetry — the exact
            // legacy point for clearCancelHandles() + finishJob() + render_complete.
            onRenderSucceeded: async () => {
              clearCancelHandles();
              finishJob();
              if (latestJobPerRenderScope.get(renderOwnerKey) === jobId) return false;
              await stopSupersededJob("render_complete");
              return true;
            },
            onRenderDone: async (info) => {
              await recordTelemetryEvent(userId, {
                name: "render_server_done",
                category: "performance",
                source: "server",
                step: "render",
                status: "done",
                durationMs: Date.now() - renderStartedAt,
                properties: {
                  jobId,
                  compositionId: info.compositionId,
                  activeJobs: info.activeJobs,
                  activeRenderSlots: info.activeRenderSlots,
                  renderSlotLimit: info.renderSlotLimit,
                  renderQueueWaitMs: info.renderQueueWaitMs,
                  renderConcurrency: info.renderConcurrency,
                  freeMemGb: info.freeMemGb,
                  outputMb: info.outputMb,
                },
              }).catch(() => {});
            },
          },
        });

        // Success path: runRender already ran clearCancelHandles()/finishJob() via
        // onRenderSucceeded; persist the done state + notify (route-owned). The receipt
        // fields are spread in ONLY when credit-funded (creditsSpent != null) → the
        // persisted job JSON is byte-identical to before when CREDITS_LIVE is off.
        setRenderJob(jobId, {
          status: "done",
          videoUrl,
          startedAt: getRenderJob(jobId)!.startedAt,
          ...(creditsSpent != null ? { creditsSpent } : {}),
          ...(creditBalanceAfter != null ? { creditBalanceAfter } : {}),
        });
        writeProgress({ progress: 100, stage: "done", videoUrl, queued: false, queuePosition: null });
        // Record that this user was charged a clip for THIS base-render output, so a later
        // BURN of it is free (isBurnAlreadyPaid). Only base renders that actually reserved
        // (quotaReserved && not a burn). Fail-open: a bookkeeping write must not break the
        // render — the worst case is a future burn re-charges (never a free bypass).
        if (quotaReserved && !isSubtitleOverlay) {
          // 4th arg persists the credit spend (credit-funded overflow). Null → undefined
          // → byte-identical to the prior 3-arg call (creditsSpent stays null on the row).
          await recordChargedClip(userId, videoUrl, useMinuteQuota ? reservedMinutes : undefined, creditsSpent ?? undefined).catch(() => {});
        }
        createNotification({
          userId,
          type: "VIDEO_COMPLETED",
          title: "วิดีโอสร้างเสร็จแล้ว",
          body: "วิดีโอของคุณ render เสร็จสมบูรณ์ พร้อมดาวน์โหลดได้แล้ว",
        }).catch(() => {});
      } catch (error) {
        clearCancelHandles();
        finishJob();

        // Superseded — already handled (job-state + refund) inside stopSupersededJob
        // by the checkSuperseded/onRenderSucceeded hooks. Ignore here as before.
        if (error instanceof SupersededError) return;

        // Intentional cancel (page refresh / new render) — not a real failure.
        // Don't log as error, don't mark job errored, don't notify the user.
        const detail = error instanceof Error ? error.message : String(error);
        const wasCancelled = /got cancelled|Request closed|cancelSignal|aborted/i.test(detail);
        await refundReservedClip();
        if (await stopSupersededJob("error")) return; // superseded — ignore error too

        if (wasCancelled) {
          console.log(`[Render] job=${jobId} cancelled — skipping error notification`);
          const existing = getRenderJob(jobId);
          if (existing && existing.status === "running") {
            setRenderJob(jobId, { status: "error", error: "cancelled", startedAt: existing.startedAt });
          }
          await recordTelemetryEvent(userId, {
            name: "render_server_cancelled",
            category: "pipeline",
            source: "server",
            step: "render",
            status: "cancelled",
            durationMs: Date.now() - renderStartedAt,
            properties: { jobId },
          }).catch(() => {});
          return;
        }

        console.error("Render error:", error);
        setRenderJob(jobId, { status: "error", error: detail, startedAt: getRenderJob(jobId)!.startedAt });
        writeProgress({ progress: -1, stage: "error", error: detail, queued: false, queuePosition: null });
        await recordTelemetryEvent(userId, {
          name: "render_server_error",
          category: "error",
          source: "server",
          step: "render",
          status: "error",
          durationMs: Date.now() - renderStartedAt,
          properties: {
            jobId,
            message: detail.slice(0, 220),
          },
        }).catch(() => {});

        createNotification({
            userId,
            type: "VIDEO_FAILED",
            title: "วิดีโอสร้างไม่สำเร็จ",
            body: "เกิดข้อผิดพลาดระหว่างสร้างวิดีโอ กรุณาลองใหม่อีกครั้ง",
          }).catch(() => {});
      }
    })();

    return NextResponse.json({ jobId });
  } catch (error) {
    if (quotaReserved && reservedUserId) {
      // Bucket-aware refund (mirrors the in-flight refundReservedClip). credit-funded →
      // refundCredits; minute-funded → refundMinutes; else clips. CREDITS_LIVE off →
      // creditsSpent null → identical to the prior refundMinutes/refundClipUsage branch.
      await refundReservation(
        reservedUserId,
        { reservedMinutes: useMinuteQuota ? reservedMinutes : null, creditsSpent },
        "render-setup-refund"
      ).catch(() => {});
    }
    console.error("Render setup error:", error);
    const detail = error instanceof Error ? error.message : String(error);
    if (reservedUserId) {
      await recordTelemetryEvent(reservedUserId, {
        name: "render_server_setup_error",
        category: "error",
        source: "server",
        step: "render",
        status: "error",
        durationMs: Date.now() - requestStartedAt,
        properties: { message: detail.slice(0, 220) },
      }).catch(() => {});
    }
    return NextResponse.json({ error: "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่", detail }, { status: 500 });
  }
}
