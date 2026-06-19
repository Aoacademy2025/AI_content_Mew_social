import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getGeminiErrorInfo } from "@/lib/gemini-errors";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

type KeyType = "gemini" | "heygen" | "elevenlabs" | "pexels" | "pixabay";

// Test Gemini key against 3 capabilities our app uses:
// 1. Auth + Generative Language API enabled (models endpoint)
// 2. Text generation (used by extract-keywords, transcribe merge prompt)
// 3. TTS (used by tts-gemini)
async function testGemini(key: string): Promise<{ ok: boolean; message: string }> {
  const authHeaders = { "x-goog-api-key": key, "Content-Type": "application/json" };

  // Step 1 — auth + API enabled
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
      headers: { "x-goog-api-key": key },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const lc = body.toLowerCase();
      // Google returns HTTP 400 (not 401) with API_KEY_INVALID for a bad/incomplete key —
      // match on the body so the friendly message shows instead of a raw "Auth check failed: 400".
      if (res.status === 401 || lc.includes("api_key_invalid") || lc.includes("api key not valid") || lc.includes("key not valid")) {
        return { ok: false, message: "❌ Key ไม่ถูกต้อง — สร้างใหม่ที่ aistudio.google.com/apikey" };
      }
      if (lc.includes("service_disabled") || lc.includes("has not been used")) {
        return { ok: false, message: "❌ Generative Language API ยังไม่ได้เปิด — เข้า console.cloud.google.com → APIs & Services → Enable 'Generative Language API'" };
      }
      if (res.status === 403 || lc.includes("permission_denied")) {
        return { ok: false, message: "❌ Key ไม่มีสิทธิ์ — ลองสร้าง key ใหม่ที่ aistudio.google.com/apikey" };
      }
      // Anything else (location-restricted, 5xx overload, etc.) → shared Gemini mapping for a friendly message
      const info = getGeminiErrorInfo(body, res.status);
      return { ok: false, message: `❌ ${info.userMessage}` };
    }
  } catch { return { ok: false, message: "❌ ติดต่อ Gemini server ไม่ได้" }; }

  // Step 2 — text generation
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const info = getGeminiErrorInfo(body, res.status);
      return { ok: false, message: `⚠️ ${info.userMessage}` };
    }
  } catch { return { ok: false, message: "❌ ติดต่อ text generation ไม่ได้" }; }

  // Step 3 — TTS (same order as production route: low-cost 2.5 Flash first)
  const TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"];
  const ttsBody = JSON.stringify({
    contents: [{ parts: [{ text: "hi" }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } },
  });
  const ttsResults: string[] = [];
  for (const model of TTS_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: authHeaders,
        body: ttsBody,
      });
      if (res.ok) {
        const note = model === TTS_MODELS[0] ? "" : ` (fallback to ${model})`;
        return { ok: true, message: `✓ Gemini key พร้อมใช้งาน — text + TTS${note}. ถ้าใช้งานหลายคลิป แนะนำผูกบัตร Google เพื่อเพิ่มโควต้า` };
      }
      const body = await res.text().catch(() => "");
      const info = getGeminiErrorInfo(body, res.status);
      ttsResults.push(`${model}:${info.kind}`);
    } catch {
      ttsResults.push(`${model}:network`);
    }
  }
  return {
    ok: false,
    message: `⚠️ Text ใช้ได้ แต่ TTS ยังใช้ไม่ได้ (${ttsResults.join(", ")}) — ลองผูกบัตร Google หรือสลับใช้ ElevenLabs`,
  };
}

async function testHeyGen(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.heygen.com/v2/avatars?limit=1", { headers: { "X-Api-Key": key } });
    if (res.ok) return { ok: true, message: "HeyGen key ใช้งานได้" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ HeyGen ได้" }; }
}

async function testElevenLabs(key: string): Promise<{ ok: boolean; message: string }> {
  // ElevenLabs now uses SCOPED api keys. A key granted only text_to_speech (which is
  // all our TTS needs) returns 401 on /v1/user (needs user_read) and /v1/voices
  // (needs voices_read) — so the old "/v1/user → 401 = invalid" check false-failed
  // perfectly good keys. Validate against the capability we actually use (TTS).
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
    if (res.ok) return { ok: true, message: "✓ ElevenLabs key ใช้งานได้" };
    if (res.status !== 401) return { ok: false, message: `Error ${res.status}` };
    // 401 → either a truly bad key, or a valid TTS-scoped key lacking user_read.
    const body = (await res.text().catch(() => "")).toLowerCase();
    if (body.includes("missing_permissions")) {
      return { ok: true, message: "✓ ElevenLabs key ใช้งานได้ (เป็น key แบบจำกัดสิทธิ์ — สร้างเสียงได้ปกติ)" };
    }
    // Ambiguous 401 → confirm against the real TTS endpoint (a standard premade voice,
    // ~1 character of quota). This is exactly what video generation calls.
    const ttsRes = await fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: ".", model_id: "eleven_multilingual_v2" }),
    });
    if (ttsRes.ok) return { ok: true, message: "✓ ElevenLabs key ใช้งานได้ (ยืนยันด้วยการสร้างเสียง)" };
    if (ttsRes.status === 401) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, message: `Error ${ttsRes.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ ElevenLabs ได้" }; }
}

async function testPexels(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", { headers: { Authorization: key } });
    if (res.ok) return { ok: true, message: "Pexels key ใช้งานได้" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้อง" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Pexels ได้" }; }
}

async function testPixabay(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`https://pixabay.com/api/videos/?key=${key}&q=nature&per_page=3`);
    if (res.ok) {
      const data = await res.json();
      if (data.hits !== undefined) return { ok: true, message: "Pixabay key ใช้งานได้" };
    }
    if (res.status === 400 || res.status === 401) return { ok: false, message: "Key ไม่ถูกต้อง" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Pixabay ได้" }; }
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { keyType } = (await req.json()) as { keyType: KeyType };

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true, pixabayKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const encryptedMap: Record<KeyType, string | null | undefined> = {
      gemini:     user.geminiKey,
      heygen:     user.heygenKey,
      elevenlabs: user.elevenlabsKey,
      pexels:     user.pexelsKey,
      pixabay:    user.pixabayKey,
    };

    const encrypted = encryptedMap[keyType];
    if (!encrypted) return NextResponse.json({ ok: false, message: "ยังไม่ได้บันทึก key นี้" });

    const key = decrypt(encrypted);

    let result: { ok: boolean; message: string };
    switch (keyType) {
      case "gemini":     result = await testGemini(key);     break;
      case "heygen":     result = await testHeyGen(key);     break;
      case "elevenlabs": result = await testElevenLabs(key); break;
      case "pexels":     result = await testPexels(key);     break;
      case "pixabay":    result = await testPixabay(key);    break;
      default: return NextResponse.json({ error: "Unknown key type" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "user/test-key", error });
  }
}
