import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

const LIVE0819_REFS = [
  "live0819yt",
  "live0819fb",
  "live0819pre",
  "live0819line",
  "live0819code",
] as const;

type ExportSegment = "signup_no_redeem" | "redeemed" | "created_clip" | "paid";

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const url = new URL(req.url);
    const couponCode = (url.searchParams.get("coupon") || "CLIP0819").trim().toUpperCase();
    const segment = url.searchParams.get("segment") as ExportSegment | null;
    const users = await prisma.user.findMany({
      where: { affiliateRefCode: { in: [...LIVE0819_REFS] } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        affiliateRefCode: true,
        createdAt: true,
        couponRedemptions: {
          where: { coupon: { code: couponCode } },
          orderBy: { redeemedAt: "asc" },
          take: 1,
          select: { redeemedAt: true, outcome: true },
        },
        videos: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { createdAt: true },
        },
        payments: {
          // A conversion means a paid Studio term, not a one-off credit pack.
          where: {
            status: "PAID",
            periodDays: { gt: 0 },
            plan: { in: ["PRO", "BUSINESS"] },
          },
          orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
          take: 1,
          select: { paidAt: true, createdAt: true, amount: true, currency: true },
        },
      },
    });

    const report = LIVE0819_REFS.map((ref) => {
      const cohort = users.filter((user) => user.affiliateRefCode === ref);
      return {
        ref,
        clicks: null,
        signups: cohort.length,
        couponRedemptions: cohort.filter((user) => user.couponRedemptions.length > 0).length,
        createdClips: cohort.filter((user) => user.videos.length > 0).length,
        paidConversions: cohort.filter((user) => user.payments.length > 0).length,
      };
    });

    if (!segment) {
      return NextResponse.json({
        couponCode,
        refs: report,
        totals: report.reduce(
          (sum, row) => ({
            signups: sum.signups + row.signups,
            couponRedemptions: sum.couponRedemptions + row.couponRedemptions,
            createdClips: sum.createdClips + row.createdClips,
            paidConversions: sum.paidConversions + row.paidConversions,
          }),
          { signups: 0, couponRedemptions: 0, createdClips: 0, paidConversions: 0 },
        ),
        clicksAvailable: false,
        clicksNote: "Affiliate click counts live in affiliate.heroaiengine.com and are not available in the Studio database.",
      });
    }
    if (!["signup_no_redeem", "redeemed", "created_clip", "paid"].includes(segment)) {
      return NextResponse.json({ error: "segment ไม่ถูกต้อง" }, { status: 400 });
    }

    const selected = users.filter((user) => {
      if (segment === "signup_no_redeem") return user.couponRedemptions.length === 0;
      if (segment === "redeemed") return user.couponRedemptions.length > 0;
      if (segment === "created_clip") return user.videos.length > 0;
      return user.payments.length > 0;
    });
    const header = [
      "user_id",
      "email",
      "name",
      "affiliate_ref",
      "signed_up_at",
      "coupon_redeemed_at",
      "coupon_outcome",
      "first_clip_at",
      "first_paid_at",
      "first_paid_amount",
      "currency",
    ];
    const rows = selected.map((user) => {
      const redemption = user.couponRedemptions[0];
      const video = user.videos[0];
      const payment = user.payments[0];
      return [
        user.id,
        user.email,
        user.name,
        user.affiliateRefCode,
        user.createdAt.toISOString(),
        redemption?.redeemedAt.toISOString() ?? "",
        redemption?.outcome ?? "",
        video?.createdAt.toISOString() ?? "",
        (payment?.paidAt ?? payment?.createdAt)?.toISOString() ?? "",
        payment?.amount ?? "",
        payment?.currency ?? "",
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${couponCode.toLowerCase()}-${segment}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/coupons/report", error });
  }
}
