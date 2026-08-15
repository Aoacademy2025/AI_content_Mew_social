import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getGeminiErrorInfo } from "@/lib/gemini-errors";
import { decryptKey } from "@/lib/key-crypto";
import { testElevenLabsKey, testPexelsKey, testPixabayKey } from "@/lib/key-preflight";
import { interpretKieCreditResponse } from "@/lib/kie-client";

type KeyType = "gemini" | "heygen" | "elevenlabs" | "pexels" | "pixabay" | "kie" | "unsplash" | "flickr";

// Test Gemini key against 3 capabilities our app uses:
// 1. Auth + Generative Language API enabled (models endpoint)
// 2. Text generation (used by extract-keywords, transcribe merge prompt)
// 3. TTS (used by tts-gemini)
async function testGemini(key: string): Promise<{ ok: boolean; message: string }> {
  const authHeaders = { "x-goog-api-key": key, "Content-Type": "application/json" };

  // Step 1 — auth + API enabled
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
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
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
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
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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

// testElevenLabsKey / testPexelsKey now live in @/lib/key-preflight — shared with the
// job-submit preflight guard (Task 7, 2026-07-16 stability audit) so the ElevenLabs
// scoped-key logic and Pexels check exist in exactly one place. This "Test key" button
// is a deliberate user click (not a fast-fail gate), so give it a longer budget than the
// preflight's 3s — 12s comfortably covers ElevenLabs' occasionally slow /v1/user. Mode
// defaults to "settings" (unchanged historical behavior: a scoped "missing_permissions"
// key on /v1/user is trusted as valid without a further call) — see `ElevenLabsCheckMode`
// in key-preflight.ts for how the job-submit preflight differs (2nd review round, 2026-07-17).
const SETTINGS_TEST_TIMEOUT_MS = 12_000;
async function testElevenLabs(key: string): Promise<{ ok: boolean; message: string }> {
  const r = await testElevenLabsKey(key, { timeoutMs: SETTINGS_TEST_TIMEOUT_MS });
  return { ok: r.ok, message: r.message };
}

async function testPexels(key: string): Promise<{ ok: boolean; message: string }> {
  const r = await testPexelsKey(key, SETTINGS_TEST_TIMEOUT_MS);
  return { ok: r.ok, message: r.message };
}

async function testPixabay(key: string): Promise<{ ok: boolean; message: string }> {
  const r = await testPixabayKey(key, SETTINGS_TEST_TIMEOUT_MS);
  return { ok: r.ok, message: r.message };
}

// kie.ai personal API key — เช็คผ่าน /chat/credit (endpoint เบาๆ ใช้ตรวจ auth ได้)
async function testKie(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json().catch(() => null);
    const interpreted = interpretKieCreditResponse(res.status, data);
    if (interpreted.ok) {
      const credits = interpreted.credits !== undefined ? ` (เครดิตเหลือ ${interpreted.credits})` : "";
      return { ok: true, message: `kie.ai key ใช้งานได้${credits}` };
    }
    if (interpreted.reason === "auth") return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ — สร้างใหม่ที่ kie.ai" };
    return { ok: false, message: `Error ${interpreted.providerCode ?? res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ kie.ai ได้" }; }
}

// Unsplash Access Key — เช็คผ่าน /photos/random (endpoint เบาๆ ใช้ตรวจ auth + rate limit ได้)
async function testUnsplash(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.unsplash.com/photos/random?count=1", {
      headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
    });
    if (res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const limit = res.headers.get("x-ratelimit-limit");
      const quota = remaining && limit ? ` (เหลือ ${remaining}/${limit} ต่อชั่วโมง)` : "";
      return { ok: true, message: `Unsplash key ใช้งานได้${quota}` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ — สร้างใหม่ที่ unsplash.com/oauth/applications" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Unsplash ได้" }; }
}

// Flickr API Key — เช็คผ่าน flickr.test.echo (endpoint เบาๆ ใช้ตรวจ auth ได้ ไม่ต้องมี permission พิเศษ)
async function testFlickr(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const params = new URLSearchParams({ method: "flickr.test.echo", api_key: key, format: "json", nojsoncallback: "1" });
    const res = await fetch(`https://www.flickr.com/services/rest/?${params}`);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.stat === "ok") return { ok: true, message: "Flickr key ใช้งานได้" };
      if (data?.stat === "fail") return { ok: false, message: `Key ไม่ถูกต้อง — ${data?.message ?? "ตรวจสอบ API key อีกครั้ง"}` };
    }
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Flickr ได้" }; }
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { keyType } = (await req.json()) as { keyType: KeyType };

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true, pixabayKey: true, kieKey: true, unsplashKey: true, flickrKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const encryptedMap: Record<KeyType, string | null | undefined> = {
      gemini:     user.geminiKey,
      heygen:     user.heygenKey,
      elevenlabs: user.elevenlabsKey,
      pexels:     user.pexelsKey,
      pixabay:    user.pixabayKey,
      kie:        user.kieKey,
      unsplash:   user.unsplashKey,
      flickr:     user.flickrKey,
    };

    const encrypted = encryptedMap[keyType];
    if (!encrypted) return NextResponse.json({ ok: false, message: "ยังไม่ได้บันทึก key นี้" });

    const key = decryptKey(encrypted);

    let result: { ok: boolean; message: string };
    switch (keyType) {
      case "gemini":
        if (process.env.MANAGED_GEMINI === "1") {
          result = { ok: true, message: "ใช้ Gemini ผ่านระบบ (managed) — ไม่ต้องตั้งค่า key เอง" };
        } else {
          result = await testGemini(key);
        }
        break;
      case "heygen":     result = await testHeyGen(key);     break;
      case "elevenlabs": result = await testElevenLabs(key); break;
      case "pexels":     result = await testPexels(key);     break;
      case "pixabay":    result = await testPixabay(key);    break;
      case "kie":        result = await testKie(key);        break;
      case "unsplash":   result = await testUnsplash(key);   break;
      case "flickr":     result = await testFlickr(key);     break;
      default: return NextResponse.json({ error: "Unknown key type" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "user/test-key", error });
  }
}
