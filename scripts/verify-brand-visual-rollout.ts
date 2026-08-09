import assert from "node:assert/strict";

async function main() {
  const {
    brandVisualRolloutBucket,
    brandVisualRolloutFlags,
    decideBrandVisualAccess,
  } = await import("../src/lib/brand-visual-rollout.server");

  const createdAt = new Date("2026-08-10T00:00:00.000Z");
  const owner = { id: "owner", email: "duckyhero@gmail.com", role: "USER", createdAt };
  const admin = { id: "admin", email: "admin@example.test", role: "ADMIN", createdAt };
  const newcomer = { id: "new-user", email: "new@example.test", role: "USER", createdAt };
  const flags = {
    enabled: true,
    percent: 10 as const,
    startedAt: new Date("2026-08-09T00:00:00.000Z"),
    testEmails: new Set<string>(),
  };

  assert.equal(decideBrandVisualAccess(owner, { ...flags, enabled: false }).canUse, false, "master kill switch is fail-closed");
  assert.equal(decideBrandVisualAccess(owner, flags).cohort, "internal");
  assert.equal(decideBrandVisualAccess(admin, flags).cohort, "internal");
  assert.equal(
    decideBrandVisualAccess(
      { ...newcomer, email: "free-test@example.test" },
      { ...flags, testEmails: new Set(["free-test@example.test"]) },
    ).cohort,
    "internal",
  );

  const bucket = brandVisualRolloutBucket(newcomer.id);
  const access = decideBrandVisualAccess(newcomer, flags);
  assert.equal(access.canUse, bucket < 10);
  assert.equal(access.bucket, bucket);
  assert.equal(decideBrandVisualAccess({ ...newcomer, createdAt: new Date("2026-08-08T00:00:00Z") }, flags).canUse, false);
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
