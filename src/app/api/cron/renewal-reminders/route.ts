import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendRenewalReminderEmail } from "@/lib/send-email";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";

const DAY = 24 * 60 * 60 * 1000;
const REMIND_AT = [14, 7, 1]; // days-before-expiry to remind (cron runs daily → each user hit once per threshold)

// GET /api/cron/renewal-reminders  (daily, Bearer CRON_SECRET)
// Reminds the manual-renew cohort (one-time / PromptPay — no auto-renew subscription) before their plan lapses.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + 15 * DAY);

  const users = await prisma.user.findMany({
    where: {
      plan: { not: "FREE" },
      stripeSubscriptionId: null,            // card subscribers auto-renew — skip them
      planExpiresAt: { gt: now, lte: horizon },
    },
    select: { id: true, email: true, plan: true, planExpiresAt: true },
  });

  const origin = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "";
  let sent = 0;

  for (const u of users) {
    if (!u.planExpiresAt) continue;
    const daysLeft = Math.ceil((u.planExpiresAt.getTime() - now.getTime()) / DAY);
    if (!REMIND_AT.includes(daysLeft)) continue;

    await createNotification({
      userId: u.id,
      type: "VIDEO_COMPLETED",
      title: `แพ็ก ${u.plan} หมดอายุในอีก ${daysLeft} วัน`,
      body: "ต่ออายุก่อนหมด ล็อกราคาผู้ก่อตั้งไว้",
    }).catch(() => {});

    if (u.email) {
      await sendRenewalReminderEmail({ to: u.email, plan: u.plan, daysLeft, pricingUrl: `${origin}/pricing` }).catch(() => {});
    }
    sent++;
  }

  writeCronHeartbeat("renewal-reminders");
  return NextResponse.json({ remindersSent: sent, checked: users.length });
}
