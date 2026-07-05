import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { checkClipQuota } from "@/lib/usage-limits";
import { checkMinuteQuota } from "@/lib/minute-limits";

// GET /api/videos/usage — read-only clip + minute quota status for the authenticated user
// Does NOT increment usageCount; uses checkClipQuota which calls syncUsageWindow
// (window sync only resets counter when the 30-day period expires — no increment).
export async function GET() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const quota = await checkClipQuota(authUser.id);

    if (!quota) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const used = quota.usageCount;
    const limit = quota.usageLimit;
    const remaining = Math.max(0, limit - used);

    // Only surface the minutes quota when the minute meter is the live gate (MINUTE_QUOTA=1),
    // matching enforcement + /api/user/me. With the flag off the render path enforces CLIPS, so a
    // minutes chip would advertise a quota that isn't the real limit.
    const includeMinutes = process.env.MINUTE_QUOTA === "1";
    const minuteQuota = includeMinutes ? await checkMinuteQuota(authUser.id) : null;

    return NextResponse.json({
      plan: quota.plan,
      used,
      limit,
      remaining,
      resetAt: quota.resetAt.toISOString(),
      ...(minuteQuota
        ? {
            minutes: {
              used: minuteQuota.used,
              limit: minuteQuota.used + minuteQuota.remaining,
              remaining: minuteQuota.remaining,
            },
          }
        : {}),
    });
  } catch (err) {
    console.error("[api/videos/usage] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
