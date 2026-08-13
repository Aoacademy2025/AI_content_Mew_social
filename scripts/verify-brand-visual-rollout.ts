import assert from "node:assert/strict";

async function main() {
  const {
    brandVisualRolloutBucket,
    brandVisualRolloutFlags,
    decideBrandVisualAccess,
  } = await import("../src/lib/brand-visual-rollout.server");

  const owner = { id: "owner", email: "duckyhero@gmail.com", role: "USER" };
  const admin = { id: "admin", email: "admin@example.test", role: "ADMIN" };
  const newcomer = { id: "new-user", email: "new@example.test", role: "USER" };
  const paid = { canUsePaidFeatures: true, source: "subscription" as const };
  const unpaid = { canUsePaidFeatures: false, source: "none" as const };
  const flags = {
    enabled: true,
    percent: 10 as const,
    startedAt: new Date("2026-08-09T00:00:00.000Z"),
    testEmails: new Set<string>(),
  };

  assert.equal(decideBrandVisualAccess(owner, paid, { ...flags, enabled: false }).canUse, false, "master kill switch is fail-closed");
  assert.equal(decideBrandVisualAccess(owner, unpaid, flags).cohort, "internal");
  assert.equal(decideBrandVisualAccess(admin, unpaid, flags).cohort, "internal");
  assert.equal(
    decideBrandVisualAccess(
      { ...newcomer, email: "free-test@example.test" },
      unpaid,
      { ...flags, testEmails: new Set(["free-test@example.test"]) },
    ).cohort,
    "internal",
  );

  const bucket = brandVisualRolloutBucket(newcomer.id);
  const access = decideBrandVisualAccess(newcomer, paid, flags);
  assert.equal(access.canUse, bucket < 10);
  assert.equal(access.bucket, bucket);
  assert.equal(decideBrandVisualAccess(newcomer, unpaid, { ...flags, percent: 100 }).reason, "payment_required");
  assert.equal(decideBrandVisualAccess(newcomer, paid, { ...flags, percent: 0 }).reason, "rollout_wait");
  assert.equal(brandVisualRolloutBucket(newcomer.id), bucket, "cohort bucket is stable");

  assert.deepEqual(
    brandVisualRolloutFlags({
      BRAND_VISUAL_SYSTEM_ENABLED: "1",
      BRAND_VISUAL_ROLLOUT_PERCENT: "37",
      BRAND_VISUAL_ROLLOUT_STARTED_AT: "not-a-date",
    } as NodeJS.ProcessEnv),
    { enabled: true, percent: 0, startedAt: null, testEmails: new Set() },
    "unsupported percentage and invalid start date fail closed",
  );
  assert.equal(brandVisualRolloutFlags({ BRAND_VISUAL_ROLLOUT_PERCENT: "50" } as NodeJS.ProcessEnv).enabled, false);

  console.log("verify-brand-visual-rollout: PASS kill switch + stable staged cohorts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
