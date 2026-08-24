import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { callJaiTtsClone, jaittsConfig, JaiTtsConfigError } from "@/lib/jaitts";
import { thaiifyCloneScript } from "@/lib/clone-thai-script";
import { prepareHeroVoiceSpeechText } from "@/lib/hero-voice-speech";
import { isUserVoiceId, loadUserVoiceRef } from "@/lib/user-voices.server";
import { publicAiGenerationJob } from "@/lib/ai-generation-jobs.server";
import { videoExpiryFor } from "@/lib/plan-limits";
import { prisma } from "@/lib/prisma";

// Hero Cloning (JaiTTS) — admin-only experimental engine. CPU synthesis takes
// minutes per short script, so the request is synchronous with a long budget
// and a short script cap. No credits/minutes are reserved (admin experiment;
// revisit quota before any wider rollout).
export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Standalone JaiTTS feature — not tied to any OmniVoice rollout flag.
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let config;
  try {
    config = jaittsConfig();
  } catch (error) {
    if (error instanceof JaiTtsConfigError) {
      return NextResponse.json({ error: "Hero Cloning ยังไม่พร้อมใช้งาน", retryable: true }, { status: 503 });
    }
    throw error;
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const voiceId = typeof body?.voiceId === "string" ? body.voiceId.trim() : "";
  const parsedSpeed = typeof body?.speed === "number" ? body.speed : Number(body?.speed);
  const speed = Number.isFinite(parsedSpeed) ? Math.min(3, Math.max(0.3, parsedSpeed)) : 1;

  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (text.length > config.maxScriptChars) {
    return NextResponse.json({
      error: `Hero Cloning (ทดลอง) รองรับสคริปต์ไม่เกิน ${config.maxScriptChars} ตัวอักษร — เครื่องประมวลผลใช้เวลาหลายนาทีต่อประโยค`,
      maxChars: config.maxScriptChars,
    }, { status: 413 });
  }
  if (!isUserVoiceId(voiceId)) {
    return NextResponse.json({ error: "Hero Cloning ใช้ได้กับเสียงโคลนของคุณเท่านั้น" }, { status: 400 });
  }
  const ref = await loadUserVoiceRef(user.id, voiceId);
  if (!ref) return NextResponse.json({ error: "ไม่พบเสียงโคลนนี้" }, { status: 404 });

  // Clone-only pre-pass: Gemini แปลงสคริปต์เป็นไทยล้วนก่อน (ทับศัพท์คำต่างชาติ)
  // เพราะเสียงโคลนอ่านตัวอักษรละตินไม่ได้ — fail-open คืนข้อความเดิมเมื่อไม่มี key/ล่ม
  const thaiText = await thaiifyCloneScript(user, text);
  // Same deterministic speech pass as Hero Voice (numbers, abbreviations, dates).
  const speechText = prepareHeroVoiceSpeechText(thaiText);

  // F5-style models size the output from the reference's seconds-per-char
  // ratio: estimated total = ref + ref * (target chars / ref chars). Beyond
  // ~40s the model's max sequence blows up (tensor size mismatch upstream) —
  // reject early with an actionable message instead of burning minutes of CPU.
  const refSec = ref.durationMs / 1000;
  const estimatedTotalSec = refSec * (1 + speechText.length / Math.max(1, ref.refText.length));
  if (refSec > 0 && estimatedTotalSec > 40) {
    return NextResponse.json({
      error: "ข้อความยาวเกินกำลังของเสียงโคลนนี้ — ลองย่อข้อความให้สั้นลง หรืออัดเสียงอ้างอิงใหม่ให้พูดต่อเนื่อง 10-15 วินาทีพร้อมพิมพ์ข้อความกำกับให้ครบทุกคำ",
    }, { status: 422 });
  }

  const result = await callJaiTtsClone(config, {
    refWav: Buffer.from(ref.audioBase64, "base64"),
    refText: ref.refText,
    text: speechText,
    speed,
  });
  if (!result.ok) {
    console.error(`[hero-cloning] upstream status=${result.status} reason=${result.reason}`);
    return NextResponse.json(
      { error: "Hero Cloning สร้างเสียงไม่สำเร็จ กรุณาลองใหม่", retryable: result.status >= 500 },
      { status: result.status >= 500 ? 503 : result.status },
    );
  }

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const filename = `tts-jaitts-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  fs.writeFileSync(path.join(rendersDir, filename), result.wav);
  const voiceUrl = `/api/renders/${filename}`;

  const job = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "voice",
      provider: "jaitts",
      model: voiceId,
      providerModel: "jaitts-f5tts",
      providerRoute: "hero-cloning",
      providerEndpoint: config.baseUrl,
      status: "completed",
      inputPreview: text.replace(/\s+/g, " ").slice(0, 180),
      inputJson: JSON.stringify({
        script: text,
        voiceId,
        speed,
        engine: "jaitts",
        voiceName: ref.name,
        generationTimeMs: result.generationTimeMs,
      }),
      outputUrl: voiceUrl,
      creditCost: 0,
      chargeState: "none",
      executionTimeMs: result.generationTimeMs,
      startedAt: new Date(),
      finishedAt: new Date(),
      mediaExpiresAt: videoExpiryFor(user.plan),
    },
  });

  return NextResponse.json({ job: publicAiGenerationJob(job) });
}
