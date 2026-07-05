import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  normalizeManualPayment,
  billingPeriodFromDays,
  type ManualPaymentInput,
} from "@/lib/manual-payment";
import { claimSeat, releaseUnattachedSeat, type ClaimResult } from "@/lib/founding";
import { usageWindowForPlan } from "@/lib/usage-limits";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { grantOnPaidActivation } from "@/lib/entitlements";

export const runtime = "nodejs";

/**
 * Admin-only manual / external (off-Stripe) payment log.
 *
 * POST — record one off-Stripe payment. Body: { email, plan, billingPeriod, amountBaht,
 *   paidAtMs, note, setPlan, markFounder }. Creates a Payment(status=PAID, manual=true) so the
 *   user counts in revenue-cohorts (จ่ายจริง/MRR/cash) with no other action, and optionally
 *   grants the plan/expiry (clearing the trial marker so the cron won't revert) and/or marks
 *   the user a FOUNDING100 founder (atomic seat claim). The Payment + plan-grant + founder
 *   reservation are one transaction; if the founder seat can't be claimed the whole record fails.
 * GET — list the last 200 manual payments (for the admin panel).
 */

/** Case-insensitive email → userId. Exact hit first; else a small scan (SQLite has no
 *  `mode:"insensitive"`, and Clerk stores emails un-normalized). Returns null if no user. */
async function findUserIdByEmail(rawEmail: string): Promise<string | null> {
  const exact = await prisma.user.findUnique({ where: { email: rawEmail }, select: { id: true } });
  if (exact) return exact.id;
  const lower = rawEmail.toLowerCase();
  const rows = await prisma.user.findMany({ select: { id: true, email: true } });
  return rows.find((r) => r.email.toLowerCase() === lower)?.id ?? null;
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    const rawEmail = String(body?.email ?? "").trim();
    if (!rawEmail) return NextResponse.json({ error: "ต้องระบุอีเมลผู้ใช้" }, { status: 400 });

    const input: ManualPaymentInput = {
      plan: body?.plan,
      billingPeriod: body?.billingPeriod,
      amountBaht: Number(body?.amountBaht),
      paidAtMs: Number(body?.paidAtMs),
      note: String(body?.note ?? ""),
      setPlan: !!body?.setPlan,
      markFounder: !!body?.markFounder,
    };

    // 1) Resolve the target user (404 before any validation side effects).
    const targetId = await findUserIdByEmail(rawEmail);
    if (!targetId) return NextResponse.json({ error: "ไม่พบผู้ใช้ตามอีเมลนี้" }, { status: 404 });

    // 2) Validate + normalize (satang / periodDays / expiry). Do this BEFORE claiming a seat so
    //    a bad input can never leak a founding seat. 400 with the (Thai) reason on failure.
    let norm;
    try {
      norm = normalizeManualPayment(input, Date.now());
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "ข้อมูลไม่ถูกต้อง" },
        { status: 400 },
      );
    }

    // 3) Founder seat: claim atomically via founding.ts (never hand-roll counter math). If the
    //    user is already a confirmed founder, don't claim a second seat. If seats are sold out
    //    (claimSeat → null), fail the WHOLE record with a clear 409 before any Payment is written.
    let founderClaim: ClaimResult = null;
    let founderAlreadyMember = false;
    if (input.markFounder) {
      const member = await prisma.foundingReservation.findFirst({
        where: { userId: targetId, status: "CONFIRMED" },
        select: { id: true },
      });
      if (member) {
        founderAlreadyMember = true;
      } else {
        founderClaim = await claimSeat(targetId);
        if (!founderClaim) {
          return NextResponse.json(
            { error: "ที่นั่ง Founder เต็มแล้ว หรือยังไม่ได้ตั้งค่า FOUNDING100 — ไม่ได้บันทึกอะไร" },
            { status: 409 },
          );
        }
      }
    }

    // 4) One transaction: Payment (+ optional plan grant + optional CONFIRMED founder seat).
    //    If it throws, return the just-claimed seat to the pool so nothing leaks, then bubble up.
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            userId: targetId,
            stripeSessionId: `manual-${randomUUID()}`,
            plan: input.plan,
            amount: norm.amountSatang,
            currency: "thb",
            status: "PAID",
            periodDays: norm.periodDays,
            createdAt: new Date(input.paidAtMs),
            paidAt: new Date(input.paidAtMs),
            manual: true,
            note: input.note.trim(),
            recordedBy: authUser.id,
          },
        });

        if (input.setPlan) {
          // Mirrors markUserPaid / the Stripe webhook activatePlan: sets a real timed expiry and
          // CLEARS trialEndsAt only (so classifyEntitlement keeps the user as a paying TIMED_PLAN
          // instead of auto-reverting at trial end). trialStartedAt is deliberately NOT cleared —
          // it's the one-trial-per-user guard (schema: "set once; never cleared").
          await tx.user.update({
            where: { id: targetId },
            data: {
              plan: input.plan,
              planExpiresAt: new Date(norm.planExpiresAtMs),
              trialEndsAt: null,
              billingPeriod: input.billingPeriod,
              ...usageWindowForPlan(input.plan),
            },
          });
        }

        if (founderClaim) {
          // The seat was already counted by claimSeat() above; record it as CONFIRMED (no Stripe
          // session, so this is the founder's reservation row for the manual purchase).
          await tx.foundingReservation.create({
            data: {
              userId: targetId,
              stripeSessionId: `manual-founding-${randomUUID()}`,
              status: "CONFIRMED",
              confirmedAt: new Date(),
            },
          });
        }

        return payment;
      });
    } catch (e) {
      if (founderClaim) await releaseUnattachedSeat(founderClaim.couponId).catch(() => {});
      throw e;
    }

    // 5) Non-critical side effects, post-commit + fire-and-forget (same as the webhook): extend
    //    the user's saved-video expiry to the new plan, and force a fresh paid credit grant.
    if (input.setPlan) {
      extendVideoExpiryForPlan(targetId, input.plan).catch(() => {});
      grantOnPaidActivation(targetId, input.plan).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      payment: {
        id: created.id,
        email: rawEmail,
        plan: created.plan,
        amountBaht: created.amount / 100,
        billingPeriod: billingPeriodFromDays(created.periodDays),
        paidAt: created.paidAt,
        note: created.note,
        status: created.status,
        setPlan: input.setPlan,
        markedFounder: !!founderClaim || founderAlreadyMember,
      },
    });
  } catch (error) {
    return apiError({ route: "admin/manual-payment POST", error });
  }
}

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const rows = await prisma.payment.findMany({
      where: { manual: true },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { email: true } } },
    });

    const items = rows.map((p) => ({
      id: p.id,
      email: p.user?.email ?? "—",
      plan: p.plan,
      amountBaht: p.amount / 100,
      billingPeriod: billingPeriodFromDays(p.periodDays),
      paidAt: p.paidAt,
      note: p.note,
      recordedBy: p.recordedBy,
      status: p.status,
    }));

    return NextResponse.json({ items });
  } catch (error) {
    return apiError({ route: "admin/manual-payment GET", error });
  }
}
