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
  const pinAdmissionModule = await import("../src/lib/brand-visual-pin-admission.server");
  const {
    brandVisualPinAdmissionFields,
    hasAdmittedPersistedPin,
    pinAdmissionFromDecision,
    resolveOwnerPinAdmission,
  } = pinAdmissionModule;
  // M3: a helper that writes the stamp DECOUPLED from a pin statement is the
  // exact coupling the rest of this design enforces — pin and stamp commit
  // together or not at all. There must be no such writer to reach for.
  assert.ok(
    !("recordBrandVisualPinAdmission" in pinAdmissionModule),
    "M3: no stamp writer may exist outside a pin's own statement",
  );
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
  // Wave 1b Task 2: the stamp can only ever name a cohort that actually admits
  // somebody. The synthetic `existing-pin` cohort is the grandfather clause's
  // OUTPUT, never an input — stamping it would let one pin mint the next one.
  assert.equal(
    pinAdmissionFromDecision(
      { canUse: true, cohort: "existing-pin" } as unknown as Parameters<typeof pinAdmissionFromDecision>[0],
      admittedAt,
    ),
    null,
    "the synthetic existing-pin cohort is never written onto a pin",
  );
  for (const cohort of ["internal", "treatment-10", "treatment-50", "treatment-100"] as const) {
    assert.deepEqual(
      pinAdmissionFromDecision({ canUse: true, cohort }, admittedAt),
      { cohort, at: admittedAt },
      `${cohort} is an admitted cohort and is stamped verbatim`,
    );
  }

  // ── 2. The predicate needs BOTH a real pin and a real stamp ───────────────
  const pinFields = {
    projectLookJson: null,
    brandProfileRevisionId: "rev_1",
    treatmentPresetId: null,
    treatmentPresetVersion: null,
    brandVisualPinAdmittedAt: admittedAt,
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
  // Wave 1b Task 2: BOTH stamp columns are required. A half-written stamp (one
  // column set by a partial/legacy write) must not admit anything.
  assert.equal(
    hasAdmittedPersistedPin({
      ...pinFields,
      brandVisualPinAdmittedAt: null,
      brandVisualPinAdmittedCohort: "treatment-100",
    }),
    false,
    "a cohort without an admission timestamp is not a complete stamp",
  );
  assert.equal(
    hasAdmittedPersistedPin({ ...pinFields, brandVisualPinAdmittedCohort: "existing-pin" }),
    false,
    "a stamp naming the synthetic cohort admits nothing",
  );
  assert.equal(
    hasAdmittedPersistedPin({
      projectLookJson: null,
      brandProfileRevisionId: null,
      treatmentPresetId: null,
      treatmentPresetVersion: null,
      brandVisualPinAdmittedCohort: "internal",
      brandVisualPinAdmittedAt: admittedAt,
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

  // ── 5. Backfill (D3): stamp a legacy pin only when the OWNER can use images ─
  const {
    backfillBrandVisualPinAdmission,
    backfillDivergenceWarning,
    backfillFlagLine,
    modeFromArgs,
  } = await import("../scripts/backfill-brand-visual-pin-admission");
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

  // ── 5a. M4: the counts must be readable, not merely printed ───────────────
  // Run outside the app's env (CLAUDE.md's PM2 `env:` shadowing hazard) every
  // owner resolves `feature_off` and the report reads `eligible: 0` — safe, but
  // indistinguishable from "nobody qualifies". D3's go/no-go depends on
  // trusting these numbers, so the run states the flags it actually resolved.
  setRollout("100");
  process.env.BRAND_VISUAL_TEST_EMAILS = "ops-one@example.test,ops-two@example.test";
  const flagLine = backfillFlagLine();
  assert.match(flagLine, /BRAND_VISUAL_SYSTEM_ENABLED=1/, "the report states the master switch it resolved");
  assert.match(flagLine, /BRAND_VISUAL_ROLLOUT_PERCENT=100/, "the report states the rollout percent it resolved");
  assert.match(flagLine, /BRAND_VISUAL_TEST_EMAILS=2/, "the report states HOW MANY test emails, as a count");
  assert.doesNotMatch(
    flagLine,
    /@/u,
    "the report must never print a customer's email address, only how many are listed",
  );
  delete process.env.BRAND_VISUAL_SYSTEM_ENABLED;
  assert.match(
    backfillFlagLine(),
    /BRAND_VISUAL_SYSTEM_ENABLED=0/,
    "an absent master switch is reported as off, so `eligible: 0` cannot be mistaken for a real answer",
  );

  // …and a run that stamped fewer pins than it found eligible has hit a race or
  // a permission problem, so it must SAY so instead of reporting a tidy number.
  assert.equal(
    backfillDivergenceWarning("apply", { scanned: 9, owners: 3, eligible: 4, stamped: 4, skipped: 5 }),
    null,
    "a complete apply run warns about nothing",
  );
  assert.equal(
    backfillDivergenceWarning("dry-run", { scanned: 9, owners: 3, eligible: 4, stamped: 0, skipped: 5 }),
    null,
    "a dry run writes nothing by design and must not cry wolf",
  );
  const divergence = backfillDivergenceWarning(
    "apply",
    { scanned: 9, owners: 3, eligible: 4, stamped: 2, skipped: 5 },
  );
  assert.ok(divergence, "an apply run that stamped fewer pins than it found eligible must warn");
  assert.match(divergence, /2/, "the warning names how many were stamped");
  assert.match(divergence, /4/, "the warning names how many were eligible");
  // Restore the matrix the rest of this script runs under: percent 0 keeps
  // every non-internal account OUT of the image cohort.
  setRollout("0");

  // ── 5b. Render-time materialization stamps EXPLICITLY (wave 1b Task 2, R5) ─
  // Opening the pin to every plan means the render path itself now writes pin
  // columns for accounts the image gate rejects (`prepareProjectVisualPin`
  // materializes a treatment pin, `pinProjectVisualContextToVideoJob`
  // materializes an upload Project Look). Each of those writes must set the
  // stamp in the SAME statement — from the job's LIVE access, otherwise from
  // an already-admitted pin, otherwise null — so a render can never mint an
  // admission and an ORPHAN stamp can never be recombined with a fresh pin.
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");
  const { prepareProjectVisualPin, prepareUploadProjectVisualSnapshot, pinProjectVisualContextToVideoJob } =
    await import("../src/lib/project-look.server");
  const { createVideoJob } = await import("../src/lib/mcp/video-job");

  async function readyProject(ownerId: string, title: string) {
    const project = await prisma.editorProject.create({ data: { userId: ownerId, title } });
    const preflight = await prisma.contentPreflight.create({
      data: {
        userId: ownerId,
        projectId: project.id,
        narrativeSourceKind: "creator-script",
        sourceHash: `${title}-hash`,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
        contentDomain: "creator education",
        dominantNarrativeMode: "explainer",
        suggestedVisualFormatId: "clear-infographic",
        suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "warm" }),
        suggestedTreatmentPresetId: "expert-clarity",
        suggestedTreatmentPresetVersion: "v1.0.0",
        rankedTreatmentPresetIdsJson: JSON.stringify(["expert-clarity"]),
        treatmentRecommendationRationale: "A direct explainer.",
        storyEntitiesJson: JSON.stringify([]),
        visualBeats: {
          create: {
            userId: ownerId,
            projectId: project.id,
            beatKey: "window-0",
            sequence: 0,
            sourceExcerptHash: `${title}-beat`,
            beatJson: JSON.stringify({
              beatKey: "window-0",
              sourceExcerpt: "สอนทำคลิป",
              subject: "a creator",
              action: "teaches",
              setting: "a studio",
              emotion: "warm",
              emphasis: "the lesson",
              hardSceneFacts: {
                entityTypes: ["creator"], ages: [], genders: [], actions: ["teaches"],
                locationTypes: ["studio"], timeOfDay: null, historicalPeriod: null,
                count: 1, essentialObjects: [],
              },
              entityRefs: [],
              sceneIntensity: "balanced",
              safetyBoundary: "none",
            }),
          },
        },
      },
    });
    return { project, preflight };
  }

  const stampedByRender = await readyProject(admitted.id, "render materialization admitted");
  await prepareProjectVisualPin({
    userId: admitted.id,
    projectId: stampedByRender.project.id,
    preflightId: stampedByRender.preflight.id,
  });
  const stampedByRenderRow = await prisma.editorProject.findUniqueOrThrow({
    where: { id: stampedByRender.project.id },
  });
  assert.equal(stampedByRenderRow.treatmentPresetId, "expert-clarity", "the render materialized a treatment pin");
  assert.equal(
    stampedByRenderRow.brandVisualPinAdmittedCohort,
    "internal",
    "a render-time pin write stamps the job's LIVE image decision",
  );
  assert.ok(stampedByRenderRow.brandVisualPinAdmittedAt instanceof Date);

  const unstampedByRender = await readyProject(denied.id, "render materialization rollout-wait");
  await prepareProjectVisualPin({
    userId: denied.id,
    projectId: unstampedByRender.project.id,
    preflightId: unstampedByRender.preflight.id,
  });
  const unstampedByRenderRow = await prisma.editorProject.findUniqueOrThrow({
    where: { id: unstampedByRender.project.id },
  });
  assert.equal(unstampedByRenderRow.treatmentPresetId, "expert-clarity", "the pack/treatment pin is still materialized");
  assert.equal(
    unstampedByRenderRow.brandVisualPinAdmittedCohort,
    null,
    "a rollout-waiting owner's render mints NO admission",
  );
  assert.equal(unstampedByRenderRow.brandVisualPinAdmittedAt, null);

  // An ORPHAN stamp (e.g. left by BrandProfileRevision onDelete: SetNull) must
  // not be recombined with a pin the render materializes afterwards.
  const orphan = await readyProject(denied.id, "orphan stamp");
  await prisma.editorProject.update({
    where: { id: orphan.project.id },
    data: {
      brandVisualPinAdmittedCohort: "treatment-100",
      brandVisualPinAdmittedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  });
  await prepareProjectVisualPin({
    userId: denied.id,
    projectId: orphan.project.id,
    preflightId: orphan.preflight.id,
  });
  const orphanRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: orphan.project.id } });
  assert.equal(
    orphanRow.brandVisualPinAdmittedCohort,
    null,
    "an orphan stamp is cleared by the render write instead of adopting the fresh pin",
  );
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: denied.id, projectId: orphan.project.id }),
    false,
    "the orphan stamp cannot be resurrected into a grandfather clause",
  );

  // An ALREADY-ADMITTED pin keeps its original stamp when the render
  // re-materializes it after the owner lost live access (the existing-pin path).
  const grandfathered = await readyProject(denied.id, "already admitted pin");
  const grandfatheredAt = new Date("2026-08-02T00:00:00.000Z");
  await prisma.editorProject.update({
    where: { id: grandfathered.project.id },
    data: {
      projectLookJson: JSON.stringify({
        schemaVersion: 2,
        visualFormatId: "clear-infographic",
        recipeVersion: "clear-infographic-v2",
        treatment: "ชัดเจนแบบผู้เชี่ยวชาญ",
        treatmentPin: { presetId: "expert-clarity", version: "v1.0.0", source: "explicit" },
        brandVisualLanguage: null,
      }),
      projectLookUpdatedAt: grandfatheredAt,
      treatmentPresetId: "expert-clarity",
      treatmentPresetVersion: "v1.0.0",
      treatmentPinSource: "explicit",
      treatmentPinnedAt: grandfatheredAt,
      brandVisualPinAdmittedCohort: "treatment-100",
      brandVisualPinAdmittedAt: grandfatheredAt,
    },
  });
  await prepareProjectVisualPin({
    userId: denied.id,
    projectId: grandfathered.project.id,
    preflightId: grandfathered.preflight.id,
  });
  const grandfatheredRow = await prisma.editorProject.findUniqueOrThrow({
    where: { id: grandfathered.project.id },
  });
  assert.equal(
    grandfatheredRow.brandVisualPinAdmittedCohort,
    "treatment-100",
    "an already-admitted pin keeps the cohort it was admitted under",
  );
  assert.equal(
    grandfatheredRow.brandVisualPinAdmittedAt?.toISOString(),
    grandfatheredAt.toISOString(),
    "…and its original admission time, never a fresh one minted by the render",
  );

  // The upload path materializes a Project Look inside the job transaction.
  for (const owner of [
    { id: admitted.id, label: "admitted", cohort: "internal" as string | null },
    { id: denied.id, label: "rollout-wait", cohort: null },
  ]) {
    const upload = await readyProject(owner.id, `upload materialization ${owner.label}`);
    await prisma.editorProject.update({
      where: { id: upload.project.id },
      data: {
        projectLookJson: JSON.stringify({
          schemaVersion: 1,
          state: "awaiting-upload-preflight",
          selection: "project-look",
          narrativeSourceKind: "upload-transcript",
          visualFormatId: "clear-infographic",
          recipeVersion: "clear-infographic-v2",
          brandVisualLanguage: null,
        }),
      },
    });
    const uploadPin = await prepareUploadProjectVisualSnapshot({
      userId: owner.id,
      projectId: upload.project.id,
    });
    await prisma.editorProject.update({
      where: { id: upload.project.id },
      data: { projectLookJson: null, brandVisualPinAdmittedCohort: null, brandVisualPinAdmittedAt: null },
    });
    const uploadJob = await createVideoJob(
      owner.id,
      { clipUrl: "/uploads/clip.mp4" },
      `upload-materialization-${owner.label}`,
      { projectId: upload.project.id, projectVisualPin: uploadPin },
    );
    await pinProjectVisualContextToVideoJob({
      userId: owner.id,
      projectId: upload.project.id,
      videoJobId: uploadJob.id,
      preflightId: upload.preflight.id,
    });
    const uploadRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: upload.project.id } });
    assert.equal(
      uploadRow.treatmentPresetId,
      "expert-clarity",
      `${owner.label}: the upload render materializes the project's treatment pin`,
    );
    assert.equal(
      uploadRow.brandVisualPinAdmittedCohort,
      owner.cohort,
      `${owner.label}: the upload materialization stamps the owner's live image decision`,
    );
  }

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
