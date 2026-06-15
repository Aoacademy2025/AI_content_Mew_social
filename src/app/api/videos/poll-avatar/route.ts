import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { mapHeygenPollResponse } from "@/lib/heygen-poll";
import { fetchWithBudget } from "@/lib/fetch-budget";

export const maxDuration = 30;
export const runtime = "nodejs";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

// POST /api/videos/poll-avatar
// Body: { videoId: string }
// Returns AvatarPollPayload (src/lib/heygen-poll.ts):
//   { status, videoUrl, thumbnailUrl, errorMsg, error?, retryAfterSec? }
// Contract: terminal HeyGen errors (key ผิด / ไม่พบวิดีโอ / เครดิตหมด / 4xx อื่นๆ) กลับมาเป็น
// status "failed" พร้อม `error` แบบมีโครงสร้าง — client ต้องหยุด poll ทันที
// เฉพาะ rate limit (429), HeyGen 5xx และ network timeout เท่านั้นที่ได้ "pending" (poll ต่อ)
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const videoId: string = body?.videoId ?? "";
    if (!videoId) return NextResponse.json({ error: "videoId required" }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { heygenKey: true },
    });

    if (!user?.heygenKey) {
      return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
    }

    const heygenKey = decrypt(user.heygenKey);

    // HeyGen status budget: 15s/attempt, 1 retry (network/429/5xx only).
    // returnHttpErrors keeps PR-1's res.status → terminal-state mapping working
    // unchanged on 401/402/404 responses.
    let httpStatus = 0;
    let heygenBody: unknown = null;
    let retryAfterHeader: string | null = null;
    try {
      const res = await fetchWithBudget(
        `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
        { headers: { "X-Api-Key": heygenKey } },
        { provider: "heygen", timeoutMs: 15_000, retries: 1, wallClockMs: 25_000, returnHttpErrors: true },
      );
      httpStatus = res.status;
      retryAfterHeader = res.headers.get("retry-after");
      heygenBody = await res.json().catch(() => null);
      // PR-4 (ops guardrails) documents: set DEBUG_RENDER=1 to re-enable the
      // per-poll payload dump when debugging avatar issues. Opt-in — no log flood.
      if (process.env.DEBUG_RENDER === "1") console.log("[poll-avatar]", httpStatus, JSON.stringify(heygenBody));
    } catch (e) {
      // A caller abort is rethrown by fetchWithBudget untouched — propagate it.
      if (e instanceof Error && e.name === "AbortError") throw e;
      // Network error / timeout (transient ProviderError — the only other throw
      // when returnHttpErrors is set): leave httpStatus = 0 so the mapper returns
      // "pending" and the client keeps polling (PR-2's stale timeout bounds it).
      // PR-1's contract: NO "unknown" status — the mapper is the single source of truth.
      console.warn("[poll-avatar] transient HeyGen failure:", e instanceof Error ? e.message : e);
    }

    const payload = mapHeygenPollResponse({ httpStatus, body: heygenBody, retryAfterHeader });
    if (payload.status === "failed") {
      console.warn(`[poll-avatar] terminal http=${httpStatus} code=${payload.error?.code ?? "provider"} video=${videoId}`);
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.error("poll-avatar error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Poll failed" },
      { status: 500 }
    );
  }
}
