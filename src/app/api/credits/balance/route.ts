import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getBalance } from "@/lib/credits";

export const runtime = "nodejs";

/**
 * GET /api/credits/balance — returns the CALLER's own credit balance.
 *
 * Used by the post-render receipt ("เหลือ X เครดิต") and the low-balance nudge.
 * The render-status/progress routes surface only `creditsSpent`; the client
 * fetches the remaining balance here so the figure is uniform across the queue
 * and legacy render paths (the queue path carries no `creditBalanceAfter`).
 *
 * Caller-scoped — no userId param, so no IDOR. `getBalance` upserts an empty
 * row, so a user who has never touched credits gets `{0,0,0}` (not an error).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const bal = await getBalance(user.id);
  return NextResponse.json(bal); // { granted, purchased, total }
}
