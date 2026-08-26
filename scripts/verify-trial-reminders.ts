/**
 * Pure verification for the trial-expiry moment (issue #299).
 *
 * Covers: the three selection windows, once-per-user idempotency, the paid/coupon
 * exclusion, the day+3 "had an export" gate, the renewal-reminders trial exclusion,
 * and the honesty of the customer-facing copy (retention days must be the enforced
 * FREE rule from plan-limits, not a hardcoded number).
 *
 * No database: every rule under test lives in src/lib/trial-reminders.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideTrialReminder,
  effectiveTrialEnd,
  freeAllowanceLabel,
  isTrialSourcedPlan,
  trialReminderCopy,
  trialReminderKindFor,
  trialReminderLink,
  TRIAL_REMINDER_KINDS,
  TRIAL_REMINDER_OFFSET_DAYS,
  TRIAL_REMINDER_SOURCE,
  type TrialReminderInput,
} from "../src/lib/trial-reminders";
import { FREE_LIMITS, storageDaysForPlan } from "../src/lib/plan-limits";
import { isSafeNotificationLink } from "../src/lib/notification-link";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

// The cron fires 10:00 Asia/Bangkok; every window below is anchored to that clock.
const NOW = new Date("2026-09-10T10:00:00+07:00");

function trialUser(overrides: Partial<TrialReminderInput> = {}): TrialReminderInput {
  return {
    isInternal: false,
    suspended: false,
    paidEquivalent: false,
    trialStartedAt: new Date("2026-09-05T09:00:00+07:00"),
    trialEndsAt: new Date("2026-09-12T09:00:00+07:00"), // 2 calendar days out
    trialEndedAt: null,
    hasCompletedVideo: true,
    alreadySentKinds: [],
    now: NOW,
    ...overrides,
  };
}

// ── 1. Selection windows ─────────────────────────────────────────────────────
console.log("selection windows");
check("day 5 of the trial (2 days left) selects d5", (() => {
  const d = decideTrialReminder(trialUser());
  return d.send === true && d.kind === "d5";
})());

check("expiry day selects expiry", (() => {
  const d = decideTrialReminder(trialUser({ trialEndsAt: new Date("2026-09-10T09:00:00+07:00") }));
  return d.send === true && d.kind === "expiry";
})());

check("3 days after expiry selects d3after", (() => {
  const d = decideTrialReminder(trialUser({
    trialEndsAt: null,
    trialEndedAt: new Date("2026-09-07T09:00:00+07:00"),
  }));
  return d.send === true && d.kind === "d3after";
})());

for (const [label, endsAt] of [
  ["3 days left", "2026-09-13T09:00:00+07:00"],
  ["1 day left", "2026-09-11T09:00:00+07:00"],
  ["1 day after expiry", "2026-09-09T09:00:00+07:00"],
  ["4 days after expiry", "2026-09-06T09:00:00+07:00"],
] as const) {
  check(`${label} sends nothing`, (() => {
    const d = decideTrialReminder(trialUser({ trialEndsAt: new Date(endsAt) }));
    return d.send === false && d.reason === "outside_window";
  })());
}

check("a trial ending late at night is still 'today' in Bangkok", (() => {
  const d = decideTrialReminder(trialUser({ trialEndsAt: new Date("2026-09-10T23:30:00+07:00") }));
  return d.send === true && d.kind === "expiry";
})());

check("expiry day still selects after the 08:00 revert nulled trialEndsAt", (() => {
  const d = decideTrialReminder(trialUser({
    trialEndsAt: null,
    trialEndedAt: new Date("2026-09-10T09:00:00+07:00"),
  }));
  return d.send === true && d.kind === "expiry";
})());

check("effectiveTrialEnd prefers the live trial date over the preserved one", (() => {
  const live = new Date("2026-09-12T09:00:00+07:00");
  const ended = new Date("2026-09-01T09:00:00+07:00");
  return effectiveTrialEnd({ trialEndsAt: live, trialEndedAt: ended })?.getTime() === live.getTime()
    && effectiveTrialEnd({ trialEndsAt: null, trialEndedAt: ended })?.getTime() === ended.getTime()
    && effectiveTrialEnd({ trialEndsAt: null, trialEndedAt: null }) === null;
})());

check("every kind maps back from exactly one day offset", (() => {
  const offsets = TRIAL_REMINDER_KINDS.map((kind) => TRIAL_REMINDER_OFFSET_DAYS[kind]);
  return new Set(offsets).size === offsets.length
    && TRIAL_REMINDER_KINDS.every((kind) => trialReminderKindFor(TRIAL_REMINDER_OFFSET_DAYS[kind]) === kind)
    && trialReminderKindFor(1) === null;
})());

// ── 2. Idempotency ───────────────────────────────────────────────────────────
console.log("\nidempotency");
check("a kind already logged is never re-sent", (() => {
  const d = decideTrialReminder(trialUser({ alreadySentKinds: ["d5"] }));
  return d.send === false && d.reason === "already_sent";
})());

check("an unrelated logged kind does not block today's kind", (() => {
  const d = decideTrialReminder(trialUser({ alreadySentKinds: ["expiry", "d3after"] }));
  return d.send === true && d.kind === "d5";
})());

// ── 3. Exclusions ────────────────────────────────────────────────────────────
console.log("\nexclusions");
check("a paid/coupon-entitled user is never nudged", (() => {
  const d = decideTrialReminder(trialUser({ paidEquivalent: true }));
  return d.send === false && d.reason === "paid_equivalent";
})());

check("a converted user (trial dates cleared) is never nudged", (() => {
  const d = decideTrialReminder(trialUser({ trialEndsAt: null, trialEndedAt: null }));
  return d.send === false && d.reason === "no_trial";
})());

check("a user who never trialed is never nudged", (() => {
  const d = decideTrialReminder(trialUser({ trialStartedAt: null }));
  return d.send === false && d.reason === "no_trial";
})());

check("internal/admin accounts are skipped", (() =>
  decideTrialReminder(trialUser({ isInternal: true })).send === false)());

check("suspended accounts are skipped", (() =>
  decideTrialReminder(trialUser({ suspended: true })).send === false)());

check("day+3 needs at least one completed export", (() => {
  const d = decideTrialReminder(trialUser({
    trialEndsAt: null,
    trialEndedAt: new Date("2026-09-07T09:00:00+07:00"),
    hasCompletedVideo: false,
  }));
  return d.send === false && d.reason === "no_completed_video";
})());

check("day 5 does NOT need a completed export", (() => {
  const d = decideTrialReminder(trialUser({ hasCompletedVideo: false }));
  return d.send === true && d.kind === "d5";
})());

// ── 4. renewal-reminders must not treat a trial as a renewal ─────────────────
console.log("\nrenewal-reminders exclusion");
const activeTrial = {
  trialStartedAt: new Date("2026-09-05T09:00:00+07:00"),
  trialEndsAt: new Date("2026-09-12T09:00:00+07:00"),
};
check("an active trial is excluded from renewal reminders",
  isTrialSourcedPlan({ ...activeTrial, paidEquivalent: false }) === true);
check("a trial user who also holds paid/coupon evidence still gets renewal reminders",
  isTrialSourcedPlan({ ...activeTrial, paidEquivalent: true }) === false);
check("an ex-trial user who later paid still gets renewal reminders",
  isTrialSourcedPlan({ trialStartedAt: activeTrial.trialStartedAt, trialEndsAt: null, paidEquivalent: false }) === false);
check("a never-trialed PromptPay customer still gets renewal reminders",
  isTrialSourcedPlan({ trialStartedAt: null, trialEndsAt: null, paidEquivalent: false }) === false);

const renewalRoute = readFileSync(resolve("src/app/api/cron/renewal-reminders/route.ts"), "utf8");
check("renewal-reminders route applies the trial exclusion",
  /isTrialSourcedPlan/.test(renewalRoute));
check("renewal-reminders route resolves entitlement instead of hand-rolling the cohort",
  /resolvePaidEquivalentEntitlement/.test(renewalRoute));

// ── 5. Copy is honest and matches the enforced limits ────────────────────────
console.log("\ncopy");
const FREE_DAYS = storageDaysForPlan("FREE");
check("FREE retention used by the copy is the plan-limits rule (3 days)", FREE_DAYS === 3);

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}]/u;
for (const kind of TRIAL_REMINDER_KINDS) {
  const copy = trialReminderCopy(kind, { clipCount: 4, minuteQuotaEnabled: true });
  check(`${kind}: copy has a title and body`, copy.title.length > 0 && copy.body.length > 0);
  check(`${kind}: copy carries no emoji`, !EMOJI.test(`${copy.title} ${copy.body}`));
  check(`${kind}: deep link carries the moment's source`,
    copy.link === `/pricing?source=${TRIAL_REMINDER_SOURCE[kind]}`
    && copy.link === trialReminderLink(kind)
    && TRIAL_REMINDER_SOURCE[kind].startsWith("trial_"));
  check(`${kind}: retention claim quotes the real FREE rule`,
    copy.body.includes(`${FREE_DAYS} วันต่อคลิป`));
  check(`${kind}: no blanket "everything is deleted N days after the trial" claim`,
    !/ถูกลบ.*หลังหมดทดลอง/.test(copy.body));
}

check("day 5 quotes the customer's real clip count", (() => {
  const withClips = trialReminderCopy("d5", { clipCount: 4, minuteQuotaEnabled: true });
  const noClips = trialReminderCopy("d5", { clipCount: 0, minuteQuotaEnabled: true });
  return withClips.body.includes("4 ชิ้น") && !noClips.body.includes("0 ชิ้น");
})());

check("expiry copy states the live FREE allowance for the active meter", (() => {
  const minutes = trialReminderCopy("expiry", { clipCount: 0, minuteQuotaEnabled: true });
  const clips = trialReminderCopy("expiry", { clipCount: 0, minuteQuotaEnabled: false });
  return minutes.body.includes(`${FREE_LIMITS.minutesPerMonth} นาที/เดือน`)
    && clips.body.includes(`${FREE_LIMITS.clips} คลิป/เดือน`)
    && freeAllowanceLabel(true) === `${FREE_LIMITS.minutesPerMonth} นาที/เดือน`
    && freeAllowanceLabel(false) === `${FREE_LIMITS.clips} คลิป/เดือน`;
})());

check("expiry copy names what turns off", (() => {
  const copy = trialReminderCopy("expiry", { clipCount: 0, minuteQuotaEnabled: true });
  return copy.body.includes("ปิดไว้")
    && !FREE_LIMITS.allowHeyGen && !FREE_LIMITS.allowElevenLabs
    && !FREE_LIMITS.allowMusic && !FREE_LIMITS.allowVideoEditor;
})());

// ── 5b. Notification deep links can only point back into the app ─────────────
console.log("\nnotification link safety");
for (const kind of TRIAL_REMINDER_KINDS) {
  check(`${kind}: link is accepted as same-origin`, isSafeNotificationLink(trialReminderLink(kind)));
}
for (const hostile of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", " /pricing", "pricing"]) {
  check(`link "${hostile}" is rejected`, !isSafeNotificationLink(hostile));
}
check("a null/undefined link is rejected",
  !isSafeNotificationLink(null) && !isSafeNotificationLink(undefined));

// ── 6. Cron wiring ───────────────────────────────────────────────────────────
console.log("\ncron wiring");
const cronRoute = readFileSync(resolve("src/app/api/cron/trial-reminders/route.ts"), "utf8");
check("trial-reminders route is CRON_SECRET gated with a timing-safe compare",
  /CRON_SECRET/.test(cronRoute) && /timingSafeStrEqual/.test(cronRoute));
check("trial-reminders route is a no-op unless TRIAL_REMINDERS=1",
  /trialRemindersEnabled/.test(cronRoute));

const serverModule = readFileSync(resolve("src/lib/trial-reminders.server.ts"), "utf8");
check("email delivery is behind TRIAL_REMINDERS_EMAIL",
  /TRIAL_REMINDERS_EMAIL/.test(serverModule));
check("the dedupe row is claimed before delivery",
  serverModule.indexOf("trialReminderLog.create") < serverModule.indexOf("createNotification({"));
check("both channels emit trial_reminder_sent",
  /channel: "notification"/.test(serverModule) && /channel: "email"/.test(serverModule));

const ecosystem = readFileSync(resolve("ecosystem.config.js"), "utf8");
check("PM2 runs trial-reminders daily at 10:00 as a one-shot cron", (() => {
  const block = ecosystem.slice(ecosystem.indexOf('name: "trial-reminders"'));
  return block.includes('cron_restart: "0 10 * * *"')
    && /autorestart: false/.test(block.slice(0, 400))
    && block.includes("scripts/trial-reminders.js");
})());

const schema = readFileSync(resolve("prisma/schema.prisma"), "utf8");
check("trialEndedAt is an additive nullable column", /trialEndedAt\s+DateTime\?/.test(schema));
check("TrialReminderLog is unique per (userId, kind)",
  /model TrialReminderLog/.test(schema) && /@@unique\(\[userId, kind\]\)/.test(schema));

const entitlements = readFileSync(resolve("src/lib/entitlements.ts"), "utf8");
check("entitlements revert preserves the trial end date",
  /trialEndedAt: user\.trialEndsAt/.test(entitlements));
check("entitlements revert emits trial_expired",
  /recordTrialExpiredTelemetry/.test(entitlements));
const trialLib = readFileSync(resolve("src/lib/trial.ts"), "utf8");
check("trial.ts revert preserves the trial end date and emits trial_expired",
  /trialEndedAt: u\.trialEndsAt/.test(trialLib) && /recordTrialExpiredTelemetry/.test(trialLib));

const telemetry = readFileSync(resolve("src/lib/trial-expired-telemetry.ts"), "utf8");
check("trial_expired carries hadFirstExport / exportsCount / minutesUsed",
  /hadFirstExport/.test(telemetry) && /exportsCount/.test(telemetry) && /minutesUsed/.test(telemetry));
check("trial_expired is deduped to one event per user",
  /recordTelemetryEventOnce/.test(telemetry));

const pricingClient = readFileSync(resolve("src/app/(dashboard)/pricing/pricing-client.tsx"), "utf8");
// After #343 the page emits one generic `pricing_viewed { source }` for every acquisition
// source, so the trial_* sources ride that event instead of a dedicated one.
check("/pricing attributes every source (incl. trial_*) via pricing_viewed",
  /trackEvent\("pricing_viewed"/.test(pricingClient) && /source/.test(pricingClient));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-trial-reminders: PASS");
