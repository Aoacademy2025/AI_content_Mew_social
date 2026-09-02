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

// A persisted project pin is an unconditional grandfather clause in
// `resolveBrandVisualRenderAccess` (cohort `existing-pin`), so every write that
// can set one must stay on the IMAGE guard (ADR 0059 amendment 2026-09-02).
for (const pinWritingRoute of [
  "src/app/api/editor-projects/[id]/brand-revision/route.ts",
  "src/app/api/brand-library/from-project-look/route.ts",
]) {
  const source = readFileSync(pinWritingRoute, "utf8");
  assert.match(source, /requireBrandVisualUser/, `${pinWritingRoute} must keep the AI-image guard`);
  assert.doesNotMatch(source, /requireBrandLibraryUser/, `${pinWritingRoute} must not open on the library guard`);
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

  // …but it must NOT be able to attach that profile to a project. The pin is a
  // grandfather clause for AI-image rendering, so an open pin write would let a
  // non-entitled account self-admit into the managed image route.
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
  assert.equal(pinAttempt.status, 403, "pinning a Brand Profile to a project keeps the AI-image gate");
  assert.equal((await pinAttempt.json() as { code: string }).code, "PAYMENT_REQUIRED");
  const afterPinAttempt = await prisma.editorProject.findUnique({
    where: { id: project.id },
    select: { brandProfileRevisionId: true },
  });
  assert.equal(
    afterPinAttempt?.brandProfileRevisionId,
    null,
    "a refused pin must leave no persisted Revision on the project",
  );

  // The two seams the escalation chained: with no pin, the render acceptance
  // returns no admission, which is what makes POST /api/videos/jobs answer 403
  // on its Hero RunPod branch for this account.
  const { projectHasPersistedVisualPin } = await import("../src/lib/project-look.server");
  const { resolveBrandVisualRenderAccess } = await import("../src/lib/brand-visual-job-acceptance.server");
  const { resolveBrandVisualAccess } = await import("../src/lib/brand-visual-rollout.server");
  const liveUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const hasPersistedProjectPin = await projectHasPersistedVisualPin({ userId: user.id, projectId: project.id });
  assert.equal(hasPersistedProjectPin, false, "the refused pin leaves no persisted visual pin");
  const liveAccess = await resolveBrandVisualAccess(liveUser);
  assert.equal(liveAccess.canUse, false);
  assert.equal(
    resolveBrandVisualRenderAccess({ requestsBrandVisualImage: true, hasPersistedProjectPin, liveAccess }),
    null,
    "an unpaid account cannot reach the managed AI-image route through an existing-pin grandfather clause",
  );

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

async function main() {
  assert.equal(await wrapperExitFor(200), 0, "2xx cron response is successful");
  assert.equal(await wrapperExitFor(401), 1, "bad CRON_SECRET must fail the PM2 cron process");
  assert.equal(await wrapperExitFor(403), 1, "forbidden cron response must fail the PM2 cron process");
  try {
    await verifyLibraryAndImageGuards();
  } finally {
    rmSync(routeDirectory, { recursive: true, force: true });
  }
  console.log("verify-brand-visual-ops: PASS deploy/heartbeat/auth failure gates + library/image guard matrix");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
