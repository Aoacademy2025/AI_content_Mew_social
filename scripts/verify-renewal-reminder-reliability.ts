import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isCashBackedRenewalTerm,
  renewalDeliveryStatus,
  renewalReminderDecision,
  renewalReminderLink,
  RENEWAL_REMINDER_KINDS,
} from "../src/lib/renewal-reminders";

const NOW = new Date("2026-08-27T09:00:00Z");
const EXPIRES = new Date("2027-08-27T09:00:00Z");

assert.deepEqual(RENEWAL_REMINDER_KINDS, ["d30", "d14", "d3", "d1"]);
assert.deepEqual(renewalReminderDecision(30), { send: true, kind: "d30" });
assert.deepEqual(renewalReminderDecision(14), { send: true, kind: "d14" });
assert.deepEqual(renewalReminderDecision(3), { send: true, kind: "d3" });
assert.deepEqual(renewalReminderDecision(1), { send: true, kind: "d1" });
assert.deepEqual(renewalReminderDecision(2), { send: false, reason: "not_due" });

assert.equal(
  renewalReminderLink("d14", "PRO", "annual"),
  "/pricing?source=renewal_d14&period=annual#plan-pro",
  "the CTA is attributable and opens the current plan/period",
);
assert.equal(
  renewalReminderLink("d3", "BUSINESS", "monthly"),
  "/pricing?source=renewal_d3&period=monthly#plan-business",
);

const foundingPayment = {
  plan: "PRO",
  amount: 299_500,
  periodDays: 365,
  note: "founding annual",
  paidAt: NOW,
  createdAt: NOW,
};
assert.equal(isCashBackedRenewalTerm({
  plan: "PRO",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: null,
  payments: [foundingPayment],
}), true, "a matching paid annual term is eligible");
assert.equal(isCashBackedRenewalTerm({
  plan: "PRO",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: "sub_auto_renews",
  payments: [foundingPayment],
}), false, "an auto-renew subscription does not receive manual renewal mail");
assert.equal(isCashBackedRenewalTerm({
  plan: "PRO",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: null,
  payments: [],
}), false, "a coupon/grant with no cash is excluded");
assert.equal(isCashBackedRenewalTerm({
  plan: "PRO",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: null,
  payments: [{ ...foundingPayment, note: "credits" }],
}), false, "a credit top-up is not plan-renewal evidence");
assert.equal(isCashBackedRenewalTerm({
  plan: "BUSINESS",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: null,
  payments: [foundingPayment],
}), false, "an old payment for a different plan cannot back the current term");
assert.equal(isCashBackedRenewalTerm({
  plan: "PRO",
  planExpiresAt: EXPIRES,
  stripeSubscriptionId: null,
  payments: [{ ...foundingPayment, paidAt: new Date("2025-01-01T00:00:00Z"), createdAt: new Date("2025-01-01T00:00:00Z") }],
}), false, "stale historical cash cannot turn a later comped term into a renewal");

assert.equal(renewalDeliveryStatus({ notificationDelivered: true, emailAttempted: true, emailDelivered: true }), "DELIVERED");
assert.equal(renewalDeliveryStatus({ notificationDelivered: true, emailAttempted: true, emailDelivered: false }), "PARTIAL");
assert.equal(renewalDeliveryStatus({ notificationDelivered: true, emailAttempted: false, emailDelivered: false }), "DELIVERED");
assert.equal(renewalDeliveryStatus({ notificationDelivered: false, emailAttempted: true, emailDelivered: false }), "FAILED");

const schema = readFileSync("prisma/schema.prisma", "utf8");
assert.match(schema, /model RenewalReminderLog/);
assert.match(schema, /@@unique\(\[userId, termExpiresAt, kind\]\)/, "one durable claim per user, term and reminder moment");

const route = readFileSync("src/app/api/cron/renewal-reminders/route.ts", "utf8");
assert.match(route, /sendDueRenewalReminders/, "the cron delegates to the tested delivery seam");
assert.doesNotMatch(route, /plan:\s*\{\s*not:\s*"FREE"/, "the route no longer treats a paid-looking label as cash");

const pricingPage = readFileSync("src/app/(dashboard)/pricing/page.tsx", "utf8");
const pricingClient = readFileSync("src/app/(dashboard)/pricing/pricing-client.tsx", "utf8");
const emailSource = readFileSync("src/lib/send-email.ts", "utf8");
assert.match(pricingPage, /preferredPeriod/, "the server validates and forwards the renewal period");
assert.match(pricingClient, /preferredPeriod/, "the renewal link preselects the customer's billing period");
assert.match(pricingClient, /id=\{`plan-\$\{key\.toLowerCase\(\)\}`\}/, "the URL fragment opens the customer's current plan card");
assert.match(
  pricingClient,
  /pricing_cta_clicked[\s\S]{0,500}source:\s*acquisitionSource/,
  "renewal source attribution survives the CTA click",
);
const renewalEmailSource = emailSource.slice(emailSource.indexOf("export async function sendRenewalReminderEmail"));
assert.doesNotMatch(
  renewalEmailSource.slice(0, renewalEmailSource.indexOf("export async function sendTrialReminderEmail")),
  /ล็อกราคาผู้ก่อตั้ง/,
  "renewal email must not promise a founding price the customer may not hold",
);

console.log("verify-renewal-reminder-reliability: PASS cash cohort, schedule, dedupe and delivery truth");
