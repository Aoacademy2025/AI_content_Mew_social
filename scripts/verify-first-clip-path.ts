import { decideFirstClipPath } from "../src/lib/first-clip-path";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

check(
  "GRANT/paid with no completed video is on the path",
  decideFirstClipPath({ isInternal: false, paidEquivalent: true, hasCompletedVideo: false }).onPath,
);
check(
  "completed video leaves the path",
  decideFirstClipPath({ isInternal: false, paidEquivalent: true, hasCompletedVideo: true }).reason === "has_completed_video",
);
check(
  "Conversion Trial (not paid-equivalent) is not on this path",
  decideFirstClipPath({ isInternal: false, paidEquivalent: false, hasCompletedVideo: false }).reason === "not_paid_equivalent",
);
check(
  "internal/admin never enter First-Clip Path",
  decideFirstClipPath({ isInternal: true, paidEquivalent: true, hasCompletedVideo: false }).reason === "internal",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-first-clip-path: PASS");
