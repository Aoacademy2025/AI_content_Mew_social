import { decideFirstClipConvertPrompt } from "../src/lib/first-clip-convert";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const founding = { active: true, remaining: 88, percentOff: 50 };
const shown = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  founding,
});
check("GRANT/trial with a completed video sees the prompt", shown.show === true);
if (shown.show) {
  check("monthly price is the primary number", shown.monthlyPriceThb === 599);
  check("Founding annual is 50% of 10-month list", shown.founding?.annualPriceThb === 2995);
  check("full annual list is never omitted but is not Founding", shown.annualListThb === 5990);
}

const subscriber = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: true,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  founding,
});
check("recurring payer is suppressed", subscriber.show === false && !subscriber.show && subscriber.reason === "recurring_payer");

const admin = decideFirstClipConvertPrompt({
  isInternal: true,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  founding,
});
check("internal/admin accounts are suppressed", admin.show === false && !admin.show && admin.reason === "internal");

const noClip = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: false,
  monthlyPriceThb: 599,
  founding,
});
check("no completed video is suppressed", noClip.show === false && !noClip.show && noClip.reason === "no_completed_video");

const soldOut = decideFirstClipConvertPrompt({
  isInternal: false,
  isRecurringPayer: false,
  hasCompletedVideo: true,
  monthlyPriceThb: 599,
  founding: { active: false, remaining: 0, percentOff: 50 },
});
check(
  "exhausted Founding still shows prompt without Founding secondary",
  soldOut.show === true && soldOut.show && soldOut.founding === null && soldOut.annualListThb === 5990,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-first-clip-convert: PASS");
