import { NextResponse } from "next/server";
import axios from "axios";
import { apiError } from "@/lib/api-error";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";
import { buildAnalyzePrompt } from "@/lib/prompts/hero-script";
import {
  generateValidatedJson,
  requireHeroScriptUser,
  resolveLlmTriad,
  validateAnalyzeResponse,
} from "@/lib/hero-script.server";

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
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    // `.catch(() => null)` (same as every other Hero Script route): a malformed
    // body must be a clean 400, not a thrown 500 — apiError writes an admin
    // Notification row for every 500, so an unguarded parse is floodable.
    const body = await req.json().catch(() => null);
    const sampleText = typeof body?.sampleText === "string" ? body.sampleText : "";
    const sampleUrl = typeof body?.sampleUrl === "string" ? body.sampleUrl : "";
    if (!sampleText && !sampleUrl) {
      return NextResponse.json({ error: "กรุณาใส่ตัวอย่างข้อความหรือ URL" }, { status: 400 });
    }

    let textContent: string = sampleText;
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

    const triad = await resolveLlmTriad(authUser.id, { script: truncated });
    if (!triad.ok) return NextResponse.json(triad.body, { status: triad.status });
    const { apiKey } = triad;

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
