import { bangkokCalendarDaysBetween, decideDay21ConvertReminder } from "../src/lib/day21-convert-reminder";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

const start = new Date("2026-08-19T15:30:00+07:00");
const day21Morning = new Date("2026-09-09T09:00:00+07:00");
const day20 = new Date("2026-09-08T09:00:00+07:00");
const day22 = new Date("2026-09-10T09:00:00+07:00");

check("Bangkok calendar day 21 is independent of redeem clock time", bangkokCalendarDaysBetween(start, day21Morning) === 21);
check("day 20 is not the convert reminder", bangkokCalendarDaysBetween(start, day20) === 20);

const due = decideDay21ConvertReminder({
  isInternal: false,
  isRecurringPayer: false,
  entitlementStartedAt: start,
  entitlementExpiresAt: new Date("2026-09-18T15:30:00+07:00"),
  now: day21Morning,
});
check("GRANT at day 21 is reminded", due.send === true);

check(
  "recurring payer is skipped",
  decideDay21ConvertReminder({
    isInternal: false,
    isRecurringPayer: true,
    entitlementStartedAt: start,
    entitlementExpiresAt: new Date("2026-09-18T15:30:00+07:00"),
    now: day21Morning,
  }).reason === "recurring_payer",
);
check(
  "internal/admin is skipped",
  decideDay21ConvertReminder({
    isInternal: true,
    isRecurringPayer: false,
    entitlementStartedAt: start,
    entitlementExpiresAt: new Date("2026-09-18T15:30:00+07:00"),
    now: day21Morning,
  }).reason === "internal",
);
check(
  "expired grant is skipped",
  decideDay21ConvertReminder({
    isInternal: false,
    isRecurringPayer: false,
    entitlementStartedAt: start,
    entitlementExpiresAt: new Date("2026-09-09T08:00:00+07:00"),
    now: day21Morning,
  }).reason === "expired",
);
check(
  "day 22 is not reminded again",
  decideDay21ConvertReminder({
    isInternal: false,
    isRecurringPayer: false,
    entitlementStartedAt: start,
    entitlementExpiresAt: new Date("2026-09-18T15:30:00+07:00"),
    now: day22,
  }).reason === "not_day_21",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-day21-convert-reminder: PASS");
