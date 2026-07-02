import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { createVideoJob } from "@/lib/mcp/video-job";
import { checkClipQuota } from "@/lib/usage-limits";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";

// POST /api/videos/jobs — Editor v2 background render (ADR 0001).
// Creates a VideoJob in PREVIEW MODE: the shared orchestrator runs the full generation
// pipeline server-side (TTS → captions → b-roll → base render → avatar composite) and
// STOPS BEFORE burn, persisting captions/config in outputJson v2 so the editor resumes
// at the subtitle phase. Processed by the same mcp-video-worker as MCP jobs.
//
// Mirrors the MCP create_video_job guards (keys, quota, in-flight cap) but with WEB
// rules: no PRO gate — FREE users render within their clip quota exactly like the
// legacy editor. Charging: the base render reserves the clip/minutes (orchestrator
// skips its burn-refund in preview mode), web burn later charges nothing extra
// (ChargedClip once-per-video, same as today's web flow).

type Body = {
  mode?: unknown; clipUrl?: unknown;
  script?: unknown; voiceProvider?: unknown; voiceId?: unknown; geminiVoiceName?: unknown;
  avatarMode?: unknown; avatarId?: unknown; avatarIntroSecs?: unknown; avatarTailSecs?: unknown;
  bgmFile?: unknown; bgmVolume?: unknown; stockSource?: unknown;
  targetClipCount?: unknown; kieModel?: unknown; autoMixProviders?: unknown;
  subtitleMode?: unknown; subtitlePosition?: unknown; idempotencyKey?: unknown;
};

// b-roll sources the v2 UI may request. kie-image / auto-mix = Beta, ADMIN only —
// gate SERVER-SIDE (the UI disables the cards, but that's not security).
const STOCK_SOURCES = new Set(["stock", "kie-image", "auto-mix"]);

const SUB_MODES = new Set(["sentence", "1", "2", "3", "4"]);
const SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const AVATAR_MODES = new Set(["none", "full", "bookend", "bookend-both"]);

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v : undefined;
}
function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    // โหมดอัปคลิปเอง (cutaway) — gate ด้วย flag เดียวกับปุ่มใน UI (flip พร้อม EDITOR_V2 วัน launch)
    const uploadMode = body.mode === "upload";
    const clipUrl = uploadMode ? str(body.clipUrl, 500) : undefined;
    if (uploadMode) {
      if (process.env.NEXT_PUBLIC_CLIP_CUTAWAY !== "1") {
        return NextResponse.json({ error: "not_enabled", message: "โหมดใช้คลิปที่ถ่ายเองยังไม่เปิดใช้งาน" }, { status: 403 });
      }
      // รับเฉพาะไฟล์ที่อัปโหลดเข้าระบบเราเอง (จาก /api/videos/upload-avatar) — กัน SSRF
      if (!clipUrl || !(clipUrl.startsWith("/api/") || clipUrl.startsWith("/renders/") || clipUrl.startsWith("/uploads/"))) {
        return NextResponse.json({ error: "invalid_clip", message: "อัปโหลดคลิปก่อนเรนเดอร์" }, { status: 400 });
      }
    }

    const script = typeof body.script === "string" ? body.script.trim() : "";
    if (!uploadMode && (!script || script.length > 20000)) {
      return NextResponse.json({ error: "invalid_script", message: "สคริปต์ว่างหรือยาวเกิน 20,000 ตัวอักษร" }, { status: 400 });
    }

    const voiceProvider = body.voiceProvider === "elevenlabs" ? "elevenlabs" : body.voiceProvider === "gemini" ? "gemini" : undefined;
    const voiceId = str(body.voiceId, 120);
    const geminiVoiceName = str(body.geminiVoiceName, 60);

    // Key guards — same checks as MCP create_video_job, same wording surface (web shows toasts)
    // upload mode ไม่ใช้ TTS → ข้าม guard ฝั่งเสียง (Gemini ยังจำเป็น: transcribe/keywords)
    const useEleven = !uploadMode && (voiceProvider === "elevenlabs" || (!voiceProvider && user.ttsProvider === "elevenlabs"));
    if (useEleven && !user.elevenlabsKey) {
      return NextResponse.json({ error: "missing_key", missingKey: "elevenlabs", message: "ต้องใส่ ElevenLabs API key ก่อน (Settings → API Keys)" }, { status: 400 });
    }
    if (useEleven && !voiceId && !user.elevenlabsVoiceId) {
      return NextResponse.json({ error: "missing_voice_id", message: "ต้องระบุ ElevenLabs Voice ID" }, { status: 400 });
    }
    try { resolveGeminiKey(user); }
    catch (e) {
      if (e instanceof KeyRequiredError) return NextResponse.json({ error: "missing_key", missingKey: "gemini", message: "ต้องใส่ Gemini API key ก่อน (Settings → API Keys)" }, { status: 400 });
      throw e;
    }
    if (!user.pexelsKey && !user.pixabayKey) {
      return NextResponse.json({ error: "missing_key", missingKey: "broll", message: "ต้องใส่ Pexels หรือ Pixabay key อย่างน้อย 1 ตัวสำหรับ B-roll" }, { status: 400 });
    }

    // Avatar (optional) — same resolver as MCP; layout falls back to the saved preset.
    // upload mode = ไม่มีอวตารตามดีไซน์
    const avatarModeRaw = !uploadMode && typeof body.avatarMode === "string" && AVATAR_MODES.has(body.avatarMode) ? body.avatarMode : undefined;
    const avatar = resolveAvatarRequest(
      {
        avatarMode: avatarModeRaw as "none" | "full" | "bookend" | "bookend-both" | undefined,
        avatarId: str(body.avatarId, 120),
        avatarIntroSecs: num(body.avatarIntroSecs, 1, 30),
        avatarTailSecs: num(body.avatarTailSecs, 1, 30),
      },
      user,
    );
    if (avatar.kind === "error") return NextResponse.json(avatar.payload, { status: 400 });
    const avatarLayout = avatar.kind === "ok"
      ? resolveAvatarLayout({}, await getAvatarPreset(user.id, avatar.avatarId))
      : null;

    // Quota + in-flight cap (shared worker, no global render queue)
    const q = await checkClipQuota(user.id);
    if (q && !q.allowed) return NextResponse.json({ error: "quota_exceeded", message: q.message }, { status: 403 });
    const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: ["queued", "processing"] } } });
    if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

    // B-roll source: "stock" (default) → orchestrator default "both"; Beta sources admin-only
    const requestedSource = typeof body.stockSource === "string" && STOCK_SOURCES.has(body.stockSource) ? body.stockSource : "stock";
    if (requestedSource !== "stock" && user.role !== "ADMIN") {
      return NextResponse.json({ error: "beta_only", message: "ภาพ AI / AutoMix ยังเปิดเฉพาะทีมงาน (Beta)" }, { status: 403 });
    }
    const stockSource = requestedSource === "stock" ? undefined : requestedSource;

    // ขั้นสูง (P6c): จำนวนคลิป + ตัวเลือก AI-gen (Beta fields ผ่านได้เฉพาะเมื่อ source เป็น Beta
    // ซึ่งผ่าน admin gate ด้านบนแล้ว)
    const targetClipCount = num(body.targetClipCount, 1, 60);
    const kieModel = stockSource ? str(body.kieModel, 60) : undefined;
    const autoMixProviders = requestedSource === "auto-mix" && Array.isArray(body.autoMixProviders)
      ? (body.autoMixProviders.filter((x) => typeof x === "string" && x.length <= 40).slice(0, 12) as string[])
      : undefined;

    const subtitleMode = typeof body.subtitleMode === "string" && SUB_MODES.has(body.subtitleMode) ? body.subtitleMode : undefined;
    const subtitlePosition = typeof body.subtitlePosition === "string" && SUB_POSITIONS.has(body.subtitlePosition) ? body.subtitlePosition : undefined;
    const bgmFile = str(body.bgmFile, 300);

    try {
      const job = await createVideoJob(
        user.id,
        {
          script: uploadMode ? "" : script,
          ...(uploadMode ? { mode: "upload", clipUrl } : {}),
          previewMode: true,
          ...(voiceProvider ? { voiceProvider } : {}),
          ...(voiceId ? { voiceId } : {}),
          ...(geminiVoiceName ? { geminiVoiceName } : {}),
          ...(avatar.kind === "ok" && avatarLayout
            ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs,
                avatarScale: avatarLayout.scale, avatarOffsetX: avatarLayout.offsetX, avatarOffsetY: avatarLayout.offsetY }
            : {}),
          ...(!uploadMode && bgmFile ? { bgmFile, bgmVolume: num(body.bgmVolume, 0, 1) } : {}),
          ...(stockSource ? { stockSource } : {}),
          ...(targetClipCount ? { targetClipCount: Math.round(targetClipCount) } : {}),
          ...(kieModel ? { kieModel } : {}),
          ...(autoMixProviders?.length ? { autoMixProviders } : {}),
          ...(subtitleMode ? { subtitleMode } : {}),
          ...(subtitlePosition ? { subtitlePosition } : {}),
        },
        str(body.idempotencyKey, 120),
      );
      return NextResponse.json({ jobId: job.id, status: "queued" });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        return NextResponse.json({ error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" }, { status: 409 });
      }
      throw e;
    }
  } catch (err) {
    console.error("[api/videos/jobs] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
