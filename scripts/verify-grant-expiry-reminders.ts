import "./register-server-only-node.mjs";

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "grant-expiry-reminders-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
process.env.CRON_SECRET = "test-cron-secret-hero-99";
process.env.HEARTBEAT_DIR = join(testDir, "heartbeat");

execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const NOW = new Date("2026-09-10T02:00:00Z"); // 09:00 Asia/Bangkok
const DAY_MS = 24 * 60 * 60 * 1_000;

async function main() {
  try {
    // ── 1. Schema & Static Codebase Guardrails ───────────────────────────────
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /model GrantExpiryReminderLog\s*\{/);
    assert.match(
      schema,
      /@@unique\(\[userId,\s*couponRedemptionId,\s*kind\]\)/,
      "idempotency log is uniquely keyed on (userId, couponRedemptionId, kind)",
    );

    const cronRouteSource = readFileSync("src/app/api/cron/renewal-reminders/route.ts", "utf8");
    assert.match(cronRouteSource, /sendDueRenewalReminders/, "cash renewal sweep remains wired");
    assert.match(cronRouteSource, /sendDueGrantExpiryReminders/, "grant expiry sweep is wired into daily cron");
    assert.ok(
      cronRouteSource.indexOf("sendDueRenewalReminders") < cronRouteSource.indexOf("sendDueGrantExpiryReminders"),
      "cash renewal sweep runs before grant expiry sweep",
    );

    const pricingPageSource = readFileSync("src/app/(dashboard)/pricing/page.tsx", "utf8");
    const pricingClientSource = readFileSync("src/app/(dashboard)/pricing/pricing-client.tsx", "utf8");
    const dashboardPageSource = readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8");
    const bannerComponentSource = readFileSync("src/components/billing/grant-expiry-banner.tsx", "utf8");
    const editorShellSource = readFileSync("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "utf8");
    const postPhaseSource = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
    const postPhaseMobileSource = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");

    assert.match(dashboardPageSource, /GrantExpiryBanner/, "/dashboard renders GrantExpiryBanner");
    assert.match(pricingPageSource, /resolveUserExpiringGrantBanner/, "/pricing resolves expiringGrant on server");
    assert.match(pricingClientSource, /GrantExpiryBanner/, "/pricing renders GrantExpiryBanner");
    assert.match(editorShellSource, /GrantExpiryBanner/, "/video-editor renders GrantExpiryBanner");
    assert.match(postPhaseSource, /GrantExpiryBanner/, "PostPhase renders GrantExpiryBanner on post-export");
    assert.match(postPhaseMobileSource, /GrantExpiryBanner/, "PostPhaseMobile renders GrantExpiryBanner on post-export");
    assert.match(bannerComponentSource, /grant_expiry_banner_viewed/, "GrantExpiryBanner emits impression telemetry");
    assert.doesNotMatch(
      bannerComponentSource,
      /฿\s*\d[\d,]*\s*\/\s*ปี|ต่อปี/,
      "GrantExpiryBanner never displays an annual total price (CLAUDE.md pricing rule)",
    );

    const [
      { prisma },
      {
        GRANT_BANNER_LINK,
        GRANT_BANNER_MAX_DAYS,
        GRANT_EXPIRY_REMINDER_KINDS,
        grantBannerCopy,
        grantDeliveryStatus,
        grantExpiryReminderDecision,
        grantExpiryReminderLink,
      },
      { resolveUserExpiringGrantBanner, sendDueGrantExpiryReminders },
      { paidPlanCardMode },
      cronRoute,
    ] = await Promise.all([
      import("../src/lib/prisma"),
      import("../src/lib/grant-expiry-reminders"),
      import("../src/lib/grant-expiry-reminders.server"),
      import("../src/lib/plan-change"),
      import("../src/app/api/cron/renewal-reminders/route"),
    ]);

    // ── 2. Pure schedule, links, copy, and alumni card conversion mode ───────
    assert.deepEqual(GRANT_EXPIRY_REMINDER_KINDS, ["d7", "d3", "d1"]);
    assert.deepEqual(grantExpiryReminderDecision(7), { send: true, kind: "d7" });
    assert.deepEqual(grantExpiryReminderDecision(3), { send: true, kind: "d3" });
    assert.deepEqual(grantExpiryReminderDecision(1), { send: true, kind: "d1" });
    assert.deepEqual(grantExpiryReminderDecision(5), { send: false, reason: "not_due" });
    assert.equal(grantExpiryReminderLink("d7"), "/pricing?source=grant_expiry_d7");
    assert.equal(grantExpiryReminderLink("d3"), "/pricing?source=grant_expiry_d3");
    assert.equal(grantExpiryReminderLink("d1"), "/pricing?source=grant_expiry_d1");
    assert.equal(GRANT_BANNER_LINK, "/pricing?source=grant_banner");
    assert.equal(GRANT_BANNER_MAX_DAYS, 14, "HERO-103: GRANT alumni banner window covers 14 days");
    assert.equal(
      grantBannerCopy("PRO", 5),
      "สิทธิ์คูปองเรียน PRO ของคุณจะหมดในอีก 5 วัน — ต่อสิทธิ์ต่อเนื่องเพื่อเก็บโปรเจกต์และแบรนด์ทั้งหมดไว้ใช้งานต่อ",
    );
    assert.equal(
      grantDeliveryStatus({ notificationDelivered: true, emailAttempted: true, emailDelivered: true }),
      "DELIVERED",
    );
    assert.equal(
      grantDeliveryStatus({ notificationDelivered: true, emailAttempted: true, emailDelivered: false }),
      "PARTIAL",
    );
    assert.equal(
      grantDeliveryStatus({ notificationDelivered: false, emailAttempted: true, emailDelivered: true }),
      "PARTIAL",
    );
    assert.equal(
      grantDeliveryStatus({ notificationDelivered: false, emailAttempted: true, emailDelivered: false }),
      "FAILED",
    );

    const futureExpiry = new Date(NOW.getTime() + 5 * DAY_MS);
    assert.equal(
      paidPlanCardMode(
        {
          currentPlan: "PRO",
          subStatus: null,
          isTrialPlan: false,
          planExpiresAt: futureExpiry,
          paymentMethod: "card",
          hasQualifyingCashPayment: false,
        },
        "PRO",
        "monthly",
        NOW,
      ),
      "renew",
      "unpaid GRANT PRO alumni can convert to monthly card immediately without waiting",
    );
    assert.equal(
      paidPlanCardMode(
        {
          currentPlan: "PRO",
          subStatus: null,
          isTrialPlan: false,
          planExpiresAt: futureExpiry,
          paymentMethod: "card",
          hasQualifyingCashPayment: true,
        },
        "PRO",
        "monthly",
        NOW,
      ),
      "wait",
      "cash-prepaid PRO user still waits before starting overlapping card subscription",
    );

    // ── 3. Seed Coupons & Test Cohorts in Throwaway SQLite DB ────────────────
    const couponPro30 = await prisma.coupon.create({
      data: { code: "WORKSHOP-PRO-30", plan: "PRO", durationDays: 30, maxUses: 500, type: "GRANT" },
    });
    const couponProExt = await prisma.coupon.create({
      data: { code: "WORKSHOP-PRO-EXT", plan: "PRO", durationDays: 30, maxUses: 500, type: "GRANT" },
    });
    const couponBiz30 = await prisma.coupon.create({
      data: { code: "WORKSHOP-BIZ-30", plan: "BUSINESS", durationDays: 30, maxUses: 500, type: "GRANT" },
    });

    async function seedGrantUser(opts: {
      id: string;
      daysLeft: number;
      plan?: "PRO" | "BUSINESS";
      role?: "USER" | "ADMIN";
      email?: string;
      stripeSubscriptionId?: string | null;
      subStatus?: string | null;
      cancelAtPeriodEnd?: boolean;
      bundleStatus?: string | null;
      bundleAccessExpiresAt?: Date | null;
      couponId?: string;
    }) {
      const plan = opts.plan ?? "PRO";
      const couponId = opts.couponId ?? (plan === "BUSINESS" ? couponBiz30.id : couponPro30.id);
      const startsAt = new Date(NOW.getTime() - 20 * DAY_MS);
      const expiresAt = new Date(NOW.getTime() + opts.daysLeft * DAY_MS);

      await prisma.user.create({
        data: {
          id: opts.id,
          name: opts.id,
          email: opts.email ?? `${opts.id}@example.test`,
          role: opts.role ?? "USER",
          plan,
          planExpiresAt: expiresAt,
          stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
          subStatus: opts.subStatus ?? null,
          cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
          bundleStatus: opts.bundleStatus ?? null,
          bundleAccessExpiresAt: opts.bundleAccessExpiresAt ?? null,
        },
      });

      const redemption = await prisma.couponRedemption.create({
        data: {
          id: `redemption-${opts.id}`,
          couponId,
          userId: opts.id,
          redeemedAt: startsAt,
          outcome: "ACTIVATED",
          entitlementPlan: plan,
          entitlementStartsAt: startsAt,
          entitlementExpiresAt: expiresAt,
        },
      });
      return { expiresAt, redemptionId: redemption.id };
    }

    // Eligible due users: d7 (with saved creator assets), d3 (BUSINESS), d1 (with credit pack top-up)
    const d7Seed = await seedGrantUser({ id: "grant-d7-creator", daysLeft: 7, plan: "PRO" });
    await prisma.brandProfile.create({
      data: {
        userId: "grant-d7-creator",
        name: "Mew Workshop Brand",
        niche: "AI Content",
        audience: "Creators",
        tone: "Friendly",
      },
    });
    await prisma.editorProject.create({
      data: {
        userId: "grant-d7-creator",
        title: "Lesson 1 Short",
      },
    });
    await prisma.video.create({
      data: {
        userId: "grant-d7-creator",
        avatarModel: "none",
        voiceModel: "gemini",
        sceneCount: 3,
        status: "COMPLETED",
        script: "สวัสดีจากคอร์สเรียน",
      },
    });

    const d3Seed = await seedGrantUser({ id: "grant-d3-biz", daysLeft: 3, plan: "BUSINESS" });
    const d1Seed = await seedGrantUser({ id: "grant-d1-credits-only", daysLeft: 1, plan: "PRO" });
    // Credit pack payment (`note: "credits"`) must NOT suppress grant expiry reminders!
    await prisma.payment.create({
      data: {
        id: "pay-credits-only",
        userId: "grant-d1-credits-only",
        stripeSessionId: "cs_credits_only",
        plan: "PRO",
        amount: 19_900,
        periodDays: 30,
        status: "PAID",
        note: "credits",
        paidAt: NOW,
        createdAt: NOW,
      },
    });

    // Eligible user at d5 (in 7-day banner window, NOT due for cron d7/d3/d1) + d10 (outside banner window)
    await seedGrantUser({ id: "grant-d5-banner-only", daysLeft: 5, plan: "PRO" });
    await seedGrantUser({ id: "grant-d10-not-yet", daysLeft: 10, plan: "PRO" });

    // Outside 14-day banner window (day 15): neither cron email nor in-app banner
    await seedGrantUser({ id: "grant-d15-not-yet", daysLeft: 15, plan: "PRO" });

    // Stacked-grant user: Grant 1 expires in 3 days (d3), stacked Grant 2 extends to 33 days!
    await seedGrantUser({ id: "grant-stacked", daysLeft: 3, plan: "PRO", couponId: couponPro30.id });
    const stackedLaterExpiry = new Date(NOW.getTime() + 33 * DAY_MS);
    const stackedSecondRedemption = await prisma.couponRedemption.create({
      data: {
        id: "redemption-grant-stacked-2",
        couponId: couponProExt.id,
        userId: "grant-stacked",
        redeemedAt: NOW,
        outcome: "SCHEDULED",
        entitlementPlan: "PRO",
        entitlementStartsAt: new Date(NOW.getTime() + 3 * DAY_MS),
        entitlementExpiresAt: stackedLaterExpiry,
      },
    });

    // Suppressed Cohort 1: Active auto-renewing Stripe subscription
    await seedGrantUser({
      id: "grant-suppressed-stripe-sub",
      daysLeft: 3,
      stripeSubscriptionId: "sub_active_hero99",
      subStatus: "active",
      cancelAtPeriodEnd: false,
    });

    // Suppressed Cohort 2: Cash-backed PAID plan term extending past grant expiry
    await seedGrantUser({ id: "grant-suppressed-cash", daysLeft: 3, plan: "PRO" });
    await prisma.payment.create({
      data: {
        id: "pay-cash-plan",
        userId: "grant-suppressed-cash",
        stripeSessionId: "cs_cash_plan",
        plan: "PRO",
        amount: 59_900,
        periodDays: 30,
        status: "PAID",
        note: "promptpay monthly",
        paidAt: NOW,
        createdAt: NOW,
      },
    });

    // Suppressed Cohort 3: AdministratorGrant extending past grant expiry
    const adminActor = await seedGrantUser({
      id: "grant-excluded-admin",
      daysLeft: 3,
      role: "ADMIN",
    });
    void adminActor;
    await seedGrantUser({ id: "grant-suppressed-admin-grant", daysLeft: 3, plan: "PRO" });
    await prisma.administratorGrant.create({
      data: {
        userId: "grant-suppressed-admin-grant",
        plan: "PRO",
        reason: "VIP extension",
        startsAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60 * DAY_MS),
        permanent: false,
        grantedById: "grant-excluded-admin",
      },
    });

    // Suppressed Cohort 4a: Active Hero AI Bundle on User row
    await seedGrantUser({
      id: "grant-suppressed-bundle-user",
      daysLeft: 1,
      bundleStatus: "ACTIVE",
      bundleAccessExpiresAt: new Date(NOW.getTime() + 25 * DAY_MS),
    });

    // Suppressed Cohort 4b: Active Hero AI Bundle on BundleEntitlement table
    await seedGrantUser({
      id: "grant-suppressed-bundle-email",
      daysLeft: 1,
      email: "bundle-holder@example.test",
    });
    await prisma.bundleEntitlement.create({
      data: {
        email: "bundle-holder@example.test",
        grantId: "bundle-grant-1",
        status: "ACTIVE",
        accessEndsAt: new Date(NOW.getTime() + 25 * DAY_MS),
        lastEventId: "evt_bundle_1",
        eventOccurredAt: NOW,
      },
    });

    // Excluded Internal Email Cohort
    await seedGrantUser({
      id: "grant-excluded-internal",
      daysLeft: 7,
      email: "instructor@aoacademy.co",
    });

    // ── 4. Run Sweep & Verify d7/d3/d1 Firing + CLAIMED -> DELIVERED ─────────
    const notifications: Array<Record<string, unknown>> = [];
    const emails: Array<Record<string, unknown>> = [];
    const telemetry: Array<Record<string, unknown>> = [];
    const observedClaimStatuses: string[] = [];

    const firstRun = await sendDueGrantExpiryReminders(NOW, {
      onClaimed: async (claimId) => {
        const row = await prisma.grantExpiryReminderLog.findUniqueOrThrow({ where: { id: claimId } });
        observedClaimStatuses.push(row.status);
      },
      createNotification: async (input) => {
        notifications.push(input as unknown as Record<string, unknown>);
        return {} as never;
      },
      sendEmail: async (input) => {
        emails.push(input as unknown as Record<string, unknown>);
        return true;
      },
      recordTelemetry: async (_userId, input) => {
        telemetry.push(input as unknown as Record<string, unknown>);
        return {} as never;
      },
    });

    assert.deepEqual(
      observedClaimStatuses,
      ["CLAIMED", "CLAIMED", "CLAIMED"],
      "each due reminder writes a durable CLAIMED row before touching notification/email",
    );
    assert.equal(firstRun.claimed, 3, "only d7, d3, and d1 unsuppressed non-admin users are claimed");
    assert.equal(firstRun.remindersSent, 3);
    assert.equal(firstRun.notificationDelivered, 3);
    assert.equal(firstRun.emailAttempted, 3);
    assert.equal(firstRun.emailDelivered, 3);
    assert.equal(firstRun.deliveryFailed, 0);
    assert.deepEqual(firstRun.byKind, { d7: 1, d3: 1, d1: 1 });
    assert.equal(telemetry.length, 6, "2 telemetry events (notification + email) per due user");

    // Verify creator assets highlight & attribution URLs
    const d7Notif = notifications.find((n) => n.userId === "grant-d7-creator");
    assert.ok(d7Notif, "d7 creator received notification");
    assert.equal(d7Notif.link, "/pricing?source=grant_expiry_d7");
    assert.match(String(d7Notif.body), /Brand Profile 1 แบรนด์/);
    assert.match(String(d7Notif.body), /โปรเจกต์ตัดต่อ 1 โปรเจกต์/);
    assert.match(String(d7Notif.body), /คลิปที่สร้างไว้ 1 คลิป/);

    const d7Email = emails.find((e) => e.to === "grant-d7-creator@example.test");
    assert.ok(d7Email, "d7 creator received email");
    assert.equal(d7Email.pricingUrl, "https://studio.example.test/pricing?source=grant_expiry_d7");
    assert.match(String(d7Email.assetsSummary), /Brand Profile 1 แบรนด์/);

    const d3Notif = notifications.find((n) => n.userId === "grant-d3-biz");
    assert.ok(d3Notif, "d3 BUSINESS user received notification");
    assert.equal(d3Notif.link, "/pricing?source=grant_expiry_d3");
    assert.match(String(d3Notif.title), /BUSINESS/);

    const d1Notif = notifications.find((n) => n.userId === "grant-d1-credits-only");
    assert.ok(d1Notif, "d1 user with credit-pack topup was NOT falsely suppressed");
    assert.equal(d1Notif.link, "/pricing?source=grant_expiry_d1");

    // Verify none of the suppressed / stacked / admin / internal accounts got notified
    for (const suppressedId of [
      "grant-stacked",
      "grant-suppressed-stripe-sub",
      "grant-suppressed-cash",
      "grant-suppressed-admin-grant",
      "grant-suppressed-bundle-user",
      "grant-suppressed-bundle-email",
      "grant-excluded-admin",
      "grant-excluded-internal",
      "grant-d5-banner-only",
      "grant-d10-not-yet",
      "grant-d15-not-yet",
    ]) {
      assert.equal(
        notifications.some((n) => n.userId === suppressedId),
        false,
        `${suppressedId} must receive zero due reminders`,
      );
    }

    // Verify DELIVERED log row keyed on (userId, couponRedemptionId, kind)
    const d7Log = await prisma.grantExpiryReminderLog.findUniqueOrThrow({
      where: {
        userId_couponRedemptionId_kind: {
          userId: "grant-d7-creator",
          couponRedemptionId: d7Seed.redemptionId,
          kind: "d7",
        },
      },
    });
    assert.equal(d7Log.status, "DELIVERED");
    assert.equal(d7Log.notificationDelivered, true);
    assert.equal(d7Log.emailAttempted, true);
    assert.equal(d7Log.emailDelivered, true);
    assert.equal(d7Log.failureCode, null);
    assert.ok(d7Log.completedAt instanceof Date);
    void d3Seed;
    void d1Seed;

    // ── 5. Idempotency Retry + Stacked Grant Later Firing ────────────────────
    const retryRun = await sendDueGrantExpiryReminders(NOW, {
      createNotification: async () => {
        throw new Error("should not be called on duplicate retry");
      },
      sendEmail: async () => {
        throw new Error("should not be called on duplicate retry");
      },
      recordTelemetry: async () => ({} as never),
    });
    assert.equal(retryRun.claimed, 0, "retry claims zero duplicate reminders");
    assert.equal(retryRun.duplicateClaimsSkipped, 3, "all 3 due reminders skipped via unique key");

    // Fast-forward 30 days: `grant-stacked` now has 3 days left on its SECOND grant!
    const LATER_NOW = new Date(NOW.getTime() + 30 * DAY_MS);
    const stackedNotifications: Array<Record<string, unknown>> = [];
    const stackedRun = await sendDueGrantExpiryReminders(LATER_NOW, {
      createNotification: async (input) => {
        stackedNotifications.push(input as unknown as Record<string, unknown>);
        return {} as never;
      },
      sendEmail: async () => true,
      recordTelemetry: async () => ({} as never),
    });
    assert.equal(stackedRun.byKind.d3, 1, "stacked grant fires d3 only when maxGrantExpiresAt is 3 days away");
    assert.equal(stackedNotifications.length, 1);
    assert.equal(stackedNotifications[0].userId, "grant-stacked");
    const stackedLog = await prisma.grantExpiryReminderLog.findUniqueOrThrow({
      where: {
        userId_couponRedemptionId_kind: {
          userId: "grant-stacked",
          couponRedemptionId: stackedSecondRedemption.id,
          kind: "d3",
        },
      },
    });
    assert.equal(stackedLog.status, "DELIVERED");

    // ── 6. PARTIAL and FAILED Delivery State Recording ───────────────────────
    const PARTIAL_NOW = new Date(NOW.getTime() + 100 * DAY_MS);
    await prisma.user.create({
      data: {
        id: "grant-partial",
        name: "Partial",
        email: "partial@example.test",
        role: "USER",
        plan: "PRO",
        planExpiresAt: new Date(PARTIAL_NOW.getTime() + 7 * DAY_MS),
      },
    });
    const partialRedemption = await prisma.couponRedemption.create({
      data: {
        couponId: couponPro30.id,
        userId: "grant-partial",
        redeemedAt: PARTIAL_NOW,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: PARTIAL_NOW,
        entitlementExpiresAt: new Date(PARTIAL_NOW.getTime() + 7 * DAY_MS),
      },
    });

    const partialRun = await sendDueGrantExpiryReminders(PARTIAL_NOW, {
      createNotification: async () => ({} as never),
      sendEmail: async () => false,
      recordTelemetry: async () => ({} as never),
    });
    assert.equal(partialRun.remindersSent, 1, "PARTIAL still reached customer via in-app notification");
    assert.equal(partialRun.deliveryFailed, 0);
    const partialLog = await prisma.grantExpiryReminderLog.findUniqueOrThrow({
      where: {
        userId_couponRedemptionId_kind: {
          userId: "grant-partial",
          couponRedemptionId: partialRedemption.id,
          kind: "d7",
        },
      },
    });
    assert.equal(partialLog.status, "PARTIAL");
    assert.equal(partialLog.failureCode, "email_failed");

    await prisma.user.create({
      data: {
        id: "grant-failed",
        name: "Failed",
        email: "failed@example.test",
        role: "USER",
        plan: "PRO",
        planExpiresAt: new Date(PARTIAL_NOW.getTime() + 3 * DAY_MS),
      },
    });
    const failedRedemption = await prisma.couponRedemption.create({
      data: {
        couponId: couponPro30.id,
        userId: "grant-failed",
        redeemedAt: PARTIAL_NOW,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: PARTIAL_NOW,
        entitlementExpiresAt: new Date(PARTIAL_NOW.getTime() + 3 * DAY_MS),
      },
    });

    const failedRun = await sendDueGrantExpiryReminders(PARTIAL_NOW, {
      createNotification: async () => {
        throw new Error("DB notification down");
      },
      sendEmail: async () => false,
      recordTelemetry: async () => ({} as never),
    });
    assert.equal(failedRun.remindersSent, 0, "FAILED delivery is never counted as sent");
    assert.equal(failedRun.deliveryFailed, 1);
    const failedLog = await prisma.grantExpiryReminderLog.findUniqueOrThrow({
      where: {
        userId_couponRedemptionId_kind: {
          userId: "grant-failed",
          couponRedemptionId: failedRedemption.id,
          kind: "d3",
        },
      },
    });
    assert.equal(failedLog.status, "FAILED");
    assert.equal(failedLog.failureCode, "notification_and_email_failed");

    // ── 7. Concurrent Workers Deduplication ──────────────────────────────────
    const CONCURRENT_NOW = new Date(NOW.getTime() + 150 * DAY_MS);
    await prisma.user.create({
      data: {
        id: "grant-concurrent",
        name: "Concurrent",
        email: "concurrent@example.test",
        role: "USER",
        plan: "PRO",
        planExpiresAt: new Date(CONCURRENT_NOW.getTime() + 1 * DAY_MS),
      },
    });
    const concurrentRedemption = await prisma.couponRedemption.create({
      data: {
        couponId: couponPro30.id,
        userId: "grant-concurrent",
        redeemedAt: CONCURRENT_NOW,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: CONCURRENT_NOW,
        entitlementExpiresAt: new Date(CONCURRENT_NOW.getTime() + 1 * DAY_MS),
      },
    });

    let concurrentNotifyCalls = 0;
    let concurrentEmailCalls = 0;
    const concurrentDeps = {
      createNotification: async () => {
        concurrentNotifyCalls += 1;
        return {} as never;
      },
      sendEmail: async () => {
        concurrentEmailCalls += 1;
        return true;
      },
      recordTelemetry: async () => ({} as never),
    };
    await Promise.all([
      sendDueGrantExpiryReminders(CONCURRENT_NOW, concurrentDeps),
      sendDueGrantExpiryReminders(CONCURRENT_NOW, concurrentDeps),
    ]);
    assert.equal(concurrentNotifyCalls, 1, "concurrent workers send at most 1 notification");
    assert.equal(concurrentEmailCalls, 1, "concurrent workers send at most 1 email");
    assert.equal(
      await prisma.grantExpiryReminderLog.count({
        where: {
          userId: "grant-concurrent",
          couponRedemptionId: concurrentRedemption.id,
          kind: "d1",
        },
      }),
      1,
    );

    // ── 8. In-App Expiring Banner Resolver (`<= 14` days + Suppression) ──────
    const d10Banner = await resolveUserExpiringGrantBanner("grant-d10-not-yet", NOW);
    assert.ok(d10Banner, "HERO-103: unpaid GRANT user with 10 days left sees 14-day expiring banner");
    assert.equal(d10Banner.plan, "PRO");
    assert.equal(d10Banner.daysLeft, 10);

    const d5Banner = await resolveUserExpiringGrantBanner("grant-d5-banner-only", NOW);
    assert.ok(d5Banner, "unpaid GRANT user with 5 days left sees expiring banner");
    assert.equal(d5Banner.plan, "PRO");
    assert.equal(d5Banner.daysLeft, 5);
    assert.equal(d5Banner.href, "/pricing?source=grant_banner");
    assert.equal(d5Banner.canConvertCardImmediately, true);
    assert.equal(
      d5Banner.copy,
      "สิทธิ์คูปองเรียน PRO ของคุณจะหมดในอีก 5 วัน — ต่อสิทธิ์ต่อเนื่องเพื่อเก็บโปรเจกต์และแบรนด์ทั้งหมดไว้ใช้งานต่อ",
    );

    const d3BizBanner = await resolveUserExpiringGrantBanner("grant-d3-biz", NOW);
    assert.ok(d3BizBanner, "BUSINESS grant user with 3 days left sees BUSINESS banner");
    assert.equal(d3BizBanner.plan, "BUSINESS");
    assert.equal(d3BizBanner.daysLeft, 3);

    // Suppressed / out-of-window users see NO banner
    for (const noBannerUserId of [
      "grant-d15-not-yet",
      "grant-stacked",
      "grant-suppressed-stripe-sub",
      "grant-suppressed-cash",
      "grant-suppressed-admin-grant",
      "grant-suppressed-bundle-user",
      "grant-suppressed-bundle-email",
      "grant-excluded-admin",
      "grant-excluded-internal",
    ]) {
      assert.equal(
        await resolveUserExpiringGrantBanner(noBannerUserId, NOW),
        null,
        `${noBannerUserId} must NOT see expiring GRANT banner`,
      );
    }

    // ── 9. Cron Route Auth, End-to-End JSON Response & Fault Isolation ───────
    const unauthRes = await cronRoute.GET(new Request("http://localhost/api/cron/renewal-reminders"));
    assert.equal(unauthRes.status, 401, "cron route rejects missing Bearer secret");

    const authedRes = await cronRoute.GET(
      new Request("http://localhost/api/cron/renewal-reminders", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    assert.equal(authedRes.status, 200, "cron route succeeds with valid Bearer secret");
    const cronPayload = (await authedRes.json()) as Record<string, unknown>;
    assert.ok("grantExpiryChecked" in cronPayload, "cron response reports grantExpiryChecked");
    assert.ok("grantExpirySent" in cronPayload, "cron response reports grantExpirySent");
    assert.ok("grantExpiryByKind" in cronPayload, "cron response reports grantExpiryByKind");

    // Fault-isolation proof: seed a live cash-backed renewal user + a live GRANT user
    // anchored to real `new Date()`, force GrantExpiryReminderLog table failure, and
    // verify the cash `renewal-reminders` sweep STILL completes with HTTP 200.
    const realNow = new Date();
    const realCashExpires = new Date(realNow.getTime() + 14 * DAY_MS);
    await prisma.user.create({
      data: {
        id: "live-cash-isolation",
        name: "Live Cash",
        email: "live-cash@example.test",
        role: "USER",
        plan: "PRO",
        billingPeriod: "annual",
        planExpiresAt: realCashExpires,
      },
    });
    await prisma.payment.create({
      data: {
        id: "pay-live-cash-isolation",
        userId: "live-cash-isolation",
        stripeSessionId: "cs_live_cash_isolation",
        plan: "PRO",
        amount: 299_500,
        periodDays: 365,
        status: "PAID",
        note: "annual",
        paidAt: new Date(realCashExpires.getTime() - 365 * DAY_MS),
        createdAt: new Date(realCashExpires.getTime() - 365 * DAY_MS),
      },
    });
    await prisma.user.create({
      data: {
        id: "live-grant-isolation",
        name: "Live Grant",
        email: "live-grant@example.test",
        role: "USER",
        plan: "PRO",
        planExpiresAt: new Date(realNow.getTime() + 3 * DAY_MS),
      },
    });
    await prisma.couponRedemption.create({
      data: {
        couponId: couponPro30.id,
        userId: "live-grant-isolation",
        redeemedAt: realNow,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: realNow,
        entitlementExpiresAt: new Date(realNow.getTime() + 3 * DAY_MS),
      },
    });

    await prisma.$executeRawUnsafe('DROP TABLE "GrantExpiryReminderLog"');
    const origError = console.error;
    console.error = () => {};
    let faultIsolatedRes: Response;
    try {
      faultIsolatedRes = await cronRoute.GET(
        new Request("http://localhost/api/cron/renewal-reminders", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        }),
      );
    } finally {
      console.error = origError;
    }
    assert.equal(faultIsolatedRes.status, 200, "grant sweep DB failure never aborts cron HTTP 200");
    const faultPayload = (await faultIsolatedRes.json()) as Record<string, unknown>;
    assert.equal(faultPayload.cashBacked, 1, "cash-backed renewal sweep still ran to completion");
    assert.equal(faultPayload.remindersSent, 1, "cash-backed renewal reminder still delivered");
    assert.equal(typeof faultPayload.grantExpiryError, "string", "grant sweep failure is reported in payload");

    await prisma.$disconnect();
    console.log("verify-grant-expiry-reminders: PASS d7/d3/d1 firing, stacked-grant maxGrantExpiresAt, cash/Stripe/Bundle/AdminGrant suppression, admin exclusion, at-most-once idempotency, CLAIMED/DELIVERED/PARTIAL/FAILED states, fault isolation, and banner resolution");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
