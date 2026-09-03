// Wave 1b Task 1 (#430): a persisted project pin is only a grandfather clause
// for managed AI images when the image decision recorded AT PIN TIME admitted
// the owner. Without that anchor, any writer that can persist a pin (including
// the two system writers outside the image guard) is a self-service ticket into
// the managed image route — exactly the hole ADR 0059's 2026-09-02 amendment
// tells wave 1 to close.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-visual-pin-admission-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

function setRollout(percent: "0" | "100") {
  process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
  process.env.BRAND_VISUAL_ROLLOUT_PERCENT = percent;
  process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT = "2026-08-10T00:00:00.000Z";
  process.env.BRAND_VISUAL_TEST_EMAILS = "";
}

const brandPayload = {
  schemaVersion: 1 as const,
  name: "Pin admission brand",
  niche: "creator education",
  audience: "Thai creators",
  script: {
    styleId: null,
    tone: "direct and energetic",
    bannedWords: [],
    ctaStyle: "follow",
    language: "th",
    analysisNotes: "Short hook, direct explanation, one concrete CTA",
    sampleText: "Creator writing sample retained for the next script",
  },
  voice: { provider: "gemini", voiceId: "kore" },
  subtitle: {
    presetId: null,
    config: { fontFamily: "Kanit", preset: "stroke", effect: "karaoke", accentColor: "#38BDF8" },
  },
  brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
  visual: {
    primaryVisualFormatId: "simple-editorial-story" as const,
    palette: ["#111111", "#F8F5EE", "#38BDF8"],
    personality: "bold raw energetic",
    peopleAndSetting: "Thai creator contexts",
    memorableCues: ["blue marker circle"],
    visualNotes: "thick imperfect marker lines",
    defaultTreatment: "clear and energetic",
  },
};

const deniedLiveAccess = {
  canUse: false as const,
  cohort: "rollout-wait" as const,
  mode: "rollout_wait" as const,
  reason: "rollout_wait" as const,
  bucket: 42,
  entitlementSource: "subscription" as const,
};
const admittedLiveAccess = {
  canUse: true as const,
  cohort: "treatment-100" as const,
  mode: "paid" as const,
  reason: "eligible" as const,
  bucket: 42,
  entitlementSource: "subscription" as const,
};

async function main() {
  setRollout("0");
  const { prisma } = await import("../src/lib/prisma");
  const {
    brandVisualPinAdmissionFields,
    hasAdmittedPersistedPin,
    pinAdmissionFromDecision,
    recordBrandVisualPinAdmission,
    resolveOwnerPinAdmission,
  } = await import("../src/lib/brand-visual-pin-admission.server");
  const { resolveBrandVisualRenderAccess } = await import("../src/lib/brand-visual-job-acceptance.server");
  const {
    applyProjectLook,
    clearProjectLook,
    projectHasAdmittedPersistedPin,
    projectHasPersistedVisualPin,
    saveUploadProjectVisualFormatAwaitingPreflight,
  } = await import("../src/lib/project-look.server");
  const { createBrandProfileFromPayload, pinProjectBrandRevision } = await import(
    "../src/lib/brand-profile-library.server"
  );

  // ── 1. The stamp IS the image decision taken at pin time ──────────────────
  const admittedAt = new Date("2026-09-03T04:05:06.000Z");
  assert.deepEqual(
    pinAdmissionFromDecision(admittedLiveAccess, admittedAt),
    { cohort: "treatment-100", at: admittedAt },
    "an admitted image decision stamps its own cohort onto the pin",
  );
  assert.equal(
    pinAdmissionFromDecision(deniedLiveAccess, admittedAt),
    null,
    "a rollout-waiting owner writes NO admission, so the pin grants nothing",
  );
  assert.deepEqual(
    brandVisualPinAdmissionFields(null),
    { brandVisualPinAdmittedCohort: null, brandVisualPinAdmittedAt: null },
    "a denied decision clears both stamp columns rather than leaving a stale one",
  );

  // ── 2. The predicate needs BOTH a real pin and a real stamp ───────────────
  const pinFields = {
    projectLookJson: null,
    brandProfileRevisionId: "rev_1",
    treatmentPresetId: null,
    treatmentPresetVersion: null,
  };
  assert.equal(
    hasAdmittedPersistedPin({ ...pinFields, brandVisualPinAdmittedCohort: "treatment-100" }),
    true,
  );
  assert.equal(
    hasAdmittedPersistedPin({ ...pinFields, brandVisualPinAdmittedCohort: null }),
    false,
    "a pin written without an admission is not a grandfather clause",
  );
  assert.equal(
    hasAdmittedPersistedPin({
      projectLookJson: null,
      brandProfileRevisionId: null,
      treatmentPresetId: null,
      treatmentPresetVersion: null,
      brandVisualPinAdmittedCohort: "internal",
    }),
    false,
    "a stamp left behind by a cleared pin admits nothing on its own",
  );

  // ── 3. The grandfather clause is anchored to the stamp ────────────────────
  assert.deepEqual(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasAdmittedPersistedPin: true,
      liveAccess: deniedLiveAccess,
    }),
    { canUse: true, cohort: "existing-pin", bucket: null },
    "an ADMITTED pin still rerenders after a downgrade or a rollout rollback",
  );
  assert.equal(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasAdmittedPersistedPin: false,
      liveAccess: deniedLiveAccess,
    }),
    null,
    "a pin written by a denied owner cannot admit that owner to managed AI images",
  );
  assert.deepEqual(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasAdmittedPersistedPin: true,
      liveAccess: admittedLiveAccess,
    }),
    admittedLiveAccess,
    "live access still outranks the synthetic existing-pin cohort",
  );
  assert.equal(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: false,
      hasAdmittedPersistedPin: true,
      liveAccess: admittedLiveAccess,
    }),
    null,
    "a Stock render never mints an acceptance merely because the project is admitted",
  );

  // ── 4. Every writer stamps the owner's live decision ──────────────────────
  const denied = await prisma.user.create({
    data: {
      name: "Rollout waiting owner",
      email: "pin-admission-wait@example.test",
      plan: "PRO",
      subStatus: "active",
      stripeSubscriptionId: "sub_pin_admission",
      planExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.payment.create({
    data: {
      userId: denied.id,
      stripeSessionId: "cs_pin_admission",
      plan: "PRO",
      amount: 9900,
      status: "PAID",
      periodDays: 30,
      paidAt: new Date(),
    },
  });
  const admitted = await prisma.user.create({
    data: { name: "Internal owner", email: "pin-admission-internal@example.test", plan: "FREE", role: "ADMIN" },
  });

  const deniedDecision = await resolveOwnerPinAdmission(denied.id);
  assert.equal(deniedDecision, null, "a paid but rollout-waiting owner resolves to NO admission");
  const admittedDecision = await resolveOwnerPinAdmission(admitted.id);
  assert.equal(admittedDecision?.cohort, "internal", "an internal owner resolves to the internal cohort");
  assert.equal(
    await resolveOwnerPinAdmission("missing-user-id"),
    null,
    "an unknown owner fails closed instead of admitting the pin",
  );

  const look = { visualFormatId: "dramatic-comic" as const, treatmentPresetId: "thai-human-drama" as const };
  const deniedProject = await prisma.editorProject.create({
    data: { userId: denied.id, title: "Look pinned while rollout-waiting" },
  });
  await applyProjectLook({
    userId: denied.id,
    projectId: deniedProject.id,
    look,
    admission: deniedDecision,
  });
  const deniedRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: deniedProject.id } });
  assert.ok(deniedRow.projectLookJson, "the Project Look is still persisted for a denied owner");
  assert.equal(deniedRow.brandVisualPinAdmittedCohort, null, "…but it carries no admission");
  assert.equal(deniedRow.brandVisualPinAdmittedAt, null);
  assert.equal(
    await projectHasPersistedVisualPin({ userId: denied.id, projectId: deniedProject.id }),
    true,
    "the persisted-pin predicate keeps its existing meaning for its other readers",
  );
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: denied.id, projectId: deniedProject.id }),
    false,
    "the render path sees an unadmitted pin",
  );

  const admittedProject = await prisma.editorProject.create({
    data: { userId: admitted.id, title: "Look pinned while admitted" },
  });
  await applyProjectLook({
    userId: admitted.id,
    projectId: admittedProject.id,
    look,
    admission: admittedDecision,
  });
  const admittedRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: admittedProject.id } });
  assert.equal(admittedRow.brandVisualPinAdmittedCohort, "internal");
  assert.ok(admittedRow.brandVisualPinAdmittedAt instanceof Date);
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: admitted.id, projectId: admittedProject.id }),
    true,
  );
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: denied.id, projectId: admittedProject.id }),
    false,
    "admission is ownership-scoped: another account's project never admits this caller",
  );
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: admitted.id, projectId: "missing-project-id" }),
    false,
    "a missing project fails closed instead of throwing into a 500",
  );

  // A re-pin RE-STAMPS: an owner who lost access cannot keep an old admission
  // alive by writing a new look over the admitted one.
  await applyProjectLook({
    userId: admitted.id,
    projectId: admittedProject.id,
    look: { visualFormatId: "clear-infographic", treatmentPresetId: "expert-clarity" },
    admission: null,
  });
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: admittedProject.id } }))
      .brandVisualPinAdmittedCohort,
    null,
    "re-pinning without a live admission drops the earlier stamp",
  );

  // Clearing a pin clears the stamp.
  await applyProjectLook({
    userId: admitted.id,
    projectId: admittedProject.id,
    look,
    admission: admittedDecision,
  });
  await clearProjectLook({ userId: admitted.id, projectId: admittedProject.id });
  const clearedRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: admittedProject.id } });
  assert.equal(clearedRow.projectLookJson, null);
  assert.equal(clearedRow.brandVisualPinAdmittedCohort, null, "clearing a pin clears its admission");
  assert.equal(clearedRow.brandVisualPinAdmittedAt, null);

  // The upload format pin is a pin too.
  const uploadProject = await prisma.editorProject.create({
    data: { userId: admitted.id, title: "Upload format pin" },
  });
  await saveUploadProjectVisualFormatAwaitingPreflight({
    userId: admitted.id,
    projectId: uploadProject.id,
    visualFormatId: "clear-infographic",
    admission: admittedDecision,
  });
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: uploadProject.id } }))
      .brandVisualPinAdmittedCohort,
    "internal",
    "the upload Step 2 format pin stamps the same admission as every other pin",
  );

  // The Brand Revision pin.
  const deniedProfile = await createBrandProfileFromPayload({
    userId: denied.id,
    payload: { ...brandPayload, name: "Denied owner brand" },
    source: "manual",
  });
  const revisionProject = await prisma.editorProject.create({
    data: { userId: denied.id, title: "Revision pinned while rollout-waiting" },
  });
  await pinProjectBrandRevision({
    userId: denied.id,
    projectId: revisionProject.id,
    profileId: deniedProfile.profile.id,
    revisionId: deniedProfile.revision.id,
    admission: deniedDecision,
  });
  const revisionRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: revisionProject.id } });
  assert.equal(revisionRow.brandProfileRevisionId, deniedProfile.revision.id, "the revision pin is persisted");
  assert.equal(revisionRow.brandVisualPinAdmittedCohort, null, "…without an admission for a denied owner");
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: denied.id, projectId: revisionProject.id }),
    false,
  );

  const admittedProfile = await createBrandProfileFromPayload({
    userId: admitted.id,
    payload: { ...brandPayload, name: "Internal owner brand" },
    source: "manual",
  });
  const admittedRevisionProject = await prisma.editorProject.create({
    data: { userId: admitted.id, title: "Revision pinned while admitted" },
  });
  await pinProjectBrandRevision({
    userId: admitted.id,
    projectId: admittedRevisionProject.id,
    profileId: admittedProfile.profile.id,
    revisionId: admittedProfile.revision.id,
    admission: admittedDecision,
  });
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: admittedRevisionProject.id } }))
      .brandVisualPinAdmittedCohort,
    "internal",
  );

  // A writer that forgets to pass an admission must fail CLOSED.
  const forgetfulProject = await prisma.editorProject.create({
    data: { userId: admitted.id, title: "Writer forgot the admission" },
  });
  await applyProjectLook({
    userId: admitted.id,
    projectId: forgetfulProject.id,
    look,
  } as Parameters<typeof applyProjectLook>[0]);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: forgetfulProject.id } }))
      .brandVisualPinAdmittedCohort,
    null,
    "an omitted admission never admits the pin",
  );

  // recordBrandVisualPinAdmission writes and clears both columns.
  await prisma.$transaction((tx) =>
    recordBrandVisualPinAdmission(tx, forgetfulProject.id, { cohort: "treatment-50", at: admittedAt }));
  const stamped = await prisma.editorProject.findUniqueOrThrow({ where: { id: forgetfulProject.id } });
  assert.equal(stamped.brandVisualPinAdmittedCohort, "treatment-50");
  assert.equal(stamped.brandVisualPinAdmittedAt?.toISOString(), admittedAt.toISOString());
  await prisma.$transaction((tx) => recordBrandVisualPinAdmission(tx, forgetfulProject.id, null));
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: forgetfulProject.id } }))
      .brandVisualPinAdmittedAt,
    null,
  );

  // ── 5. Backfill (D3): stamp a legacy pin only when the OWNER can use images ─
  const { backfillBrandVisualPinAdmission, modeFromArgs } = await import(
    "../scripts/backfill-brand-visual-pin-admission"
  );
  assert.equal(modeFromArgs([]), "dry-run", "the backfill defaults to dry-run");
  assert.equal(modeFromArgs(["--apply"]), "apply");
  assert.throws(() => modeFromArgs(["--apply", "--dry-run"]));
  assert.throws(() => modeFromArgs(["--force"]));

  // The already-stamped and unpinned projects must stay untouched.
  const unpinnedProject = await prisma.editorProject.create({
    data: { userId: admitted.id, title: "No pin at all" },
  });
  const alreadyStampedAt = new Date("2026-09-01T00:00:00.000Z");
  const alreadyStamped = await prisma.editorProject.create({
    data: {
      userId: admitted.id,
      title: "Already admitted",
      projectLookJson: "{}",
      brandVisualPinAdmittedCohort: "treatment-10",
      brandVisualPinAdmittedAt: alreadyStampedAt,
    },
  });

  const legacyPinnedForDenied = await prisma.editorProject.count({
    where: { userId: denied.id, brandVisualPinAdmittedCohort: null, NOT: { projectLookJson: null } },
  });
  assert.ok(legacyPinnedForDenied > 0, "the denied owner has at least one unstamped legacy pin to skip");

  const dryRun = await backfillBrandVisualPinAdmission("dry-run");
  assert.ok(dryRun.scanned >= 3, "the dry run scans every unstamped pin");
  assert.ok(dryRun.stamped === 0, "a dry run writes nothing");
  assert.ok(dryRun.eligible >= 1 && dryRun.skipped >= 1, "the dry run reports both outcomes");
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: forgetfulProject.id } }))
      .brandVisualPinAdmittedCohort,
    null,
    "a dry run leaves the database untouched",
  );

  const applied = await backfillBrandVisualPinAdmission("apply");
  assert.equal(applied.stamped, applied.eligible, "apply stamps exactly the eligible pins");
  assert.ok(applied.stamped >= 1);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: forgetfulProject.id } }))
      .brandVisualPinAdmittedCohort,
    "internal",
    "a legacy pin of an owner who can use images today is stamped with that current cohort",
  );
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: revisionProject.id } }))
      .brandVisualPinAdmittedCohort,
    null,
    "a legacy pin of an owner the image gate rejects today stays unadmitted (D3)",
  );
  const untouched = await prisma.editorProject.findUniqueOrThrow({ where: { id: alreadyStamped.id } });
  assert.equal(untouched.brandVisualPinAdmittedCohort, "treatment-10", "an existing stamp is never rewritten");
  assert.equal(untouched.brandVisualPinAdmittedAt?.toISOString(), alreadyStampedAt.toISOString());
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: unpinnedProject.id } }))
      .brandVisualPinAdmittedCohort,
    null,
    "a project with no pin is never stamped",
  );

  const secondApply = await backfillBrandVisualPinAdmission("apply");
  assert.equal(secondApply.stamped, 0, "the backfill is idempotent");

  // ── 6. Both render callers read the anchored value ────────────────────────
  const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.match(
    jobsRoute,
    /hasAdmittedPersistedPin/,
    "POST /api/videos/jobs must resolve the ADMITTED pin, not any pin",
  );
  const brollRoute = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
  assert.doesNotMatch(
    brollRoute,
    /hasAdmittedPersistedPin:\s*true/,
    "Scene Reroll must not hard-code an admission for the source job's project",
  );
  assert.match(
    brollRoute,
    /projectHasAdmittedPersistedPin/,
    "Scene Reroll must read the project's recorded admission",
  );

  await prisma.$disconnect();
  console.log("verify-brand-visual-pin-admission: PASS stamp + grandfather anchor + backfill");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
