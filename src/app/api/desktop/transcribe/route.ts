import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { refundAiAudioMinutes, reserveAiAudioMinutes } from "@/lib/ai-spend-limits";
import { resolveDesktopSttProvider } from "@/lib/desktop/stt";
import { tryConsumeDesktopTranscribeRate } from "@/lib/desktop/stt/rate-limit";
import { sanitizeDesktopTranscript } from "@/lib/desktop/stt/sanitize";

export const runtime = "nodejs";
export const maxDuration = 900;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function desktopError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ code, message, ...extra }, { status });
}

function audioKind(file: File): { kind: "m4a" | "wav"; mimeType: string } | null {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (name.endsWith(".wav") || type === "audio/wav" || type === "audio/wave" || type === "audio/x-wav") {
    return { kind: "wav", mimeType: type || "audio/wav" };
  }
  if (name.endsWith(".m4a") || type === "audio/mp4" || type === "audio/x-m4a" || type === "audio/m4a") {
    return { kind: "m4a", mimeType: type || "audio/mp4" };
  }
  return null;
}

export const POST = withDesktop(async (req, principal) => {
  const rate = tryConsumeDesktopTranscribeRate(principal.userId);
  if (!rate.allowed) {
    return desktopError(429, "RATE_LIMITED", rate.message ?? "ถอดเสียงถี่เกินไป กรุณารอสักครู่แล้วลองใหม่");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return desktopError(400, "INVALID_REQUEST", "อ่านไฟล์เสียงไม่สำเร็จ — ส่งเป็น multipart แล้วลองใหม่");
  }

  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return desktopError(400, "INVALID_AUDIO", "ต้องแนบไฟล์เสียง m4a หรือ wav ในช่อง audio");
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return desktopError(413, "AUDIO_TOO_LARGE", "ไฟล์เสียงใหญ่เกิน 25 MB — บีบอัดหรือตัดให้สั้นลงแล้วอัปโหลดใหม่");
  }
  const kind = audioKind(audio);
  if (!kind) {
    return desktopError(400, "INVALID_AUDIO", "รองรับเฉพาะไฟล์ m4a หรือ wav — แปลงไฟล์แล้วอัปโหลดใหม่");
  }

  const durationSec = Number(form.get("durationSec"));
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return desktopError(400, "INVALID_DURATION", "durationSec ต้องเป็นจำนวนวินาทีที่มากกว่า 0");
  }
  const footageId = String(form.get("footageId") ?? "").trim();
  if (!footageId) {
    return desktopError(400, "INVALID_FOOTAGE", "ต้องระบุ footageId");
  }

  const minutes = Math.ceil(durationSec / 60);
  const reserved = await reserveAiAudioMinutes(principal.userId, minutes, { enforce: true });
  if (!reserved.allowed) {
    return desktopError(
      402,
      "AI_AUDIO_QUOTA",
      reserved.message ?? "ใช้เสียง AI ครบเพดานรอบนี้แล้ว — รอรอบถัดไป",
      { remaining: reserved.remaining },
    );
  }

  try {
    const provider = resolveDesktopSttProvider(principal.user);
    const raw = await provider.transcribe(Buffer.from(await audio.arrayBuffer()), {
      language: "th-TH",
      mimeType: kind.mimeType,
      durationSec,
    });
    const result = sanitizeDesktopTranscript({
      ...raw,
      language: raw.language || "th-TH",
      provider: raw.provider || provider.name,
    }, durationSec);
    return NextResponse.json(result);
  } catch (error) {
    await refundAiAudioMinutes(principal.userId, minutes).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[desktop/transcribe] STT_FAILED", { footageId, provider: resolveDesktopSttProvider(principal.user).name, detail: detail.slice(0, 200) });
    return desktopError(502, "STT_FAILED", "ถอดเสียงไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
});
