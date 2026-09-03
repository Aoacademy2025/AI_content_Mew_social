import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const rolloutEnv = {
  BRAND_VISUAL_SYSTEM_ENABLED: "1",
  BRAND_VISUAL_ROLLOUT_PERCENT: "0",
  BRAND_VISUAL_ROLLOUT_STARTED_AT: "2026-08-10T00:00:00.000Z",
  BRAND_VISUAL_50_PERCENT_STARTED_AT: "",
  BRAND_VISUAL_TEST_EMAILS: "canary@example.com",
};
const priorRolloutEnv = Object.fromEntries(
  Object.keys(rolloutEnv).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, rolloutEnv);
const ecosystem = require("../ecosystem.config.js") as {
  apps?: Array<{ name?: string; env?: Record<string, unknown>; env_production?: Record<string, unknown> }>;
};
for (const [key, value] of Object.entries(priorRolloutEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

for (const processName of ["ai-content", "mcp-video-worker"]) {
  const processConfig = ecosystem.apps?.find((entry) => entry.name === processName);
  assert.ok(processConfig, `${processName} must exist in the PM2 ecosystem`);
  for (const [key, value] of Object.entries(rolloutEnv)) {
    assert.equal(
      processConfig.env?.[key],
      value,
      `${processName} must receive ${key} from the reviewed rollout environment`,
    );
    if (processName === "ai-content") {
      assert.equal(
        processConfig.env_production?.[key],
        value,
        `${processName} production overrides must preserve ${key}`,
      );
    }
  }
}

// Wave 1b (D1): pinning is a LIBRARY action for every plan. Task 1 anchored the
// `existing-pin` grandfather clause to the admission recorded ON the pin, so
// these writes no longer need the IMAGE guard — but each must still resolve the
// IMAGE decision separately and stamp from THAT. Stamping the library decision
// would admit everyone and reopen #430.
for (const pinWritingRoute of [
  "src/app/api/editor-projects/[id]/brand-revision/route.ts",
  "src/app/api/editor-projects/[id]/visual-context/route.ts",
  "src/app/api/brand-library/from-project-look/route.ts",
]) {
  const source = readFileSync(pinWritingRoute, "utf8");
  assert.match(source, /requireBrandLibraryUser/, `${pinWritingRoute} must pin on the library guard`);
  assert.match(
    source,
    /const imageAccess = await resolveBrandVisualAccess\(auth\.user\)/,
    `${pinWritingRoute} must resolve the AI-image decision itself`,
  );
  assert.match(
    source,
    /pinAdmissionFromDecision\(imageAccess\)/,
    `${pinWritingRoute} must stamp the IMAGE decision, never the library one`,
  );
  assert.doesNotMatch(
    source,
    /pinAdmissionFromDecision\(auth\.access\)/,
    `${pinWritingRoute} must not stamp the guard's own decision after the guard split`,
  );
}

const watchdog = readFileSync("scripts/ops-watchdog.sh", "utf8");
const localMonitor = readFileSync("scripts/local-prod-monitor.sh", "utf8");
const reconcileScript = readFileSync("scripts/reconcile-ai-images.js", "utf8");

assert.match(watchdog, /reconcile-ai-images:900/, "money reconciliation heartbeat must be monitored");
assert.match(
  localMonitor,
  /CRON=\{[^\n]*\\"reconcile-ai-images\\"/,
  "a scheduled reconciliation process may be stopped between PM2 cron runs",
);
assert.match(
  reconcileScript,
  /statusCode\s*>=\s*200[\s\S]*statusCode\s*<\s*300/,
  "cron wrapper must accept only a successful 2xx response",
);

async function wrapperExitFor(statusCode: number): Promise<number | null> {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ statusCode }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, ["scripts/reconcile-ai-images.js"], {
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${address.port}`,
      CRON_SECRET: "ops-test-secret",
    },
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return exitCode;
}

// ── ADR 0059 guard matrix ────────────────────────────────────────────────────
// The Brand Library is open to every authenticated, non-suspended account while
// the master switch is on; the paid-equivalent and rollout gates stay on the
// AI-image actions. Proved against the real route handlers and a throwaway DB
// (no network): only the flag matrix and the acting user change between calls.
const routeDirectory = mkdtempSync(join(tmpdir(), "brand-visual-ops-routes-"));
process.env.DATABASE_URL = `file:${join(routeDirectory, "test.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "ignore", env: process.env });

// The routes authenticate through getCurrentUser(); Clerk itself needs a request
// context, so the identity lookup is stubbed while the AUTHORIZATION under test
// keeps reading the live user row (suspension included), exactly like production.
let actingUserId: string | null = null;
const clerkAuthModuleId = require.resolve("../src/lib/clerk-auth");
require.cache[clerkAuthModuleId] = {
  id: clerkAuthModuleId,
  filename: clerkAuthModuleId,
  loaded: true,
  exports: {
    getCurrentUser: async () => {
      if (!actingUserId) return null;
      const { prisma } = await import("../src/lib/prisma");
      return prisma.user.findUnique({ where: { id: actingUserId } });
    },
    requireUser: async () => {
      throw new Error("the Brand Library routes authenticate through getCurrentUser");
    },
  },
} as never;

const brandPayload = {
  schemaVersion: 1 as const,
  name: "Ops guard brand",
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

function setRolloutFlags(enabled: boolean) {
  if (enabled) process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
  else delete process.env.BRAND_VISUAL_SYSTEM_ENABLED;
  // percent 0 keeps every non-internal account OUT of the image cohort
  process.env.BRAND_VISUAL_ROLLOUT_PERCENT = "0";
  process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT = "2026-08-10T00:00:00.000Z";
  process.env.BRAND_VISUAL_TEST_EMAILS = "";
}

async function verifyLibraryAndImageGuards() {
  const { prisma } = await import("../src/lib/prisma");
  const library = await import("../src/app/api/brand-library/route");
  const previewQuote = await import("../src/app/api/brand-library/preview-quote/route");

  const user = await prisma.user.create({
    data: { name: "Unpaid library user", email: "ops-library@example.test", plan: "FREE" },
  });
  actingUserId = user.id;

  setRolloutFlags(true);
  const listed = await library.GET();
  assert.equal(listed.status, 200, "an unpaid, non-rollout account can read its own Brand Library");
  const listedBody = await listed.json() as {
    canCreate: boolean;
    imageAccess: { canUse: boolean; reason: string; upgradeUrl: string };
  };
  assert.equal(listedBody.imageAccess.canUse, false, "the image gate stays closed for an unpaid account");
  assert.equal(listedBody.imageAccess.upgradeUrl, "/pricing");
  assert.equal(listedBody.canCreate, true, "plan limits are the only cap on creating a Brand");

  const created = await library.POST(new Request("http://localhost/api/brand-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: brandPayload }),
  }));
  assert.equal(created.status, 201, "an unpaid account can create a Brand Profile");
  const { profileId } = await created.json() as { profileId: string };

  // …and (wave 1b, D1) it MAY now attach that profile to a project: the pin is
  // a library action for every plan. What it must NOT gain is the AI-image
  // grandfather clause, and Task 1's admission stamp is what withholds it.
  const brandRevision = await import("../src/app/api/editor-projects/[id]/brand-revision/route");
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Unpinned project" },
  });
  const pinAttempt = await brandRevision.PUT(
    new Request(`http://localhost/api/editor-projects/${project.id}/brand-revision`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId }),
    }),
    { params: Promise.resolve({ id: project.id }) },
  );
  assert.equal(pinAttempt.status, 200, "an unpaid account can pin a Brand Profile to its project");
  const afterPinAttempt = await prisma.editorProject.findUniqueOrThrow({
    where: { id: project.id },
    select: {
      brandProfileRevisionId: true,
      brandVisualPinAdmittedCohort: true,
      brandVisualPinAdmittedAt: true,
    },
  });
  assert.ok(afterPinAttempt.brandProfileRevisionId, "the pin itself is persisted");
  assert.equal(
    afterPinAttempt.brandVisualPinAdmittedCohort,
    null,
    "…carrying NO image admission for an account the image gate rejects",
  );
  assert.equal(afterPinAttempt.brandVisualPinAdmittedAt, null);

  // The two seams the escalation chained: with no ADMITTED pin, the render
  // acceptance returns no admission, which is what makes POST /api/videos/jobs
  // answer 403 on its Hero RunPod branch for this account.
  const { projectHasAdmittedPersistedPin, projectHasPersistedVisualPin } = await import(
    "../src/lib/project-look.server"
  );
  const { resolveBrandVisualRenderAccess } = await import("../src/lib/brand-visual-job-acceptance.server");
  const { resolveBrandVisualAccess } = await import("../src/lib/brand-visual-rollout.server");
  const liveUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const hasAdmittedPersistedPin = await projectHasAdmittedPersistedPin({ userId: user.id, projectId: project.id });
  assert.equal(hasAdmittedPersistedPin, false, "the unadmitted pin leaves no admitted visual pin");
  assert.equal(
    await projectHasPersistedVisualPin({ userId: user.id, projectId: project.id }),
    true,
    "…while the look itself is fully persisted for stock B-roll, subtitles and pacing",
  );
  const liveAccess = await resolveBrandVisualAccess(liveUser);
  assert.equal(liveAccess.canUse, false);
  assert.equal(
    resolveBrandVisualRenderAccess({ requestsBrandVisualImage: true, hasAdmittedPersistedPin, liveAccess }),
    null,
    "an unpaid account cannot reach the managed AI-image route through an existing-pin grandfather clause",
  );

  // ── The two SYSTEM pin writers (ADR 0059 amendment 2026-09-02, #430) ──────
  // Hero Script's send-to-editor and the First-Clip auto-spine sit OUTSIDE the
  // image guard by design (they are system-initiated, not creator-initiated),
  // so each can persist a pin for an account the image gate rejects. They must
  // therefore record that account's image decision on the pin they write —
  // otherwise the grandfather clause hands them the managed image route.
  const { sendScriptToEditor } = await import("../src/lib/hero-script.server");
  const { ensureFirstClipProjectSpine } = await import("../src/lib/first-clip-path.server");
  const { createBrandProfileFromPayload } = await import("../src/lib/brand-profile-library.server");

  // PRO unlocks the Video Editor (the send-to-editor precondition) while the
  // IMAGE gate stays closed: no paid-equivalent evidence, no rollout bucket.
  const systemWriterUser = await prisma.user.create({
    data: { name: "Gate-rejected editor user", email: "ops-system-writer@example.test", plan: "PRO" },
  });
  const systemWriterBrand = await createBrandProfileFromPayload({
    userId: systemWriterUser.id,
    payload: { ...brandPayload, name: "System writer brand" },
    source: "manual",
  });
  const rejectedLive = await resolveBrandVisualAccess(
    await prisma.user.findUniqueOrThrow({ where: { id: systemWriterUser.id } }),
  );
  assert.equal(rejectedLive.canUse, false, "the system-writer account is rejected by the image gate");

  const heroScriptRow = await prisma.script.create({
    data: {
      userId: systemWriterUser.id,
      brandProfileId: systemWriterBrand.profile.id,
      topic: "ทดสอบส่งสคริปต์ไปตัดต่อ",
      hookText: "เปิดเรื่อง",
      bodyText: "เนื้อหาหลัก",
      ctaText: "กดติดตาม",
    },
  });
  const handoff = await sendScriptToEditor(systemWriterUser.id, heroScriptRow.id);
  assert.equal(handoff.ok, true, "send-to-editor still works for a PRO account outside the image cohort");
  const handoffProjectId = handoff.ok ? handoff.projectId : "";
  const handoffProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: handoffProjectId } });
  assert.equal(
    handoffProject.brandProfileRevisionId,
    systemWriterBrand.revision.id,
    "the handoff still pins the Brand Revision it was asked to carry",
  );
  assert.equal(
    handoffProject.brandVisualPinAdmittedCohort,
    null,
    "Hero Script's system pin records NO admission for an account the image gate rejects",
  );
  assert.equal(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasAdmittedPersistedPin: await projectHasAdmittedPersistedPin({
        userId: systemWriterUser.id,
        projectId: handoffProjectId,
      }),
      liveAccess: rejectedLive,
    }),
    null,
    "send-to-editor cannot become a self-service ticket into managed AI images",
  );
  assert.equal(
    await projectHasPersistedVisualPin({ userId: systemWriterUser.id, projectId: handoffProjectId }),
    true,
    "the pin itself is still persisted — only its image admission is withheld",
  );

  const spineProject = await prisma.editorProject.create({
    data: { userId: systemWriterUser.id, title: "First clip spine" },
  });
  await ensureFirstClipProjectSpine({ userId: systemWriterUser.id, projectId: spineProject.id });
  const spineRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: spineProject.id } });
  assert.ok(spineRow.brandProfileRevisionId, "the First-Clip spine still pins a Brand Revision");
  assert.equal(
    spineRow.brandVisualPinAdmittedCohort,
    null,
    "the First-Clip auto-spine records NO admission for an account the image gate rejects",
  );
  assert.equal(
    await projectHasAdmittedPersistedPin({ userId: systemWriterUser.id, projectId: spineProject.id }),
    false,
    "the auto-spine pin is not an admission ticket either",
  );

  // The same two writers on an INTERNAL account stamp the cohort they resolved.
  const internalWriterUser = await prisma.user.create({
    data: {
      name: "Internal editor user",
      email: "ops-system-writer-internal@example.test",
      plan: "PRO",
      role: "ADMIN",
    },
  });
  const internalBrand = await createBrandProfileFromPayload({
    userId: internalWriterUser.id,
    payload: { ...brandPayload, name: "Internal writer brand" },
    source: "manual",
  });
  const internalScriptRow = await prisma.script.create({
    data: {
      userId: internalWriterUser.id,
      brandProfileId: internalBrand.profile.id,
      topic: "ทดสอบทีมงาน",
      hookText: "เปิดเรื่อง",
      bodyText: "เนื้อหาหลัก",
      ctaText: "กดติดตาม",
    },
  });
  const internalHandoff = await sendScriptToEditor(internalWriterUser.id, internalScriptRow.id);
  assert.equal(internalHandoff.ok, true);
  const internalProjectId = internalHandoff.ok ? internalHandoff.projectId : "";
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: internalProjectId } }))
      .brandVisualPinAdmittedCohort,
    "internal",
    "an admitted owner's system pin records the cohort that admitted it",
  );
  const internalSpineProject = await prisma.editorProject.create({
    data: { userId: internalWriterUser.id, title: "Internal first clip spine" },
  });
  await ensureFirstClipProjectSpine({
    userId: internalWriterUser.id,
    projectId: internalSpineProject.id,
  });
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: internalSpineProject.id } }))
      .brandVisualPinAdmittedCohort,
    "internal",
    "the First-Clip auto-spine stamps an admitted owner exactly like a creator route",
  );

  actingUserId = user.id;

  const quoted = await previewQuote.POST(new Request("http://localhost/api/brand-library/preview-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: brandPayload }),
  }));
  assert.equal(quoted.status, 403, "AI-image actions keep the paid gate");
  assert.equal((await quoted.json() as { code: string }).code, "PAYMENT_REQUIRED");

  // "สร้างแบรนด์จากค่าที่ใช้อยู่": the seed this route hands the client is copied verbatim
  // into a create request, so every defaults field must already satisfy the
  // creator-write caps. A long Writing Style instruction prompt used to seed a
  // 500-char tone, which the write schema then rejected with a 400.
  const { createBrandProfileSeedFromCurrentDefaults } = await import("../src/lib/brand-profile-seed");
  const { BRAND_PROFILE_CAPS } = await import("../src/lib/brand-profile-limits");
  const defaultsUser = await prisma.user.create({
    data: { name: "Defaults seed user", email: "ops-defaults@example.test", plan: "FREE" },
  });
  actingUserId = defaultsUser.id;
  await prisma.style.create({
    data: {
      userId: defaultsUser.id,
      name: "Long writing style",
      instructionPrompt: "ก".repeat(1_000),
      sampleText: "ข".repeat(5_000),
    },
  });
  const withDefaults = await library.GET();
  assert.equal(withDefaults.status, 200);
  const defaults = (await withDefaults.json() as {
    defaults: Parameters<typeof createBrandProfileSeedFromCurrentDefaults>[0];
  }).defaults;
  const seededDraft = createBrandProfileSeedFromCurrentDefaults(defaults);
  assert.ok(
    seededDraft.script.tone.length <= BRAND_PROFILE_CAPS.shortFieldChars
      && (seededDraft.script.analysisNotes ?? "").length <= BRAND_PROFILE_CAPS.longFieldChars
      && (seededDraft.script.sampleText ?? "").length <= BRAND_PROFILE_CAPS.longFieldChars,
    "the current-defaults seed stays inside the creator-write caps",
  );
  const seededCreate = await library.POST(new Request("http://localhost/api/brand-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { ...seededDraft, name: "Brand from current defaults" } }),
  }));
  assert.equal(
    seededCreate.status,
    201,
    "a Brand seeded from the account's current defaults saves without a length rejection",
  );
  actingUserId = user.id;

  setRolloutFlags(false);
  const lockedList = await library.GET();
  assert.equal(lockedList.status, 403, "the master kill switch still closes the library");
  assert.equal((await lockedList.json() as { code: string }).code, "BRAND_VISUAL_LOCKED");

  setRolloutFlags(true);
  actingUserId = null;
  const anonymous = await library.GET();
  assert.equal(anonymous.status, 401, "every Brand Library route still authenticates");

  actingUserId = user.id;
  await prisma.user.update({ where: { id: user.id }, data: { suspended: true } });
  const suspended = await library.GET();
  assert.equal(suspended.status, 403, "a suspended account is blocked everywhere");
  assert.equal((await suspended.json() as { code: string }).code, "ACCOUNT_SUSPENDED");

  await prisma.$disconnect();
}

/**
 * Wave 1b Task 2 — the gate SPLIT, proved against the real route handlers.
 *
 * D1: every plan (FREE included) and every rollout-waiting paid account may pin
 * a Brand Profile / choose a ชุดสไตล์ for a clip / promote a look, through all
 * three pin-writing routes. What none of them gains is the managed AI-image
 * grandfather clause: each pin carries the IMAGE decision resolved at pin time,
 * so an unadmitted pin renders stock only.
 */
async function verifyPinOpensToEveryPlan() {
  setRolloutFlags(true);
  const { prisma } = await import("../src/lib/prisma");
  const brandRevision = await import("../src/app/api/editor-projects/[id]/brand-revision/route");
  const visualContext = await import("../src/app/api/editor-projects/[id]/visual-context/route");
  const fromProjectLook = await import("../src/app/api/brand-library/from-project-look/route");
  const { createBrandProfileFromPayload } = await import("../src/lib/brand-profile-library.server");
  const { projectHasAdmittedPersistedPin } = await import("../src/lib/project-look.server");
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");

  let sequence = 0;
  async function makeUser(kind: "free" | "rollout-wait" | "internal") {
    sequence += 1;
    const email = `ops-pin-${kind}-${sequence}@example.test`;
    if (kind === "free") {
      return prisma.user.create({ data: { name: email, email, plan: "FREE" } });
    }
    if (kind === "internal") {
      return prisma.user.create({ data: { name: email, email, plan: "PRO", role: "ADMIN" } });
    }
    // Paid-equivalent (so the IMAGE gate reaches the rollout bucket) but the
    // reviewed rollout percentage is 0, so the account is `rollout-wait`.
    const paid = await prisma.user.create({
      data: {
        name: email,
        email,
        plan: "PRO",
        subStatus: "active",
        stripeSubscriptionId: `sub_ops_pin_${sequence}`,
        planExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: paid.id,
        stripeSessionId: `cs_ops_pin_${sequence}`,
        plan: "PRO",
        amount: 9900,
        status: "PAID",
        periodDays: 30,
        paidAt: new Date(),
      },
    });
    return paid;
  }

  async function makePreflight(userId: string, projectId: string, tag: string) {
    return prisma.contentPreflight.create({
      data: {
        userId,
        projectId,
        narrativeSourceKind: "creator-script",
        sourceHash: `ops-pin-${tag}`,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
        contentDomain: "creator education",
        dominantNarrativeMode: "explainer",
        suggestedVisualFormatId: "clear-infographic",
        suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "warm" }),
        suggestedTreatmentPresetId: "expert-clarity",
        suggestedTreatmentPresetVersion: "v1.0.0",
      },
    });
  }

  const cases = [
    { kind: "free" as const, cohort: null },
    { kind: "rollout-wait" as const, cohort: null },
    { kind: "internal" as const, cohort: "internal" as string | null },
  ];

  for (const testCase of cases) {
    // ── Route 1: PUT /api/editor-projects/[id]/brand-revision ───────────────
    const revisionUser = await makeUser(testCase.kind);
    actingUserId = revisionUser.id;
    const revisionBrand = await createBrandProfileFromPayload({
      userId: revisionUser.id,
      payload: { ...brandPayload, name: `Pin brand ${testCase.kind}` },
      source: "manual",
    });
    const revisionProject = await prisma.editorProject.create({
      data: { userId: revisionUser.id, title: `brand-revision ${testCase.kind}` },
    });
    const pinned = await brandRevision.PUT(
      new Request(`http://localhost/api/editor-projects/${revisionProject.id}/brand-revision`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: revisionBrand.profile.id }),
      }),
      { params: Promise.resolve({ id: revisionProject.id }) },
    );
    assert.equal(pinned.status, 200, `${testCase.kind}: brand-revision pin is a library action`);
    const pinnedBody = await pinned.json() as {
      project: { hasPersistedVisualPin: boolean; hasAdmittedVisualPin: boolean };
    };
    assert.equal(pinnedBody.project.hasPersistedVisualPin, true);
    assert.equal(
      pinnedBody.project.hasAdmittedVisualPin,
      testCase.cohort !== null,
      `${testCase.kind}: the project response discloses AI-image admission separately from the pin`,
    );
    const revisionRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: revisionProject.id } });
    assert.equal(
      revisionRow.brandVisualPinAdmittedCohort,
      testCase.cohort,
      `${testCase.kind}: brand-revision stamps the IMAGE decision resolved at pin time`,
    );
    assert.equal(
      await projectHasAdmittedPersistedPin({ userId: revisionUser.id, projectId: revisionProject.id }),
      testCase.cohort !== null,
    );

    // ── Route 2: PUT /api/editor-projects/[id]/visual-context ───────────────
    const lookUser = await makeUser(testCase.kind);
    actingUserId = lookUser.id;
    const lookProject = await prisma.editorProject.create({
      data: { userId: lookUser.id, title: `visual-context ${testCase.kind}` },
    });
    const looked = await visualContext.PUT(
      new Request(`http://localhost/api/editor-projects/${lookProject.id}/visual-context`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ look: { stylePackId: "finance-clear" } }),
      }),
      { params: Promise.resolve({ id: lookProject.id }) },
    );
    assert.equal(looked.status, 200, `${testCase.kind}: choosing a ชุดสไตล์ for a clip is a library action`);
    const lookRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: lookProject.id } });
    assert.ok(lookRow.projectLookJson, `${testCase.kind}: the clip's look is persisted`);
    assert.equal(
      lookRow.brandVisualPinAdmittedCohort,
      testCase.cohort,
      `${testCase.kind}: visual-context stamps the IMAGE decision resolved at pin time`,
    );

    // ── Route 3: POST /api/brand-library/from-project-look ──────────────────
    const promoteUser = await makeUser(testCase.kind);
    actingUserId = promoteUser.id;
    const promoteProject = await prisma.editorProject.create({
      data: { userId: promoteUser.id, title: `from-project-look ${testCase.kind}` },
    });
    const promotePreflight = await makePreflight(promoteUser.id, promoteProject.id, `promote-${testCase.kind}-${sequence}`);
    const promoted = await fromProjectLook.POST(new Request("http://localhost/api/brand-library/from-project-look", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: promoteProject.id,
        preflightId: promotePreflight.id,
        // The promotion is deliberately exact: the payload's visual identity
        // must match the look the clip already carries (here, the preflight's
        // own suggestion), otherwise the library refuses with REVISION_CONFLICT.
        payload: {
          ...brandPayload,
          name: `Promoted ${testCase.kind}`,
          visual: {
            ...brandPayload.visual,
            languageMode: "none" as const,
            primaryVisualFormatId: "clear-infographic" as const,
            defaultTreatment: "clear, warm",
          },
        },
      }),
    }));
    assert.equal(promoted.status, 201, `${testCase.kind}: promoting a look to a Brand is a library action`);
    const promoteRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: promoteProject.id } });
    assert.ok(promoteRow.brandProfileRevisionId, `${testCase.kind}: the promotion pins its new Revision`);
    assert.equal(
      promoteRow.brandVisualPinAdmittedCohort,
      testCase.cohort,
      `${testCase.kind}: from-project-look stamps the IMAGE decision resolved at pin time`,
    );
  }

  await prisma.$disconnect();
}

/**
 * The GET side of the split: a library user reads its own visual context with or
 * without a pin, `hasAdmittedVisualPin` is the client's AI predicate (R7a), and
 * retained-AI-scene quoting stays on the ADMITTED predicate (R6).
 */
async function verifyVisualContextDisclosure() {
  setRolloutFlags(true);
  const { prisma } = await import("../src/lib/prisma");
  const visualContext = await import("../src/app/api/editor-projects/[id]/visual-context/route");

  const freeUser = await prisma.user.create({
    data: { name: "Disclosure free", email: "ops-disclosure-free@example.test", plan: "FREE" },
  });
  actingUserId = freeUser.id;
  const unpinned = await prisma.editorProject.create({
    data: { userId: freeUser.id, title: "No pin yet" },
  });
  const unpinnedRead = await visualContext.GET(
    new Request(`http://localhost/api/editor-projects/${unpinned.id}/visual-context`),
    { params: Promise.resolve({ id: unpinned.id }) },
  );
  assert.equal(unpinnedRead.status, 200, "a library user reads its visual context before it owns any pin");
  const unpinnedBody = await unpinnedRead.json() as {
    hasPersistedVisualPin: boolean;
    hasAdmittedVisualPin: boolean;
    reusableAiSceneIndices: number[];
  };
  assert.equal(unpinnedBody.hasPersistedVisualPin, false);
  assert.equal(unpinnedBody.hasAdmittedVisualPin, false);

  const pinned = await prisma.editorProject.create({
    data: { userId: freeUser.id, title: "Pinned, unadmitted" },
  });
  await visualContext.PUT(
    new Request(`http://localhost/api/editor-projects/${pinned.id}/visual-context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ look: { stylePackId: "thai-history" } }),
    }),
    { params: Promise.resolve({ id: pinned.id }) },
  );
  const pinnedRead = await visualContext.GET(
    new Request(`http://localhost/api/editor-projects/${pinned.id}/visual-context`),
    { params: Promise.resolve({ id: pinned.id }) },
  );
  assert.equal(pinnedRead.status, 200);
  const pinnedBody = await pinnedRead.json() as {
    hasPersistedVisualPin: boolean;
    hasAdmittedVisualPin: boolean;
    stylePack: { packId: string } | null;
  };
  assert.equal(pinnedBody.hasPersistedVisualPin, true, "the pack pin is visible to its owner");
  assert.equal(
    pinnedBody.hasAdmittedVisualPin,
    false,
    "…but the client is never told it may spend an AI image on it",
  );
  assert.equal(pinnedBody.stylePack?.packId, "thai-history", "the pinned pack is disclosed for stock B-roll");

  const internalUser = await prisma.user.create({
    data: { name: "Disclosure internal", email: "ops-disclosure-internal@example.test", plan: "PRO", role: "ADMIN" },
  });
  actingUserId = internalUser.id;
  const admittedProject = await prisma.editorProject.create({
    data: { userId: internalUser.id, title: "Pinned and admitted" },
  });
  await visualContext.PUT(
    new Request(`http://localhost/api/editor-projects/${admittedProject.id}/visual-context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ look: { stylePackId: "thai-history" } }),
    }),
    { params: Promise.resolve({ id: admittedProject.id }) },
  );
  const admittedRead = await visualContext.GET(
    new Request(`http://localhost/api/editor-projects/${admittedProject.id}/visual-context`),
    { params: Promise.resolve({ id: admittedProject.id }) },
  );
  assert.equal(
    (await admittedRead.json() as { hasAdmittedVisualPin: boolean }).hasAdmittedVisualPin,
    true,
    "an admitted owner's pin still discloses the AI capability",
  );

  // Rollback: the master switch closes the library, but an owner with a
  // persisted pin keeps reading its exact reuse state.
  actingUserId = freeUser.id;
  setRolloutFlags(false);
  const rolledBackPinned = await visualContext.GET(
    new Request(`http://localhost/api/editor-projects/${pinned.id}/visual-context`),
    { params: Promise.resolve({ id: pinned.id }) },
  );
  assert.equal(rolledBackPinned.status, 200, "a persisted pin stays readable through a master rollback");
  const rolledBackUnpinned = await visualContext.GET(
    new Request(`http://localhost/api/editor-projects/${unpinned.id}/visual-context`),
    { params: Promise.resolve({ id: unpinned.id }) },
  );
  assert.equal(rolledBackUnpinned.status, 403, "a rollback still closes the surface for an unpinned project");
  setRolloutFlags(true);

  await prisma.$disconnect();
}

/**
 * D2: Content Preflight RUNS for a non-admitted pinned render — one managed text
 * call per job, the same class as keyword extraction. A master rollback still
 * replays only the cache (`ANALYZER_UNAVAILABLE`), never a fresh analysis.
 */
async function verifyContentPreflightForPinnedLibraryUsers() {
  setRolloutFlags(true);
  const priorManagedGemini = process.env.MANAGED_GEMINI;
  // No managed key and no BYOK key: an analyzer that is CONSTRUCTED fails with
  // KEY_REQUIRED, so the two outcomes are distinguishable without a network call.
  delete process.env.MANAGED_GEMINI;
  const { prisma } = await import("../src/lib/prisma");
  const contentPreflight = await import("../src/app/api/editor-projects/[id]/content-preflight/route");
  const visualContext = await import("../src/app/api/editor-projects/[id]/visual-context/route");

  const user = await prisma.user.create({
    data: { name: "Preflight free", email: "ops-preflight-free@example.test", plan: "FREE" },
  });
  actingUserId = user.id;
  const pinnedProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Preflight pinned" },
  });
  await visualContext.PUT(
    new Request(`http://localhost/api/editor-projects/${pinnedProject.id}/visual-context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ look: { stylePackId: "news-fast" } }),
    }),
    { params: Promise.resolve({ id: pinnedProject.id }) },
  );

  const preflightRequest = (projectId: string) => new Request(
    `http://localhost/api/editor-projects/${projectId}/content-preflight`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        narrativeSource: { kind: "creator-script", text: "วันนี้เรามาคุยเรื่องการทำคลิปสั้นให้ปัง" },
      }),
    },
  );

  const ran = await contentPreflight.POST(preflightRequest(pinnedProject.id), {
    params: Promise.resolve({ id: pinnedProject.id }),
  });
  assert.equal(
    (await ran.json() as { code: string }).code,
    "KEY_REQUIRED",
    "D2: a pinned library user's Content Preflight actually runs its analyzer",
  );

  // Rollback replays the cache only.
  setRolloutFlags(false);
  const rolledBack = await contentPreflight.POST(preflightRequest(pinnedProject.id), {
    params: Promise.resolve({ id: pinnedProject.id }),
  });
  assert.equal(
    (await rolledBack.json() as { code: string }).code,
    "ANALYZER_UNAVAILABLE",
    "a master rollback replays a cached analysis but never starts a new one",
  );
  setRolloutFlags(true);

  // An account with neither image access nor a pin is unchanged.
  const unpinnedProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Preflight unpinned" },
  });
  const refused = await contentPreflight.POST(preflightRequest(unpinnedProject.id), {
    params: Promise.resolve({ id: unpinnedProject.id }),
  });
  assert.equal(refused.status, 403, "Content Preflight is not opened to projects with no pin at all");

  if (priorManagedGemini === undefined) delete process.env.MANAGED_GEMINI;
  else process.env.MANAGED_GEMINI = priorManagedGemini;
  await prisma.$disconnect();
}

/**
 * Job creation for a pinned project (ADR 0023 fail-open): every library user's
 * render carries the pinned visual context, so the pack's stock mood, subtitle
 * preset, pacing and music apply — while `brandVisualAcceptanceJson`, the
 * envelope `fetch-stock` demands before it will mint an image, stays null unless
 * the pin was ADMITTED. The explicit AI-source 403s are untouched (R7a).
 */
async function verifyPinnedJobCreation() {
  setRolloutFlags(true);
  const priorEnv = {
    MANAGED_GEMINI: process.env.MANAGED_GEMINI,
    GEMINI_SERVER_KEY: process.env.GEMINI_SERVER_KEY,
    MANAGED_STOCK: process.env.MANAGED_STOCK,
    MANAGED_PEXELS_API_KEY: process.env.MANAGED_PEXELS_API_KEY,
    CREDITS_LIVE: process.env.CREDITS_LIVE,
    MINUTE_QUOTA: process.env.MINUTE_QUOTA,
  };
  Object.assign(process.env, {
    MANAGED_GEMINI: "1",
    GEMINI_SERVER_KEY: "ops-test-gemini",
    MANAGED_STOCK: "1",
    MANAGED_PEXELS_API_KEY: "ops-test-pexels",
    CREDITS_LIVE: "0",
    MINUTE_QUOTA: "0",
  });

  const { prisma } = await import("../src/lib/prisma");
  const jobs = await import("../src/app/api/videos/jobs/route");
  const visualContext = await import("../src/app/api/editor-projects/[id]/visual-context/route");
  const { stylePackSnapshotFromJson } = await import("../src/lib/style-pack-snapshot");

  const script = "วันนี้เรามาคุยเรื่องการทำคลิปสั้นให้ปัง แล้วมาดูกันว่าจะเริ่มยังไงดี";

  async function pinnedProjectFor(kind: "free" | "internal", email: string) {
    const user = await prisma.user.create({
      data: kind === "free"
        ? { name: email, email, plan: "FREE" }
        : { name: email, email, plan: "PRO", role: "ADMIN" },
    });
    // Off the First-Clip Path, so the render takes the ordinary editor route.
    await prisma.video.create({
      data: {
        userId: user.id,
        script: "done",
        status: "COMPLETED",
        videoUrl: "/renders/done.mp4",
        avatarModel: "none",
        voiceModel: "gemini",
        sceneCount: 1,
      },
    });
    actingUserId = user.id;
    const project = await prisma.editorProject.create({
      data: { userId: user.id, title: `job creation ${kind}` },
    });
    const looked = await visualContext.PUT(
      new Request(`http://localhost/api/editor-projects/${project.id}/visual-context`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ look: { stylePackId: "finance-clear" } }),
      }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(looked.status, 200);
    return { user, project };
  }

  // ── An unadmitted pin renders with the pack, on stock ─────────────────────
  const free = await pinnedProjectFor("free", "ops-job-free@example.test");
  const stockJob = await jobs.POST(new Request("http://localhost/api/videos/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: free.project.id,
      script,
      stockSource: "stock",
      idempotencyKey: "ops-pin-free-stock",
    }),
  }));
  assert.equal(stockJob.status, 200, "an unadmitted pinned project still renders");
  const stockJobRow = await prisma.videoJob.findUniqueOrThrow({
    where: { id: (await stockJob.json() as { jobId: string }).jobId },
    select: { projectVisualContextJson: true, brandVisualAcceptanceJson: true },
  });
  assert.ok(
    stockJobRow.projectVisualContextJson,
    "a library user's pinned visual context is snapshotted onto the job",
  );
  assert.equal(
    stylePackSnapshotFromJson(stockJobRow.projectVisualContextJson)?.id,
    "finance-clear",
    "…so the wave-1 readers apply the pinned pack's stock mood, subtitles, pacing and music",
  );
  assert.equal(
    stockJobRow.brandVisualAcceptanceJson,
    null,
    "…while no AI-image acceptance envelope is minted for an unadmitted pin",
  );

  // The explicit AI-source gates stay exactly as they are (R7a).
  const refusedAi = await jobs.POST(new Request("http://localhost/api/videos/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: free.project.id,
      script,
      stockSource: "auto-mix",
      maxAiImages: 2,
      idempotencyKey: "ops-pin-free-automix",
    }),
  }));
  assert.equal(refusedAi.status, 403, "a pin is not a self-service ticket into AI images");
  assert.equal(
    (await refusedAi.json() as { error: string }).error,
    "beta_only",
    "…and it is refused by the AI-source gate itself, which wave 1b leaves untouched (R7a)",
  );

  // ── An admitted pin still gets its acceptance envelope ────────────────────
  const internal = await pinnedProjectFor("internal", "ops-job-internal@example.test");
  const aiJob = await jobs.POST(new Request("http://localhost/api/videos/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: internal.project.id,
      script,
      stockSource: "auto-mix",
      maxAiImages: 2,
      idempotencyKey: "ops-pin-internal-automix",
    }),
  }));
  assert.equal(aiJob.status, 200, "an admitted account still reaches the managed image route");
  const aiJobRow = await prisma.videoJob.findUniqueOrThrow({
    where: { id: (await aiJob.json() as { jobId: string }).jobId },
    select: { projectVisualContextJson: true, brandVisualAcceptanceJson: true },
  });
  assert.ok(aiJobRow.projectVisualContextJson);
  assert.ok(
    aiJobRow.brandVisualAcceptanceJson,
    "an admitted render still freezes its funding/reuse acceptance",
  );

  // fetch-stock is the second, authoritative check: without that envelope the
  // image path refuses regardless of what the job asked for.
  const { authorizeHeroVideoMint } = await import("../src/lib/hero-image-namespace");
  const { resolveBrandVisualJobAcceptanceEnvelope } = await import(
    "../src/lib/brand-visual-job-acceptance.server"
  );
  const fetchStockSource = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  assert.match(
    fetchStockSource,
    /const heroAiEligible = liveHeroAiEligible \|\| Boolean\(brandVisualAcceptance\)/,
    "fetch-stock admits the image path only from live access or an acceptance envelope",
  );
  const stockJobId = (await prisma.videoJob.findFirstOrThrow({
    where: { userId: free.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })).id;
  const mint = await authorizeHeroVideoMint({
    fromRenderPipeline: true,
    userId: free.user.id,
    videoJobId: stockJobId,
  });
  assert.equal(
    resolveBrandVisualJobAcceptanceEnvelope(mint.ok ? mint.brandVisualAcceptanceJson : null).state,
    "legacy",
    "an unadmitted pinned job carries no envelope, so fetch-stock's image path stays closed",
  );

  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.$disconnect();
}

async function main() {
  assert.equal(await wrapperExitFor(200), 0, "2xx cron response is successful");
  assert.equal(await wrapperExitFor(401), 1, "bad CRON_SECRET must fail the PM2 cron process");
  assert.equal(await wrapperExitFor(403), 1, "forbidden cron response must fail the PM2 cron process");
  try {
    await verifyLibraryAndImageGuards();
    await verifyPinOpensToEveryPlan();
    await verifyVisualContextDisclosure();
    await verifyContentPreflightForPinnedLibraryUsers();
    await verifyPinnedJobCreation();
  } finally {
    rmSync(routeDirectory, { recursive: true, force: true });
  }
  console.log("verify-brand-visual-ops: PASS deploy/heartbeat/auth failure gates + library/image guard matrix + pin-for-every-plan split");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
