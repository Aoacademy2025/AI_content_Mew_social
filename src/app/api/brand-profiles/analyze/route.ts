import { NextResponse } from "next/server";
import axios from "axios";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";
import { buildAnalyzePrompt } from "@/lib/prompts/hero-script";
import { generateValidatedJson, validateAnalyzeResponse } from "@/lib/hero-script.server";

// SSRF-safe axios GET of a user-supplied URL: validate the host, then follow redirects
// MANUALLY re-validating each hop (axios auto-follow is disabled), so a safe initial URL
// can't 3xx into a private/internal target. Bounded to maxHops.
// (Copied verbatim from src/app/api/contents/generate/route.ts per the Hero Script spec.)
async function safeAxiosGet(url: string, config: Parameters<typeof axios.get>[1] = {}, maxHops = 3) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertSafeFetchUrl(current);
    const res = await axios.get(current, { ...config, maxRedirects: 0, validateStatus: (s: number) => s < 400 });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.location as string | undefined;
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

// POST /api/brand-profiles/analyze - {sampleText?} | {sampleUrl?} → suggestion
// only (never auto-saved) — {niche, audience, tone, analysisNotes}
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sampleText, sampleUrl } = await req.json();
    if (!sampleText && !sampleUrl) {
      return NextResponse.json({ error: "กรุณาใส่ตัวอย่างข้อความหรือ URL" }, { status: 400 });
    }

    let textContent: string = typeof sampleText === "string" ? sampleText : "";
    if (!textContent && sampleUrl) {
      try {
        // SSRF guard (host + per-redirect-hop re-validation) lives in safeAxiosGet.
        const urlResponse = await safeAxiosGet(sampleUrl, { timeout: 10000 });
        textContent = String(urlResponse.data);
      } catch {
        return NextResponse.json({ error: "ดึงข้อมูลจาก URL ไม่สำเร็จ" }, { status: 400 });
      }
    }

    if (!textContent || textContent.trim().length < 10) {
      return NextResponse.json({ error: "เนื้อหาสั้นเกินไปสำหรับการวิเคราะห์" }, { status: 400 });
    }
    // Same 4,000-char truncation convention as /api/contents/generate.
    const truncated = textContent.substring(0, 4000);

    const inputCaps = checkAiInputCaps({ script: truncated });
    if (!inputCaps.ok) return NextResponse.json({ error: inputCaps.message }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    let apiKey: string;
    let geminiMode: "managed" | "byok";
    try {
      const resolved = resolveGeminiKey(user);
      apiKey = resolved.key;
      geminiMode = resolved.mode;
    } catch (e) {
      if (e instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw e;
    }

    // H1: bound managed-key text-LLM call frequency (BYOK → no-op, byte-identical).
    const textReserve = await reserveAiTextCall(authUser.id, { enforce: geminiMode === "managed" });
    if (!textReserve.allowed) {
      return NextResponse.json({ code: "QUOTA_AI_TEXT", message: textReserve.message }, { status: 429 });
    }

    const prompt = buildAnalyzePrompt(truncated);
    const result = await generateValidatedJson({
      apiKey,
      prompt,
      maxOutputTokens: 1500,
      validate: validateAnalyzeResponse,
    });
    if (!result) {
      return NextResponse.json({ error: "AI ตอบผิดรูปแบบ ลองใหม่อีกครั้ง" }, { status: 502 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "POST /api/brand-profiles/analyze", error });
  }
}
