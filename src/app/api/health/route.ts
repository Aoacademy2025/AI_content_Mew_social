import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — lightweight PUBLIC liveness probe (P1.6 / STAB-2).
// Returns 200 {ok:true} after a trivial `SELECT 1` DB round-trip, 500 {ok:false} if the
// DB is unreachable. Unauthenticated on purpose: the OS-level watchdog
// (scripts/ops-watchdog.sh) curls it without a Clerk session. Kept intentionally cheap —
// no auth, no user lookup, no writes — so it stays a true up/down signal and is safe to
// poll frequently. Whitelisted in src/middleware.ts (isPublicRoute).
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    // Do NOT leak error details — this endpoint is public.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
