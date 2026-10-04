// Proof for docs/plans/2026-10-04-promptpay-monthly.md, Task 4: renewal and
// past-due reminders for the PromptPay 30-day prepaid term (ADR 0066).
//
// A. pure logic in src/lib/renewal-reminders.ts (selectRenewalKind, the matched
//    cash payment, copy, link) — flag on and off
// B. pure logic in src/lib/past-due-dunning.ts (copy, link, the cash-settled skip)
// C. sendDueRenewalReminders against a throwaway SQLite: a 30-day term gets only
//    d3/d1 with 30-day copy and a PromptPay link; an annual term is unchanged
//    except the link, under the flag; flag off is byte-for-byte today's behavior
// D. deliverPastDueReminder / sendDuePastDueFollowUps against the same DB: the
//    not-entitled link, the still-entitled suffix, and the cash-settled d3 skip
// E. wiring: /api/user/me delivers the flag at RUNTIME and PastDueBanner reads
//    it from there (not a prop from the statically-prerendered (dashboard)
//    layout — branch-review B1), and the banner's flag-off tree stays
//    byte-for-byte the pre-ADR-0066 single <button> (branch-review A1).
//
// Stripe is never called, and no real email is ever sent — every email/notify
// dependency is a plain injected stub.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-promptpay-monthly-reminders.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "promptpay-monthly-reminders-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.NEXTAUTH_URL = "https://studio.example.test";
delete process.env.PROMPTPAY_MONTHLY;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

const NOW = new Date("2026-10-04T02:00:00Z"); // 09:00 Bangkok
const DAY_MS = 24 * 60 * 60 * 1_000;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

async function main() {
  const renewal = await import("../src/lib/renewal-reminders");
  const pastDue = await import("../src/lib/past-due-dunning");

  // ── A · renewal-reminders.ts pure logic ───────────────────────────────────
  console.log("A. renewal-reminders.ts: selectRenewalKind, matched payment, copy, link");
  {
    check("isThirtyDayRenewalTerm: 30 → true, 365 → false, boundary 300 → false",
      renewal.isThirtyDayRenewalTerm(30) === true
      && renewal.isThirtyDayRenewalTerm(365) === false
      && renewal.isThirtyDayRenewalTerm(300) === false
      && renewal.isThirtyDayRenewalTerm(299) === true);

    // d30/d14 only fire for a term whose periodDays >= 300.
    assert.deepEqual(renewal.selectRenewalKind(30, 30), { send: false, reason: "not_due" });
    assert.deepEqual(renewal.selectRenewalKind(14, 30), { send: false, reason: "not_due" });
    assert.deepEqual(renewal.selectRenewalKind(30, 365), { send: true, kind: "d30" });
    assert.deepEqual(renewal.selectRenewalKind(14, 365), { send: true, kind: "d14" });
    // d3/d1 fire for every cash-backed term regardless of length.
    assert.deepEqual(renewal.selectRenewalKind(3, 30), { send: true, kind: "d3" });
    assert.deepEqual(renewal.selectRenewalKind(1, 30), { send: true, kind: "d1" });
    assert.deepEqual(renewal.selectRenewalKind(3, 365), { send: true, kind: "d3" });
    assert.deepEqual(renewal.selectRenewalKind(1, 365), { send: true, kind: "d1" });
    assert.deepEqual(renewal.selectRenewalKind(2, 30), { send: false, reason: "not_due" });
    check("selectRenewalKind: 30-day term gets only d3/d1, annual term keeps d30/d14/d3/d1", true);

    // renewalReminderLink: default (no 4th arg) is byte-for-byte the pre-feature link.
    check("renewalReminderLink: default has no method param (flag-off callers)",
      renewal.renewalReminderLink("d14", "PRO", "annual") === "/pricing?source=renewal_d14&period=annual#plan-pro");
    check("renewalReminderLink: promptpayMonthly=true adds &method=promptpay (monthly)",
      renewal.renewalReminderLink("d3", "BUSINESS", "monthly", true)
      === "/pricing?source=renewal_d3&period=monthly&method=promptpay#plan-business");
    check("renewalReminderLink: promptpayMonthly=true adds &method=promptpay on an ANNUAL link too",
      renewal.renewalReminderLink("d30", "PRO", "annual", true)
      === "/pricing?source=renewal_d30&period=annual&method=promptpay#plan-pro");
    check("renewalReminderLink: promptpayMonthly=false is identical to the default",
      renewal.renewalReminderLink("d1", "PRO", "monthly", false)
      === "/pricing?source=renewal_d1&period=monthly#plan-pro");

    // renewalReminderCopy: 30-day body only when periodDays is passed and < 300.
    check("renewalReminderCopy: no periodDays arg → today's body (flag-off callers)",
      renewal.renewalReminderCopy("d14", "PRO").body === "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด");
    check("renewalReminderCopy: periodDays 30 → the 30-day Copy-table body",
      renewal.renewalReminderCopy("d3", "PRO", 30).body
      === "ต่ออีก 30 วันด้วย PromptPay ก่อนหมด เพื่อสร้างและส่งออกงานต่อได้ไม่สะดุด");
    check("renewalReminderCopy: periodDays 365 → unchanged body (annual predicate)",
      renewal.renewalReminderCopy("d30", "PRO", 365).body === "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด");

    // matchedCashBackedPayment ↔ isCashBackedRenewalTerm never disagree, and the
    // matched payment is the most recent of several qualifying ones.
    const expiresAt = new Date("2026-11-03T09:00:00Z");
    const older = { plan: "PRO", amount: 59_900, periodDays: 30, note: null, paidAt: new Date(expiresAt.getTime() - 60 * DAY_MS), createdAt: new Date(expiresAt.getTime() - 60 * DAY_MS) };
    const newer = { plan: "PRO", amount: 59_900, periodDays: 30, note: null, paidAt: new Date(expiresAt.getTime() - 30 * DAY_MS), createdAt: new Date(expiresAt.getTime() - 30 * DAY_MS) };
    const candidate = { plan: "PRO", planExpiresAt: expiresAt, stripeSubscriptionId: null, payments: [older, newer] };
    check("matchedCashBackedPayment: picks the most recent qualifying payment",
      renewal.matchedCashBackedPayment(candidate) === newer);
    check("matchedCashBackedPayment ↔ isCashBackedRenewalTerm agree (cash-backed)",
      renewal.isCashBackedRenewalTerm(candidate) === true && renewal.matchedCashBackedPayment(candidate) !== null);
    const noCash = { plan: "PRO", planExpiresAt: expiresAt, stripeSubscriptionId: null, payments: [] };
    check("matchedCashBackedPayment ↔ isCashBackedRenewalTerm agree (no cash)",
      renewal.isCashBackedRenewalTerm(noCash) === false && renewal.matchedCashBackedPayment(noCash) === null);
  }

  // ── B · past-due-dunning.ts pure logic ────────────────────────────────────
  console.log("\nB. past-due-dunning.ts: copy, link, cash-settled skip");
  {
    const offBody = pastDue.pastDueReminderCopy({ kind: "failed", plan: "PRO", stillEntitled: true }).body;
    check("pastDueReminderCopy: no flag arg → today's still-entitled body (unchanged)",
      offBody === "บัตรของคุณถูกปฏิเสธตอนต่ออายุ PRO — อัปเดตวิธีชำระเงินเพื่อใช้งานต่อไม่สะดุด ระบบจะลองเก็บอีกครั้งอัตโนมัติ");
    const onBody = pastDue.pastDueReminderCopy({ kind: "failed", plan: "PRO", stillEntitled: true, promptpayMonthly: true }).body;
    check("pastDueReminderCopy: still-entitled + flag → Copy suffix appended",
      onBody === `${offBody} · ไม่มีบัตรที่ใช้ได้? จ่าย PromptPay แทนได้ที่หน้าราคา`);

    const lapsedOff = pastDue.pastDueReminderCopy({ kind: "failed", plan: "BUSINESS", stillEntitled: false });
    check("pastDueReminderCopy: no flag arg → today's not-entitled body + unchanged CTA",
      lapsedOff.body === "บัตรที่ผูกไว้ถูกปฏิเสธ บัญชีจึงกลับเป็น FREE ชั่วคราว — อัปเดตบัตรแล้วสิทธิ์ BUSINESS จะกลับมาทันทีที่เก็บเงินสำเร็จ"
      && lapsedOff.cta === "กลับมาใช้ BUSINESS");
    const lapsedOn = pastDue.pastDueReminderCopy({ kind: "failed", plan: "BUSINESS", stillEntitled: false, promptpayMonthly: true });
    check("pastDueReminderCopy: not-entitled + flag → Copy-table replacement body, CTA unchanged",
      lapsedOn.body === "บัตรที่ผูกไว้ถูกปฏิเสธ บัญชีจึงกลับเป็น FREE ชั่วคราว — อัปเดตบัตร หรือจ่าย PromptPay เพื่อกลับมาใช้ BUSINESS ทันที"
      && lapsedOn.cta === "กลับมาใช้ BUSINESS");

    check("pastDueReminderLink: flag off → unchanged card-update link",
      pastDue.pastDueReminderLink({ stillEntitled: false, plan: "PRO", billingPeriod: "monthly", promptpayMonthly: false }) === pastDue.PAST_DUE_LINK);
    check("pastDueReminderLink: still entitled (flag on) → unchanged card-update link",
      pastDue.pastDueReminderLink({ stillEntitled: true, plan: "PRO", billingPeriod: "monthly", promptpayMonthly: true }) === pastDue.PAST_DUE_LINK);
    check("pastDueReminderLink: not entitled + flag, monthly → pricing link per Copy",
      pastDue.pastDueReminderLink({ stillEntitled: false, plan: "PRO", billingPeriod: "monthly", promptpayMonthly: true })
      === "/pricing?source=past_due&period=monthly&method=promptpay#plan-pro");
    check("pastDueReminderLink: not entitled + flag, annual → pricing link honors billingPeriod",
      pastDue.pastDueReminderLink({ stillEntitled: false, plan: "BUSINESS", billingPeriod: "annual", promptpayMonthly: true })
      === "/pricing?source=past_due&period=annual&method=promptpay#plan-business");
    check("pastDueReminderLink: not entitled + flag, no billingPeriod → defaults to monthly",
      pastDue.pastDueReminderLink({ stillEntitled: false, plan: "PRO", billingPeriod: null, promptpayMonthly: true })
      === "/pricing?source=past_due&period=monthly&method=promptpay#plan-pro");

    const after = new Date("2026-10-01T00:00:00Z");
    check("hasCashPaymentAfter: a PAID plan payment after the failed invoice → true",
      pastDue.hasCashPaymentAfter([{ amount: 59_900, periodDays: 30, note: null, createdAt: new Date(after.getTime() + DAY_MS) }], after));
    check("hasCashPaymentAfter: the same payment BEFORE the failed invoice → false",
      !pastDue.hasCashPaymentAfter([{ amount: 59_900, periodDays: 30, note: null, createdAt: new Date(after.getTime() - DAY_MS) }], after));
    check("hasCashPaymentAfter: a credit top-up does not count",
      !pastDue.hasCashPaymentAfter([{ amount: 19_900, periodDays: 30, note: "credits", createdAt: new Date(after.getTime() + DAY_MS) }], after));
    check("hasCashPaymentAfter: a zero-amount / zero-periodDays row does not count",
      !pastDue.hasCashPaymentAfter([
        { amount: 0, periodDays: 30, note: null, createdAt: new Date(after.getTime() + DAY_MS) },
        { amount: 59_900, periodDays: 0, note: null, createdAt: new Date(after.getTime() + DAY_MS) },
      ], after));
    check("hasCashPaymentAfter: no payments → false", !pastDue.hasCashPaymentAfter([], after));

    // Review A7: a PromptPay row is created PENDING at checkout start and only turns PAID once
    // scanned, so the moment that matters is `paidAt`, not `createdAt`. A checkout STARTED before
    // the failed-invoice claim but PAID after it must still count.
    check("hasCashPaymentAfter: checkout started (createdAt) BEFORE the claim, paid AFTER it → true (uses paidAt, not createdAt)",
      pastDue.hasCashPaymentAfter([{
        amount: 59_900, periodDays: 30, note: null,
        createdAt: new Date(after.getTime() - DAY_MS), paidAt: new Date(after.getTime() + DAY_MS),
      }], after));
    check("hasCashPaymentAfter: createdAt AFTER the claim but paidAt BEFORE it → false (paidAt wins over createdAt)",
      !pastDue.hasCashPaymentAfter([{
        amount: 59_900, periodDays: 30, note: null,
        createdAt: new Date(after.getTime() + DAY_MS), paidAt: new Date(after.getTime() - DAY_MS),
      }], after));
    check("hasCashPaymentAfter: no paidAt on file → falls back to createdAt (after → true)",
      pastDue.hasCashPaymentAfter([{
        amount: 59_900, periodDays: 30, note: null, createdAt: new Date(after.getTime() + DAY_MS), paidAt: null,
      }], after));
    check("hasCashPaymentAfter: no paidAt on file → falls back to createdAt (before → false)",
      !pastDue.hasCashPaymentAfter([{
        amount: 59_900, periodDays: 30, note: null, createdAt: new Date(after.getTime() - DAY_MS), paidAt: null,
      }], after));
  }

  // ── C · sendDueRenewalReminders against a throwaway SQLite ───────────────
  console.log("\nC. sendDueRenewalReminders: 30-day term reminders, flag on and off");
  {
    const { prisma } = await import("../src/lib/prisma");
    const { sendDueRenewalReminders } = await import("../src/lib/renewal-reminders.server");

    async function createTermUser(input: { id: string; now: Date; daysLeft: number; periodDays: number }) {
      const expiresAt = new Date(input.now.getTime() + input.daysLeft * DAY_MS);
      await prisma.user.create({
        data: {
          id: input.id, name: input.id, email: `${input.id}@example.test`, role: "USER",
          plan: "PRO", billingPeriod: "monthly", planExpiresAt: expiresAt, stripeSubscriptionId: null,
        },
      });
      await prisma.payment.create({
        data: {
          id: `payment-${input.id}`, userId: input.id, stripeSessionId: `session-${input.id}`,
          plan: "PRO", amount: 59_900, periodDays: input.periodDays, note: null, status: "PAID",
          paidAt: new Date(expiresAt.getTime() - input.periodDays * DAY_MS),
          createdAt: new Date(expiresAt.getTime() - input.periodDays * DAY_MS),
        },
      });
      return expiresAt;
    }

    function depsFor() {
      const notifications: Array<Record<string, unknown>> = [];
      const emails: Array<Record<string, unknown>> = [];
      return {
        notifications, emails,
        deps: {
          createNotification: async (input: Record<string, unknown>) => { notifications.push(input); return {} as never; },
          sendEmail: async (input: Record<string, unknown>) => { emails.push(input); return true; },
          recordTelemetry: async () => ({} as never),
        },
      };
    }

    // Flag ON: a 30-day term at d30/d14 sends NOTHING; at d3/d1 it sends the 30-day copy + link.
    process.env.PROMPTPAY_MONTHLY = "1";
    await createTermUser({ id: "ppm-30day-d30", now: NOW, daysLeft: 30, periodDays: 30 });
    await createTermUser({ id: "ppm-30day-d14", now: NOW, daysLeft: 14, periodDays: 30 });
    const { notifications: n1, emails: e1, deps: d1 } = depsFor();
    const runD30D14 = await sendDueRenewalReminders(NOW, d1 as never);
    check("flag on: 30-day term at d30 and d14 → zero reminders (cashBacked counted, none due)",
      runD30D14.cashBacked === 2 && runD30D14.remindersSent === 0 && n1.length === 0 && e1.length === 0,
      JSON.stringify(runD30D14));

    await createTermUser({ id: "ppm-30day-d3", now: NOW, daysLeft: 3, periodDays: 30 });
    const { notifications: n2, emails: e2, deps: d2 } = depsFor();
    const runD3 = await sendDueRenewalReminders(NOW, d2 as never);
    check("flag on: 30-day term at d3 → sent, 30-day copy, &method=promptpay link",
      runD3.remindersSent === 1 && runD3.byKind.d3 === 1
      && n2[0]?.link === "/pricing?source=renewal_d3&period=monthly&method=promptpay#plan-pro"
      && String(n2[0]?.body) === "ต่ออีก 30 วันด้วย PromptPay ก่อนหมด เพื่อสร้างและส่งออกงานต่อได้ไม่สะดุด"
      && /method=promptpay/.test(String(e2[0]?.pricingUrl)),
      JSON.stringify({ run: runD3, n: n2[0], e: e2[0] }));

    // Flag ON: an annual term keeps d30/d14/d3/d1 and its copy, link gains &method=promptpay.
    await createTermUser({ id: "ppm-annual-d30", now: NOW, daysLeft: 30, periodDays: 365 });
    const { notifications: n3, emails: e3, deps: d3 } = depsFor();
    const runAnnual = await sendDueRenewalReminders(NOW, d3 as never);
    check("flag on: annual term at d30 → still sent, unchanged copy, link gains &method=promptpay",
      runAnnual.remindersSent === 1 && runAnnual.byKind.d30 === 1
      && n3[0]?.link === "/pricing?source=renewal_d30&period=monthly&method=promptpay#plan-pro"
      && String(n3[0]?.body) === "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด",
      JSON.stringify({ run: runAnnual, n: n3[0] }));
    void e3;

    // Flag OFF: a (hypothetical) 30-day term is treated exactly as before this feature —
    // d30/d14/d3/d1 all fire with the old copy and link (no method param).
    delete process.env.PROMPTPAY_MONTHLY;
    await createTermUser({ id: "ppm-flagoff-d30", now: NOW, daysLeft: 30, periodDays: 30 });
    const { notifications: n4, emails: e4, deps: d4 } = depsFor();
    const runOff = await sendDueRenewalReminders(NOW, d4 as never);
    const flagOffTarget = n4.find((n) => n.userId === "ppm-flagoff-d30");
    check("flag off: a 30-day term at d30 fires exactly as today (no method param, old copy)",
      flagOffTarget?.link === "/pricing?source=renewal_d30&period=monthly#plan-pro"
      && String(flagOffTarget?.body) === "ต่ออายุก่อนหมดเพื่อสร้างและส่งออกงานต่อได้โดยไม่สะดุด",
      JSON.stringify({ run: runOff, n: flagOffTarget }));
    void e4;

    await prisma.user.deleteMany({ where: { id: { startsWith: "ppm-" } } });
  }

  // ── D · past-due reminders against the same throwaway SQLite ─────────────
  console.log("\nD. deliverPastDueReminder / sendDuePastDueFollowUps: PromptPay surfaces");
  {
    const { prisma } = await import("../src/lib/prisma");
    const dunning = await import("../src/lib/past-due-dunning.server");
    const { deliverPastDueReminder, sendDuePastDueFollowUps } = dunning;

    async function createPastDueUser(input: { id: string; plan?: "PRO" | "BUSINESS" | "FREE"; planExpiresAt: Date | null; billingPeriod?: string | null }) {
      await prisma.user.create({
        data: {
          id: input.id, name: input.id, email: `${input.id}@example.test`, role: "USER",
          plan: input.plan ?? "PRO", billingPeriod: input.billingPeriod ?? "monthly",
          planExpiresAt: input.planExpiresAt, stripeSubscriptionId: `sub-${input.id}`,
          stripeCustomerId: `cus-${input.id}`, subStatus: "past_due",
        },
      });
    }

    function depsFor() {
      const notifications: Array<Record<string, unknown>> = [];
      const emails: Array<Record<string, unknown>> = [];
      return {
        notifications, emails,
        deps: {
          createNotification: async (input: Record<string, unknown>) => { notifications.push(input); return {} as never; },
          sendEmail: async (input: Record<string, unknown>) => { emails.push(input); return true; },
          recordTelemetry: async () => ({} as never),
          emailEnabled: () => true,
        },
      };
    }

    process.env.PROMPTPAY_MONTHLY = "1";

    // Still entitled + flag on: card-update link unchanged, body gets the Copy suffix.
    await createPastDueUser({ id: "ppm-pd-entitled", planExpiresAt: new Date(NOW.getTime() + 20 * DAY_MS), billingPeriod: "monthly" });
    const { notifications: n1, emails: e1, deps: d1 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-entitled", stripeInvoiceId: "ppm_in_1", kind: "failed" }, NOW, d1 as never);
    check("flag on, still entitled: link unchanged, body has the PromptPay suffix",
      n1[0]?.link === pastDue.PAST_DUE_LINK && /ไม่มีบัตรที่ใช้ได้\? จ่าย PromptPay แทนได้ที่หน้าราคา$/.test(String(n1[0]?.body))
      && e1[0]?.billingUrl === `https://studio.example.test${pastDue.PAST_DUE_LINK}`,
      JSON.stringify({ n: n1[0], e: e1[0] }));

    // Not entitled + flag on: pricing link with method=promptpay, honoring billingPeriod; CTA unchanged.
    await createPastDueUser({ id: "ppm-pd-lapsed", plan: "FREE", planExpiresAt: new Date(NOW.getTime() - 1 * DAY_MS), billingPeriod: "annual" });
    const { notifications: n2, emails: e2, deps: d2 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-lapsed", stripeInvoiceId: "ppm_in_2", kind: "failed" }, NOW, d2 as never);
    check("flag on, not entitled: pricing link per Copy, honors billingPeriod=annual, CTA unchanged",
      n2[0]?.link === "/pricing?source=past_due&period=annual&method=promptpay#plan-pro"
      && e2[0]?.cta === "กลับมาใช้ PRO"
      && e2[0]?.billingUrl === "https://studio.example.test/pricing?source=past_due&period=annual&method=promptpay#plan-pro",
      JSON.stringify({ n: n2[0], e: e2[0] }));

    // Flag off: exactly today's behavior (unchanged link, no suffix) for the same shape.
    delete process.env.PROMPTPAY_MONTHLY;
    await createPastDueUser({ id: "ppm-pd-lapsed-off", plan: "FREE", planExpiresAt: new Date(NOW.getTime() - 1 * DAY_MS) });
    const { notifications: n3, deps: d3 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-lapsed-off", stripeInvoiceId: "ppm_in_3", kind: "failed" }, NOW, d3 as never);
    check("flag off: not-entitled link and body are exactly today's",
      n3[0]?.link === pastDue.PAST_DUE_LINK
      && n3[0]?.body === "บัตรที่ผูกไว้ถูกปฏิเสธ บัญชีจึงกลับเป็น FREE ชั่วคราว — อัปเดตบัตรแล้วสิทธิ์ PRO จะกลับมาทันทีที่เก็บเงินสำเร็จ",
      JSON.stringify(n3[0]));

    // d3 follow-up skip: a PAID cash Payment after the failed invoice → skipped, under the flag.
    process.env.PROMPTPAY_MONTHLY = "1";
    await createPastDueUser({ id: "ppm-pd-settled", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) });
    const { deps: d4 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-settled", stripeInvoiceId: "ppm_in_4", kind: "failed" }, NOW, d4 as never);
    await prisma.payment.create({
      data: {
        userId: "ppm-pd-settled", stripeSessionId: "ppm_pp_settle", plan: "PRO", amount: 59_900,
        currency: "thb", status: "PAID", periodDays: 30, note: null, paidAt: new Date(NOW.getTime() + 1 * DAY_MS),
        createdAt: new Date(NOW.getTime() + 1 * DAY_MS),
      },
    });
    const day3 = new Date(NOW.getTime() + 3 * DAY_MS);
    const { notifications: n5, deps: d5 } = depsFor();
    const skipRun = await sendDuePastDueFollowUps(day3, d5 as never);
    check("flag on: a cash payment after the failed invoice skips the d3 follow-up",
      skipRun.promptpaySettled === 1 && !n5.some((n) => n.userId === "ppm-pd-settled"),
      JSON.stringify({ run: skipRun, n5 }));

    // Same shape, flag off: the skip does not apply (d3 still fires, matching pre-feature behavior).
    delete process.env.PROMPTPAY_MONTHLY;
    await createPastDueUser({ id: "ppm-pd-settled-off", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) });
    const { deps: d6 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-settled-off", stripeInvoiceId: "ppm_in_5", kind: "failed" }, NOW, d6 as never);
    await prisma.payment.create({
      data: {
        userId: "ppm-pd-settled-off", stripeSessionId: "ppm_pp_settle_off", plan: "PRO", amount: 59_900,
        currency: "thb", status: "PAID", periodDays: 30, note: null, paidAt: new Date(NOW.getTime() + 1 * DAY_MS),
        createdAt: new Date(NOW.getTime() + 1 * DAY_MS),
      },
    });
    const { notifications: n7, deps: d7 } = depsFor();
    const noSkipRun = await sendDuePastDueFollowUps(day3, d7 as never);
    check("flag off: the cash-settled skip does not apply — d3 fires for this account",
      n7.some((n) => n.userId === "ppm-pd-settled-off") && (noSkipRun.promptpaySettled ?? 0) === 0,
      JSON.stringify(noSkipRun));

    // Review A7, reproduced end-to-end: the PromptPay checkout STARTED (Payment row created
    // PENDING) before the failed-invoice claim, and only turned PAID after it (`paidAt` after,
    // `createdAt` before). Comparing on createdAt would miss this and send the d3 nudge anyway.
    process.env.PROMPTPAY_MONTHLY = "1";
    await createPastDueUser({ id: "ppm-pd-pending-before", planExpiresAt: new Date(NOW.getTime() + 5 * DAY_MS) });
    const { deps: d8 } = depsFor();
    await deliverPastDueReminder({ userId: "ppm-pd-pending-before", stripeInvoiceId: "ppm_in_6", kind: "failed" }, NOW, d8 as never);
    await prisma.payment.create({
      data: {
        userId: "ppm-pd-pending-before", stripeSessionId: "ppm_pp_pending_before", plan: "PRO", amount: 59_900,
        currency: "thb", status: "PAID", periodDays: 30, note: null,
        createdAt: new Date(NOW.getTime() - 1 * DAY_MS), // checkout started BEFORE the claim
        paidAt: new Date(NOW.getTime() + 1 * DAY_MS), // settled AFTER the claim
      },
    });
    const { notifications: n8, deps: d9 } = depsFor();
    const pendingBeforeRun = await sendDuePastDueFollowUps(day3, d9 as never);
    check("flag on: PENDING-before/paid-after cash payment still skips the d3 follow-up (uses paidAt, not createdAt)",
      pendingBeforeRun.promptpaySettled >= 1 && !n8.some((n) => n.userId === "ppm-pd-pending-before"),
      JSON.stringify({ run: pendingBeforeRun, n8 }));

    await prisma.payment.deleteMany({ where: { id: { startsWith: "ppm_" } } });
    await prisma.pastDueReminderLog.deleteMany({ where: { userId: { startsWith: "ppm-pd-" } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: "ppm-pd-" } } });
    await prisma.$disconnect();
  }

  // ── E · wiring (source text, the repo's route-check pattern) ─────────────
  console.log("\nE. wiring: /api/user/me delivers the flag at runtime; the (dashboard)");
  console.log("   layout and components/layout never freeze it at build time");
  {
    // branch-review B1: the (dashboard) layout is statically prerendered, so a
    // server layout reading the flag and passing it down as a prop freezes the
    // value into those pages' RSC payload at BUILD time — a restart-only
    // rollback (unset the env var + restart, no rebuild) would then not revert
    // the banner. No file under (dashboard)/layout.tsx or components/layout/
    // may call promptpayMonthlyEnabled() ever again.
    const dashLayout = src("src/app/(dashboard)/layout.tsx");
    check("(dashboard)/layout.tsx does NOT read promptpayMonthlyEnabled() (B1 — static prerender freezes it)",
      !dashLayout.includes("promptpayMonthlyEnabled"));
    check("(dashboard)/layout.tsx has no NEXT_PUBLIC_ twin for the flag",
      !dashLayout.includes("NEXT_PUBLIC_PROMPTPAY_MONTHLY"));

    const dashboardLayoutComponent = src("src/components/layout/dashboard-layout.tsx");
    check("dashboard-layout.tsx does NOT read promptpayMonthlyEnabled() and does not pass a promptpayMonthly prop to PastDueBanner",
      !dashboardLayoutComponent.includes("promptpayMonthlyEnabled")
      && !dashboardLayoutComponent.includes("promptpayMonthly")
      && /<PastDueBanner\s*\/>/.test(dashboardLayoutComponent));

    const userMeRoute = src("src/app/api/user/me/route.ts");
    check("/api/user/me reads promptpayMonthlyEnabled() and returns it in the response (runtime, per-request)",
      userMeRoute.includes("promptpayMonthlyEnabled()") && /promptpayMonthly:\s*promptpayMonthlyEnabled\(\)/.test(userMeRoute));

    const banner = src("src/components/layout/past-due-banner.tsx");
    check("past-due-banner.tsx takes no promptpayMonthly prop (no direct env read either)",
      !/export function PastDueBanner\([^)]*promptpayMonthly/.test(banner)
      && !banner.includes("process.env.PROMPTPAY_MONTHLY"));
    check("past-due-banner.tsx reads the flag from fetchMe() (the /api/user/me response), not a prop",
      banner.includes("fetchMe()") && banner.includes("me.promptpayMonthly"));
    check("past-due-banner.tsx renders the exact Copy secondary-link text",
      banner.includes("หรือจ่ายด้วย PromptPay"));
    check("past-due-banner.tsx uses pastDueReminderLink for the secondary link",
      banner.includes("pastDueReminderLink("));
    // branch-review A1: flag off (or not yet loaded) must render the ORIGINAL
    // single <button data-testid="past-due-banner"> tree unchanged — no wrapping
    // <div>, no lost px-4 py-2 on the clickable element. The wrapper is only
    // reachable once a PromptPay link exists.
    check("past-due-banner.tsx keeps the original single-<button> className+testid pair for the flag-off branch (A1)",
      banner.includes("!promptpayLink")
      && banner.includes('className="flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-70"'));
    const flagOnBranch = banner.split("!promptpayLink")[1] ?? "";
    check("past-due-banner.tsx's flag-on branch wraps a <div data-testid=\"past-due-banner\"> around two <button>s (secondary link, not a nested interactive control)",
      flagOnBranch.includes('<div')
      && flagOnBranch.includes('data-testid="past-due-banner"')
      && (flagOnBranch.match(/<button/g) ?? []).length >= 2
      && flagOnBranch.includes("past-due-banner-promptpay"));

    const renewalServer = src("src/lib/renewal-reminders.server.ts");
    check("renewal-reminders.server.ts reads the flag and uses selectRenewalKind + matchedCashBackedPayment",
      renewalServer.includes("promptpayMonthlyEnabled()")
      && renewalServer.includes("selectRenewalKind(")
      && renewalServer.includes("matchedCashBackedPayment("));

    const pastDueServer = src("src/lib/past-due-dunning.server.ts");
    check("past-due-dunning.server.ts reads the flag and uses pastDueReminderLink + hasCashPaymentAfter",
      pastDueServer.includes("promptpayMonthlyEnabled()")
      && pastDueServer.includes("pastDueReminderLink(")
      && pastDueServer.includes("hasCashPaymentAfter("));

    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
    check("npm script verify:promptpay-monthly chains this file",
      (pkg.scripts["verify:promptpay-monthly"] ?? "").includes("scripts/verify-promptpay-monthly-reminders.ts"));
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nverify-promptpay-monthly-reminders: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
