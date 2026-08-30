import { decideFirstClipPath, requiresFirstClipScript } from "../src/lib/first-clip-path";

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
  "Conversion Trial with no completed video is on the path",
  decideFirstClipPath({
    isInternal: false,
    paidEquivalent: false,
    conversionTrial: true,
    hasCompletedVideo: false,
  }).reason === "conversion_trial",
);
check(
  "GRANT/paid users can upload their first clip",
  !requiresFirstClipScript({ onPath: true, reason: "on_path" }),
);
check(
  "Conversion Trial keeps the guided script-only first clip",
  requiresFirstClipScript({ onPath: true, reason: "conversion_trial" }),
);
check(
  "FREE with no trial stays off the path",
  decideFirstClipPath({ isInternal: false, paidEquivalent: false, hasCompletedVideo: false }).reason === "not_paid_equivalent",
);
check(
  "Conversion Trial leaves the path after the sample clip",
  decideFirstClipPath({
    isInternal: false,
    paidEquivalent: false,
    conversionTrial: true,
    hasCompletedVideo: true,
  }).reason === "has_completed_video",
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
