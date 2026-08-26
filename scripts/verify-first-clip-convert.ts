import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canRevealFirstClipConvertPrompt,
  decideFirstClipConvertPrompt,
  firstClipConvertCooldownActive,
  firstClipConvertTrialLine,
  trialDaysLeftFrom,
  firstClipConvertPathSuppressed,
  FIRST_CLIP_CONVERT_COOLDOWN_DAYS,
} from "../src/lib/first-clip-convert";
import { MONTHLY_GRANT } from "../src/lib/credit-costs";
import { minutesPerMonthForPlan, storageDaysForPlan } from "../src/lib/plan-limits";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const now = new Date("2026-08-26T09:00:00.000Z");
const founding = { active: true, remaining: 88, total: 100, percentOff: 50 };
const benefits = {
  storageDays: storageDaysForPlan("PRO"),
  minutesPerMonth: minutesPerMonthForPlan("PRO"),
  monthlyCredits: MONTHLY_GRANT.PRO ?? 0,
};

// ── The prices and promises on the card come from the shared helpers ─────────
const shown = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  isPaidEquivalent: false,
  hasCompletedVideo: true,
  dismissedAt: null,
  now,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("trial user with a completed video sees the prompt", shown.show === true);
if (shown.show) {
  check("monthly price is the primary number", shown.monthlyPriceThb === 599);
  check("Founding annual is 50% of 10-month list", shown.founding?.annualPriceThb === 2995);
  check("full annual list is never omitted but is not Founding", shown.annualListThb === 5990);
  check("Founding annual is quoted per month (the ฿250 the landing page promises)",
    shown.founding?.annualMonthlyThb === 250);
  check("list annual is quoted per month too", shown.annualMonthlyThb === 499);
  check("Founding seat counter carries the total", shown.founding?.total === 100);
  check("benefits come from plan-limits/credits, never hardcoded",
    shown.benefits.storageDays === 7
    && shown.benefits.minutesPerMonth === 80
    && shown.benefits.monthlyCredits === 50,
    JSON.stringify(shown.benefits));
}

// ── Exclusions ───────────────────────────────────────────────────────────────
const subscriber = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: true,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("recurring payer is suppressed", !subscriber.show && subscriber.reason === "recurring_payer");

for (const label of ["one-time/PromptPay annual", "bundle", "GRANT coupon", "administrator grant"]) {
  const paidEquivalent = decideFirstClipConvertPrompt({
    isInternal: false,
    isRecurringPayer: false,
    isPaidEquivalent: true,
    hasCompletedVideo: true,
    monthlyPriceThb: 599,
    benefits,
    founding,
  });
  check(`paid-equivalent (${label}) is suppressed`,
    !paidEquivalent.show && paidEquivalent.reason === "paid_equivalent");
}

const admin = decideFirstClipConvertPrompt({
  isInternal: true,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("internal/admin accounts are suppressed", !admin.show && admin.reason === "internal");

const noClip = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: false,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("no completed video is suppressed", !noClip.show && noClip.reason === "no_completed_video");

const soldOut = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  benefits,
  founding: { active: false, remaining: 0, total: 100, percentOff: 50 },
});
check(
  "exhausted Founding still shows prompt without Founding secondary",
  soldOut.show && soldOut.founding === null && soldOut.annualListThb === 5990,
);

// ── Dismissal cooldown (issue #303: no repeats) ──────────────────────────────
check("cooldown is 30 days", FIRST_CLIP_CONVERT_COOLDOWN_DAYS === 30);
check("no dismissal → no cooldown", firstClipConvertCooldownActive(null, now) === false);
check("dismissed 1 day ago → still cooling down",
  firstClipConvertCooldownActive(new Date(now.getTime() - DAY_MS), now) === true);
check("dismissed 29 days ago → still cooling down",
  firstClipConvertCooldownActive(new Date(now.getTime() - 29 * DAY_MS), now) === true);
check("dismissed 31 days ago → may ask again",
  firstClipConvertCooldownActive(new Date(now.getTime() - 31 * DAY_MS), now) === false);
check("a future (clock-skewed) dismissal still counts as recent",
  firstClipConvertCooldownActive(new Date(now.getTime() + DAY_MS), now) === true);

const dismissedRecently = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  dismissedAt: new Date(now.getTime() - 5 * DAY_MS),
  now,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("a dismissal inside the cooldown suppresses the prompt",
  !dismissedRecently.show && dismissedRecently.reason === "dismissed_cooldown");

const dismissedLongAgo = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  dismissedAt: new Date(now.getTime() - 40 * DAY_MS),
  now,
  monthlyPriceThb: 599,
  benefits,
  founding,
});
check("after the cooldown the prompt may be shown once more", dismissedLongAgo.show === true);

// ── Reveal rule: only after the export is on screen, never mid-render ────────
const revealBase = { decisionShown: true, exportedViewShown: true, renderActive: false, dismissed: false };
check("qualifying + exported view shown → reveal", canRevealFirstClipConvertPrompt(revealBase) === true);
check("burn-complete alone (no exported view yet) → no reveal",
  canRevealFirstClipConvertPrompt({ ...revealBase, exportedViewShown: false }) === false);
check("a render in flight never gets interrupted",
  canRevealFirstClipConvertPrompt({ ...revealBase, renderActive: true }) === false);
check("dismissed in this session → no reveal",
  canRevealFirstClipConvertPrompt({ ...revealBase, dismissed: true }) === false);
check("server says no → no reveal",
  canRevealFirstClipConvertPrompt({ ...revealBase, decisionShown: false }) === false);
check("the pricing page already carries the offer → no modal on top of it",
  canRevealFirstClipConvertPrompt({ ...revealBase, pathname: "/pricing" }) === false);
check("billing settings (where a payment lands) is suppressed too",
  firstClipConvertPathSuppressed("/settings") === true
  && firstClipConvertPathSuppressed("/settings/billing") === true);
check("ordinary surfaces are not suppressed",
  firstClipConvertPathSuppressed("/videos") === false
  && firstClipConvertPathSuppressed("/video-editor") === false
  && firstClipConvertPathSuppressed(null) === false);
check("reveal still works on the editor and the gallery",
  canRevealFirstClipConvertPrompt({ ...revealBase, pathname: "/video-editor" }) === true
  && canRevealFirstClipConvertPrompt({ ...revealBase, pathname: "/videos" }) === true);

// ── Trial context line is honest about what conversion does ─────────────────
check("trial days left is derived from trialEndsAt",
  trialDaysLeftFrom(new Date(now.getTime() + 3 * DAY_MS), now) === 3
  && trialDaysLeftFrom(new Date(now.getTime() - DAY_MS), now) === 0
  && trialDaysLeftFrom(null, now) === 0);
const trialLine = firstClipConvertTrialLine({ trialDaysLeft: 4, minutesLeft: 12 });
check("trial line states days and minutes left",
  trialLine.includes("4 วัน") && trialLine.includes("12 นาที"), trialLine);
check("trial line never claims the remaining trial days survive conversion",
  !trialLine.includes("ไม่เสียวันทดลอง"), trialLine);
const noTrialLine = firstClipConvertTrialLine({ trialDaysLeft: 0, minutesLeft: null });
check("no trial + no minute meter still yields a line", noTrialLine.length > 0, noTrialLine);

// ── Single mount (issue #303: the prompt was mounted twice) ─────────────────
const layout = readFileSync(resolve("src/components/layout/dashboard-layout.tsx"), "utf8");
const mounts = layout.match(/<FirstClipConvertPrompt\b/g) ?? [];
check("DashboardLayout mounts the prompt exactly once", mounts.length === 1,
  `found ${mounts.length} mount(s)`);

// ── Mobile safety for BOTH modals (issue #331) ─────────────────────────────
const MODALS = [
  "src/components/convert/first-clip-convert-prompt.tsx",
  "src/components/ui/upgrade-modal.tsx",
];
for (const file of MODALS) {
  const source = readFileSync(resolve(file), "utf8");
  check(`${file}: panel is height-capped`, source.includes("max-h-[90dvh]"));
  check(`${file}: panel scrolls its own overflow`, source.includes("overflow-y-auto"));
  check(`${file}: honours the safe-area insets`, source.includes("env(safe-area-inset-bottom)"));
  check(`${file}: close button is a 44px target`, /h-11 w-11/.test(source));
  check(`${file}: close button is labelled`, source.includes('aria-label="ปิด"'));

  const buttons = source.match(/className="[^"]*"/g) ?? [];
  const ctaClasses = buttons.filter((c) => c.includes("w-full") && c.includes("rounded-xl"));
  check(`${file}: every full-width CTA is at least 44px tall`,
    ctaClasses.length > 0 && ctaClasses.every((c) => c.includes("min-h-11")),
    ctaClasses.filter((c) => !c.includes("min-h-11")).join("\n        "));

  // Body copy must not drop below 13px on a phone.
  check(`${file}: no 12px body copy left`, !/\btext-xs\b/.test(source),
    "text-xs is 12px — use text-[13px] or larger");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-first-clip-convert: PASS");
