import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HERO-34 — Dormant Payers list equals the MAPC gap, and the day-3 first-clip nudge
// fires once, only for paying customers with zero jobs, never for internal/suspended.
const testDir = mkdtempSync(join(tmpdir(), "dormant-payers-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-09-17T02:00:00Z"); // 09:00 Bangkok
const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  const [{ prisma }, dormant, northStar] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/dormant-payers.server"),
    import("../src/lib/subscription-north-star.server"),
  ]);

  async function payer(input: {
    id: string; paidDaysAgo: number; annual?: boolean; email?: string; role?: "USER" | "ADMIN"; suspended?: boolean;
    withJob?: "recent" | "old" | "none"; withVideo?: boolean; withScript?: boolean; amount?: number;
  }) {
    const paidAt = new Date(NOW.getTime() - input.paidDaysAgo * DAY_MS);
    const periodDays = input.annual ? 365 : 30;
    await prisma.user.create({
      data: {
        id: input.id, name: input.id, email: input.email ?? `${input.id}@example.test`, role: input.role ?? "USER",
        plan: "PRO", billingPeriod: input.annual ? "annual" : "monthly",
        planExpiresAt: new Date(paidAt.getTime() + periodDays * DAY_MS),
        stripeSubscriptionId: input.annual ? null : `sub-${input.id}`, subStatus: input.annual ? null : "active",
        suspended: input.suspended ?? false,
      },
    });
    await prisma.payment.create({
      data: {
        id: `pay-${input.id}`, userId: input.id, stripeSessionId: `cs-${input.id}`, plan: "PRO",
        amount: input.amount ?? (input.annual ? 299_500 : 59_900), periodDays, status: "PAID", paidAt, createdAt: paidAt,
      },
    });
    if (input.withJob && input.withJob !== "none") {
      const at = input.withJob === "recent" ? new Date(NOW.getTime() - 2 * DAY_MS) : new Date(NOW.getTime() - 45 * DAY_MS);
      await prisma.videoJob.create({ data: { id: `job-${input.id}`, userId: input.id, type: "create", status: "done", inputJson: "{}", createdAt: at, updatedAt: at } });
    }
    if (input.withVideo) {
      const at = new Date(NOW.getTime() - 2 * DAY_MS);
      await prisma.video.create({ data: { id: `vid-${input.id}`, userId: input.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1, status: "COMPLETED", videoUrl: "/renders/x.mp4", createdAt: at, updatedAt: at } });
    }
    if (input.withScript) {
      const at = new Date(NOW.getTime() - 2 * DAY_MS);
      await prisma.script.create({ data: { id: `scr-${input.id}`, userId: input.id, topic: "t", hookText: "h", bodyText: "b", ctaText: "c", status: "sent", editorProjectId: "proj-x", createdAt: at } as never });
    }
  }

  // Active creator (video in window) — MAPC, not dormant.
  await payer({ id: "creator-video", paidDaysAgo: 10, withJob: "recent", withVideo: true });
  // Active creator via sent script.
  await payer({ id: "creator-script", paidDaysAgo: 10, withScript: true });
  // Dormant: paid, has an old job, nothing in 30 days.
  await payer({ id: "dormant-old-job", paidDaysAgo: 60, annual: true, withJob: "old" });
  // Dormant: paid 5 days ago, never started a job → nudge.
  await payer({ id: "dormant-never", paidDaysAgo: 5 });
  // Paid 1 day ago, never started → dormant, but nudge too early.
  await payer({ id: "fresh-never", paidDaysAgo: 1 });
  // Internal account: never in the payer set, never nudged.
  await payer({ id: "internal-never", paidDaysAgo: 10, email: "team@aoacademy.co" });
  // Suspended: excluded.
  await payer({ id: "suspended-never", paidDaysAgo: 10, suspended: true });
  // Credits-only buyer: not a plan payer.
  await prisma.user.create({ data: { id: "credits-only", name: "c", email: "credits-only@example.test", plan: "FREE" } });
  await prisma.payment.create({ data: { id: "pay-credits-only", userId: "credits-only", stripeSessionId: "cs-credits", plan: "PRO", amount: 19_900, periodDays: 0, status: "PAID", note: "credits", paidAt: NOW, createdAt: NOW } });

  // 1. Dormant list == payers − creators, same evidence as the headline.
  const ns = await northStar.getSubscriptionNorthStar(NOW);
  const list = await dormant.listDormantPayers(NOW);
  assert.equal(ns.activePayingCustomers, 5, "video, script, old-job, never, fresh-never are payers; internal/suspended/credits are not");
  assert.equal(ns.activeCreators, 2);
  assert.equal(list.length, ns.activePayingCustomers - ns.activeCreators, "dormant count is exactly the MAPC gap");
  assert.deepEqual(list.map((p) => p.id).sort(), ["dormant-never", "dormant-old-job", "fresh-never"]);
  const never = list.find((p) => p.id === "dormant-never")!;
  assert.equal(never.daysSinceLastJob, null);
  assert.equal(never.jobsEver, 0);
  assert.equal(never.daysSincePay, 5);
  assert.equal(never.dormancyReason, "never_created");
  const oldJob = list.find((p) => p.id === "dormant-old-job")!;
  assert.equal(oldJob.daysSinceLastJob, 45);
  assert.equal(oldJob.jobsEver, 1);
  assert.equal(oldJob.dormancyReason, "lapsed_creator");
  // Never-created rows sort first.
  assert.equal(list[0].daysSinceLastJob, null);
  assert.equal(list[list.length - 1].id, "dormant-old-job");

  // 2. Nudge: only dormant-never (≥3 days, zero jobs, not internal/suspended).
  const notifications: Array<Record<string, unknown>> = [];
  const emails: Array<Record<string, unknown>> = [];
  const deps = {
    createNotification: async (input: Record<string, unknown>) => { notifications.push(input); return {} as never; },
    sendEmail: async (input: Record<string, unknown>) => { emails.push(input); return true; },
    recordTelemetry: async () => ({} as never),
    emailEnabled: () => true,
  };
  const run = await dormant.sendDuePaidActivationReminders(NOW, deps as never);
  assert.equal(run.sent, 1, "exactly one customer qualifies today");
  assert.equal(run.tooEarly, 1, "fresh-never paid yesterday");
  assert.equal(run.skipped, 1, "internal is skipped without a claim; suspended is never a candidate");
  assert.equal(run.checked, 3, "dormant-never, fresh-never, internal-never — creators, old-job and suspended are not candidates");
  assert.equal(notifications.length, 1);
  assert.equal((notifications[0] as { link: string }).link, "/video-editor?source=paid_activation_d3");
  assert.match(String(notifications[0].title), /คลิปแรกของคุณยังรออยู่/);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].editorUrl, "https://studio.example.test/video-editor?source=paid_activation_d3");
  assert.equal(await prisma.paidActivationReminderLog.count(), 1);
  const log = await prisma.paidActivationReminderLog.findUniqueOrThrow({ where: { userId: "dormant-never" } });
  assert.equal(log.status, "DELIVERED");

  // 3. Next day: no second nudge for the same customer; fresh-never still too early (day 2).
  const day2 = new Date(NOW.getTime() + 1 * DAY_MS);
  const again = await dormant.sendDuePaidActivationReminders(day2, deps as never);
  assert.equal(again.sent, 0);
  assert.equal(again.tooEarly, 1);
  assert.equal(notifications.length, 1, "never twice");

  // 4. Day 3 for fresh-never → fires; a customer who started a job in the meantime does not.
  await prisma.videoJob.create({ data: { id: "job-fresh", userId: "fresh-never", type: "create", status: "queued", inputJson: "{}" } });
  const day3 = new Date(NOW.getTime() + 2 * DAY_MS);
  const third = await dormant.sendDuePaidActivationReminders(day3, deps as never);
  assert.equal(third.sent, 0, "fresh-never pressed สร้าง before day 3 — no nudge");
  assert.equal(third.checked, 1, "only the internal account remains a candidate (never-job, no log)");

  // 5. Email switch off → notification only.
  await payer({ id: "quiet-never", paidDaysAgo: 4 });
  const quiet = await dormant.sendDuePaidActivationReminders(NOW, { ...deps, emailEnabled: () => false } as never);
  assert.equal(quiet.sent, 1);
  assert.equal(emails.length, 1, "no email when PAID_ACTIVATION_EMAIL is off");
  const quietLog = await prisma.paidActivationReminderLog.findUniqueOrThrow({ where: { userId: "quiet-never" } });
  assert.equal(quietLog.emailAttempted, false);

  // 6. HERO-81 + HERO-102: preview_or_draft_30d classification, preview-stalled nudge, and d21/d35 lapsed nudges.
  await payer({ id: "preview-only-payer", paidDaysAgo: 6, withJob: "recent" });
  // Make preview-only-payer's preview 4 days old so it crosses PREVIEW_STALLED_MIN_DAYS (3d)
  const fourDaysAgo = new Date(NOW.getTime() - 4 * DAY_MS);
  await prisma.videoJob.update({
    where: { id: "job-preview-only-payer" },
    data: { createdAt: fourDaysAgo, updatedAt: fourDaysAgo },
  });
  const listWithPreview = await dormant.listDormantPayers(NOW);
  const previewPayer = listWithPreview.find((p) => p.id === "preview-only-payer")!;
  assert.equal(previewPayer.dormancyReason, "preview_or_draft_30d");
  assert.equal(previewPayer.previewsDone30d, 1);

  const lapsedNotifications: Array<Record<string, unknown>> = [];
  const lapsedEmails: Array<Record<string, unknown>> = [];
  const lapsedDeps = {
    createNotification: async (input: Record<string, unknown>) => {
      lapsedNotifications.push(input);
      return {} as never;
    },
    sendEmail: async (input: Record<string, unknown>) => {
      lapsedEmails.push(input);
      return true;
    },
    recordTelemetry: async () => ({} as never),
    emailEnabled: () => true,
  };

  // Pass 1: dormant-old-job gets d21 (template restart link) AND preview-only-payer gets preview_stalled_d3.
  const lapsedRun1 = await dormant.sendDueLapsedPayerReminders(NOW, lapsedDeps as never);
  assert.equal(lapsedRun1.sent, 2, "dormant-old-job (d21) and preview-only-payer (preview_stalled_d3) both qualify");
  assert.equal(lapsedNotifications.length, 2);
  const d21Notif = lapsedNotifications.find((n) => n.userId === "dormant-old-job") as { link: string };
  assert.ok(d21Notif, "dormant-old-job received d21 nudge");
  assert.equal(d21Notif.link, "/video-editor?templateId=news-fast&source=lapsed_payer_d21");
  const stalledNotif = lapsedNotifications.find((n) => n.userId === "preview-only-payer") as { link: string };
  assert.ok(stalledNotif, "preview-only-payer received preview-stalled nudge");
  assert.equal(stalledNotif.link, "/video-editor?source=preview_stalled_d3");
  assert.equal(lapsedEmails.length, 2);

  // Pass 2: dormant-old-job is 45d idle (>=35d) so bounded d35 follow-up fires once; preview-only-payer is deduplicated.
  const lapsedRun2 = await dormant.sendDueLapsedPayerReminders(NOW, lapsedDeps as never);
  assert.equal(lapsedRun2.sent, 1, "bounded d35 follow-up fires for 45d-idle dormant-old-job");
  assert.equal(lapsedRun2.duplicateClaimsSkipped, 1, "preview-only-payer is deduplicated");
  const d35Notif = lapsedNotifications[2] as { userId: string; link: string };
  assert.equal(d35Notif.userId, "dormant-old-job");
  assert.equal(d35Notif.link, "/video-editor?templateId=finance-clear&source=lapsed_payer_d35");

  // Pass 3: both d21+d35 and preview_stalled are now claimed -> strictly idempotent (0 sent).
  const lapsedRun3 = await dormant.sendDueLapsedPayerReminders(NOW, lapsedDeps as never);
  assert.equal(lapsedRun3.sent, 0);
  assert.equal(lapsedRun3.duplicateClaimsSkipped, 2);
  assert.equal(lapsedNotifications.length, 3);

  await prisma.$disconnect();
  console.log("verify-dormant-payers-server: PASS dormant = payers − MAPC, d21/d35 template restart nudges, preview-stalled nudge, strict idempotency");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
