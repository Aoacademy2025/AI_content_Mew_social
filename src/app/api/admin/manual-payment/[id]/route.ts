import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

/**
 * Admin-only soft-void of a MANUAL payment. Sets status=VOIDED (never hard-deletes — keeps the
 * audit row) so the payment drops out of the PAID cohorts (จ่ายจริง/MRR/cash). It does NOT revert
 * the granted plan/founder seat — that's a separate manual action at /admin/users (documented in UI).
 *
 * Hard guard: the `manual: true` filter on the update means a real Stripe payment can NEVER be
 * voided through this endpoint, even if its id is passed.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await params;

    const existing = await prisma.payment.findUnique({
      where: { id },
      select: { id: true, manual: true, status: true },
    });
    // 404 unless it's a manual payment — voiding a Stripe payment is never allowed here.
    if (!existing || !existing.manual) {
      return NextResponse.json(
        { error: "ไม่พบรายการ manual payment นี้ (void ได้เฉพาะรายการที่บันทึกเอง)" },
        { status: 404 },
      );
    }
    if (existing.status === "VOIDED") {
      return NextResponse.json({ ok: true, alreadyVoided: true });
    }

    // Belt-and-suspenders: the `manual: true` filter guarantees only a manual row can flip.
    const res = await prisma.payment.updateMany({
      where: { id, manual: true },
      data: { status: "VOIDED" },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "ไม่สามารถ void รายการนี้ได้" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "admin/manual-payment/[id] void", error });
  }
}
