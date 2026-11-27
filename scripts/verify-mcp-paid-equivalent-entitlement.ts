// Ticket 1 (S1) verification: MCP Paid-Equivalent entitlement parity for AdministratorGrant & GRANT coupons.
// Run: npm run verify:mcp-paid-equivalent

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DAY_MS = 24 * 60 * 60 * 1_000;

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-paid-eq-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.heroaiengine.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://studio.heroaiengine.com";
  process.env.MANAGED_STOCK = "1";
  process.env.MANAGED_PEXELS_API_KEY = "team_pexels_key";
  process.env.HERO_AI_IMAGE_PUBLIC = "1";
  process.env.MINUTE_QUOTA = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
  process.env.TMPDIR = join(dir, "tmp");
  process.env.MEDIA_IMPORT_STAGING_DIR = join(dir, "staging");
  mkdirSync(process.env.TMPDIR, { recursive: true, mode: 0o700 });
  mkdirSync(process.env.MEDIA_IMPORT_STAGING_DIR, { recursive: true, mode: 0o700 });
  delete process.env.RENDER_DEPLOY_DRAIN;

  execSync("./node_modules/.bin/prisma db push --skip-generate", {
    cwd: ROOT,
    stdio: "pipe",
    env: process.env,
  });

  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-paid-equivalent-entitlement.ts"));
  const fromSrc = (relPath: string) => realRequire(join(ROOT, "src", relPath));

  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { resolveMcpPrincipal, resolveMcpPrincipalByClerkId } =
    fromSrc("lib/mcp/auth") as typeof import("../src/lib/mcp/auth");
  const { createAdministratorGrant, revokeAdministratorGrants } =
    fromSrc("lib/administrator-grant.server") as typeof import("../src/lib/administrator-grant.server");
  const { prepareVideoQuote } =
    fromSrc("lib/mcp/video-quote.server") as typeof import("../src/lib/mcp/video-quote.server");
  const { requestVideoJob } =
    fromSrc("lib/mcp/video-budget.server") as typeof import("../src/lib/mcp/video-budget.server");
  const { issueUploadToken } =
    fromSrc("lib/media-import/imports") as typeof import("../src/lib/media-import/imports");
  const { stagedUploadPath } =
    fromSrc("lib/media-import/upload-staging") as typeof import("../src/lib/media-import/upload-staging");
  const { createMediaImportLane } =
    fromSrc("lib/media-import/lane") as typeof import("../src/lib/media-import/lane");
  const uploadRoute =
    fromSrc("app/api/mcp-uploads/[token]/route") as typeof import("../src/app/api/mcp-uploads/[token]/route");

  let currentWebUser: import("@prisma/client").User | null = null;
  const tokensRouteRequire = (specifier: string): unknown => {
    if (specifier === "server-only") return {};
    if (specifier === "@/lib/clerk-auth") {
      return { getCurrentUser: async () => currentWebUser };
    }
    if (specifier.startsWith("@/")) return fromSrc(specifier.slice(2));
    return realRequire(specifier);
  };
  const tokensRoutePath = "src/app/api/mcp-tokens/route.ts";
  const tokensRouteModule = { exports: {} as Record<string, unknown> };
  new Function(
    "require",
    "module",
    "exports",
    compile(readFileSync(tokensRoutePath, "utf8"), tokensRoutePath),
  )(tokensRouteRequire, tokensRouteModule, tokensRouteModule.exports);
  const TOKENS_GET = tokensRouteModule.exports.GET as () => Promise<Response>;
  const TOKENS_POST = tokensRouteModule.exports.POST as (req: Request) => Promise<Response>;

  // Map OAuth bearer tokens (`oat_<clerkId>`) to Clerk user IDs in verifyToken
  const oauthClerkIdByToken = new Map<string, string>();

  const routeRequire = (specifier: string): unknown => {
    if (specifier === "server-only") return {};
    if (specifier === "@clerk/nextjs/server") {
      return { auth: async () => ({}) };
    }
    if (specifier === "@clerk/mcp-tools/next") {
      return {
        verifyClerkToken: async (_clerkAuth: unknown, token: string) => {
          const clerkUserId = oauthClerkIdByToken.get(token);
          if (!clerkUserId) return undefined;
          return { clientId: clerkUserId, extra: { userId: clerkUserId } };
        },
      };
    }
    if (specifier === "@/lib/mcp/pipeline-client") {
      return {
        pipelineCaller: () => ({
          get: async (url: string) => {
            if (url === "/api/music") return { tracks: [], userTracks: [] };
            if (url === "/api/heygen/my-avatars") return { avatars: [] };
            if (url === "/api/elevenlabs/voices") return { voices: [] };
            return {};
          },
        }),
      };
    }
    if (specifier.startsWith("@/")) return fromSrc(specifier.slice(2));
    return realRequire(specifier);
  };

  const routePath = "src/app/api/[transport]/route.ts";
  const routeModule = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compile(readFileSync(routePath, "utf8"), routePath))(
    routeRequire,
    routeModule,
    routeModule.exports,
  );
  const ROUTE_POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

  let rpcSeq = 0;
  async function callMcpTool(bearerToken: string, name: string, args: Json = {}): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearerToken}`,
          "user-agent": "verify-mcp-paid-equivalent/1.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcSeq,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    assert.equal(response.status, 200, `HTTP 200 expected for ${name}, got ${response.status}`);
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const message = JSON.parse(dataLine ? dataLine.slice(6) : body) as Json;
    const result = message.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    assert.ok(text, `expected text content for ${name}, got ${JSON.stringify(message)}`);
    return JSON.parse(text) as Json;
  }

  try {
    const now = new Date();
    const past10d = new Date(now.getTime() - 10 * DAY_MS);
    const past1d = new Date(now.getTime() - 1 * DAY_MS);
    const future30d = new Date(now.getTime() + 30 * DAY_MS);

    const admin = await prisma.user.create({
      data: { id: "u-admin", name: "Admin", email: "admin@example.test", role: "ADMIN", plan: "BUSINESS" },
    });

    // 1. Active timed PRO AdministratorGrant on an account with an expired trialEndsAt and no Stripe sub
    const grantProUser = await prisma.user.create({
      data: {
        id: "u-grant-pro",
        name: "Grant Pro",
        email: "grant-pro@example.test",
        clerkId: "clerk_grant_pro",
        role: "USER",
        plan: "FREE",
        stripeSubscriptionId: null,
        subStatus: null,
        trialStartedAt: new Date(now.getTime() - 17 * DAY_MS),
        trialEndsAt: past10d,
      },
    });
    await createAdministratorGrant(
      {
        userId: grantProUser.id,
        plan: "PRO",
        reason: "Internal team PRO access",
        expiresAt: future30d,
        permanent: false,
        grantedById: admin.id,
      },
      now,
    );
    const { token: grantProPat } = await createMcpToken(grantProUser.id, "GrantProPAT");
    const grantProOauth = "oat_grant_pro";
    oauthClerkIdByToken.set(grantProOauth, grantProUser.clerkId!);

    // 2. Active permanent BUSINESS AdministratorGrant overlaid on a PRO label with expired trialEndsAt
    const grantBizUser = await prisma.user.create({
      data: {
        id: "u-grant-biz",
        name: "Grant Biz",
        email: "grant-biz@example.test",
        clerkId: "clerk_grant_biz",
        role: "USER",
        plan: "PRO",
        stripeSubscriptionId: null,
        subStatus: null,
        trialStartedAt: new Date(now.getTime() - 17 * DAY_MS),
        trialEndsAt: past10d,
      },
    });
    await prisma.administratorGrant.create({
      data: {
        userId: grantBizUser.id,
        plan: "BUSINESS",
        reason: "Permanent partner grant",
        startsAt: past1d,
        expiresAt: null,
        permanent: true,
        grantedById: admin.id,
      },
    });
    const { token: grantBizPat } = await createMcpToken(grantBizUser.id, "GrantBizPAT");
    const grantBizOauth = "oat_grant_biz";
    oauthClerkIdByToken.set(grantBizOauth, grantBizUser.clerkId!);

    // 3. Active GRANT coupon redemption on an account with expired trialEndsAt and no Stripe sub
    const couponProUser = await prisma.user.create({
      data: {
        id: "u-coupon-pro",
        name: "Coupon Pro",
        email: "coupon-pro@example.test",
        clerkId: "clerk_coupon_pro",
        role: "USER",
        plan: "PRO",
        stripeSubscriptionId: null,
        subStatus: null,
        trialStartedAt: new Date(now.getTime() - 17 * DAY_MS),
        trialEndsAt: past10d,
        usageLimit: 100,
        minutesLimit: 80,
        usagePeriodStartedAt: now,
      },
    });
    const grantCoupon = await prisma.coupon.create({
      data: {
        code: "COURSEPRO30",
        type: "GRANT",
        plan: "PRO",
        durationDays: 30,
        maxUses: 100,
        usedCount: 1,
        isActive: true,
      },
    });
    await prisma.couponRedemption.create({
      data: {
        couponId: grantCoupon.id,
        userId: couponProUser.id,
        redeemedAt: past1d,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: past1d,
        entitlementExpiresAt: future30d,
      },
    });
    const { token: couponProPat } = await createMcpToken(couponProUser.id, "CouponProPAT");
    const couponProOauth = "oat_coupon_pro";
    oauthClerkIdByToken.set(couponProOauth, couponProUser.clerkId!);

    // 4. Negative cases: revoked grant (with expired trial AND without trial) & expired grant / coupon
    const revokedTrialUser = await prisma.user.create({
      data: {
        id: "u-revoked-trial",
        name: "Revoked Trial",
        email: "revoked-trial@example.test",
        clerkId: "clerk_revoked_trial",
        plan: "FREE",
        trialEndsAt: past10d,
      },
    });
    await createAdministratorGrant(
      {
        userId: revokedTrialUser.id,
        plan: "PRO",
        reason: "Temporary team access",
        expiresAt: future30d,
        permanent: false,
        grantedById: admin.id,
      },
      past1d,
    );
    await revokeAdministratorGrants({ userId: revokedTrialUser.id, revokedById: admin.id, reason: "offboarded" }, now);
    const { token: revokedTrialPat } = await createMcpToken(revokedTrialUser.id, "RevokedTrialPAT");

    const revokedNoTrialUser = await prisma.user.create({
      data: {
        id: "u-revoked-notrial",
        name: "Revoked No Trial",
        email: "revoked-notrial@example.test",
        clerkId: "clerk_revoked_notrial",
        plan: "FREE",
        trialEndsAt: null,
        planExpiresAt: null,
      },
    });
    await createAdministratorGrant(
      {
        userId: revokedNoTrialUser.id,
        plan: "PRO",
        reason: "Temporary partner access",
        expiresAt: future30d,
        permanent: false,
        grantedById: admin.id,
      },
      past1d,
    );
    await revokeAdministratorGrants({ userId: revokedNoTrialUser.id, revokedById: admin.id, reason: "ended early" }, now);
    const { token: revokedNoTrialPat } = await createMcpToken(revokedNoTrialUser.id, "RevokedNoTrialPAT");

    const expiredGrantUser = await prisma.user.create({
      data: {
        id: "u-expired-grant",
        name: "Expired Grant",
        email: "expired-grant@example.test",
        clerkId: "clerk_expired_grant",
        plan: "PRO",
        trialEndsAt: null,
        planExpiresAt: null,
      },
    });
    await prisma.administratorGrant.create({
      data: {
        userId: expiredGrantUser.id,
        plan: "PRO",
        reason: "Expired cohort",
        startsAt: past10d,
        expiresAt: past1d,
        permanent: false,
        grantedById: admin.id,
      },
    });
    const { token: expiredGrantPat } = await createMcpToken(expiredGrantUser.id, "ExpiredGrantPAT");

    const expiredCouponUser = await prisma.user.create({
      data: {
        id: "u-expired-coupon",
        name: "Expired Coupon",
        email: "expired-coupon@example.test",
        clerkId: "clerk_expired_coupon",
        plan: "PRO",
        trialEndsAt: past10d,
      },
    });
    await prisma.couponRedemption.create({
      data: {
        couponId: grantCoupon.id,
        userId: expiredCouponUser.id,
        redeemedAt: past10d,
        outcome: "ACTIVATED",
        entitlementPlan: "PRO",
        entitlementStartsAt: past10d,
        entitlementExpiresAt: past1d,
      },
    });
    const { token: expiredCouponPat } = await createMcpToken(expiredCouponUser.id, "ExpiredCouponPAT");

    // ── Slice 1 Assertions: Auth & Read/Discovery Tools (PAT + Clerk OAuth) ──
    for (const [label, pat, oauth, expectedPlan, clerkId] of [
      ["AdministratorGrant PRO", grantProPat, grantProOauth, "PRO", grantProUser.clerkId!],
      ["AdministratorGrant permanent BUSINESS", grantBizPat, grantBizOauth, "BUSINESS", grantBizUser.clerkId!],
      ["GRANT coupon PRO", couponProPat, couponProOauth, "PRO", couponProUser.clerkId!],
    ] as const) {
      const patPrincipal = await resolveMcpPrincipal(pat);
      assert.equal(patPrincipal?.effectivePlan, expectedPlan, `${label} PAT principal effectivePlan must be ${expectedPlan}`);
      const oauthPrincipal = await resolveMcpPrincipalByClerkId(clerkId);
      assert.equal(oauthPrincipal?.effectivePlan, expectedPlan, `${label} Clerk OAuth principal effectivePlan must be ${expectedPlan}`);

      for (const [authKind, bearer] of [["PAT", pat], ["OAuth", oauth]] as const) {
        const me = await callMcpTool(bearer, "get_current_user");
        assert.notEqual(me.error, "plan_required", `${label} (${authKind}) get_current_user must not return plan_required`);
        assert.equal(me.effectivePlan, expectedPlan, `${label} (${authKind}) get_current_user.effectivePlan must be ${expectedPlan}`);
        const starter = me.mcpStarterTrial as { isStarterTrialPlan?: boolean; eligible?: boolean };
        assert.equal(starter.isStarterTrialPlan, false, `${label} (${authKind}) must not be treated as starter trial`);

        const brands = await callMcpTool(bearer, "list_brand_profiles");
        assert.equal(brands.ok, true, `${label} (${authKind}) list_brand_profiles must succeed`);

        const options = await callMcpTool(bearer, "get_video_options");
        assert.notEqual(options.error, "plan_required", `${label} (${authKind}) get_video_options must not return plan_required`);
        assert.ok(Array.isArray(options.templates), `${label} (${authKind}) get_video_options returns templates`);
      }
    }

    for (const [label, pat, clerkId] of [
      ["Revoked AdministratorGrant (expired trial)", revokedTrialPat, revokedTrialUser.clerkId!],
      ["Revoked AdministratorGrant (no trial)", revokedNoTrialPat, revokedNoTrialUser.clerkId!],
      ["Expired AdministratorGrant (no trial)", expiredGrantPat, expiredGrantUser.clerkId!],
      ["Expired GRANT coupon", expiredCouponPat, expiredCouponUser.clerkId!],
    ] as const) {
      const patPrincipal = await resolveMcpPrincipal(pat);
      assert.equal(patPrincipal?.effectivePlan, "FREE", `${label} PAT effectivePlan must fail closed to FREE`);
      const oauthPrincipal = await resolveMcpPrincipalByClerkId(clerkId);
      assert.equal(oauthPrincipal?.effectivePlan, "FREE", `${label} OAuth effectivePlan must fail closed to FREE`);

      for (const toolName of ["get_current_user", "list_brand_profiles", "get_video_options"] as const) {
        const res = await callMcpTool(pat, toolName);
        assert.equal(res.error, "plan_required", `${label} ${toolName} must be blocked with plan_required`);
      }
    }

    console.log("PASS Slice 1: MCP auth & discovery tools honor Paid-Equivalent entitlement and fail closed on revoked/expired grants");

    // ── Slice 2 Assertions: prepare_video_job & create_video_job (PAT + OAuth + direct seams) ──
    for (const u of [grantProUser, grantBizUser, couponProUser]) {
      await prisma.creditBalance.upsert({
        where: { userId: u.id },
        create: { userId: u.id, granted: 0, purchased: 200 },
        update: { purchased: 200 },
      });
    }

    // Scheduled GRANT coupon that is now active in time, before User.plan materialization
    const scheduledCouponUser = await prisma.user.create({
      data: {
        id: "u-scheduled-coupon",
        name: "Scheduled Coupon",
        email: "scheduled-coupon@example.test",
        clerkId: "clerk_scheduled_coupon",
        role: "USER",
        plan: "FREE",
        stripeSubscriptionId: null,
        subStatus: null,
        trialStartedAt: new Date(now.getTime() - 17 * DAY_MS),
        trialEndsAt: past10d,
        usageLimit: 100,
        minutesLimit: 80,
        usagePeriodStartedAt: now,
      },
    });
    await prisma.creditBalance.create({ data: { userId: scheduledCouponUser.id, purchased: 100 } });
    await prisma.couponRedemption.create({
      data: {
        couponId: grantCoupon.id,
        userId: scheduledCouponUser.id,
        redeemedAt: past10d,
        outcome: "SCHEDULED",
        entitlementPlan: "PRO",
        entitlementStartsAt: past1d,
        entitlementExpiresAt: future30d,
      },
    });
    const { token: scheduledCouponPat } = await createMcpToken(scheduledCouponUser.id, "ScheduledCouponPAT");

    for (const [label, bearer] of [
      ["AdministratorGrant PRO (PAT)", grantProPat],
      ["AdministratorGrant PRO (OAuth)", grantProOauth],
      ["AdministratorGrant BUSINESS (PAT)", grantBizPat],
      ["GRANT coupon PRO (PAT)", couponProPat],
      ["GRANT coupon PRO (OAuth)", couponProOauth],
      ["Scheduled GRANT coupon PRO (PAT)", scheduledCouponPat],
    ] as const) {
      const quoteReply = await callMcpTool(bearer, "prepare_video_job", {
        script: "สวัสดีครับ วันนี้มาดูเทคนิคทำคลิปสั้นด้วย AI Agent แบบมืออาชีพสำหรับครีเอเตอร์",
        brollSource: "hero-ai-image",
        exportMode: "hold",
      });
      assert.notEqual(quoteReply.error, "plan_required", `${label} prepare_video_job must not return plan_required`);
      assert.equal(quoteReply.status, "draft", `${label} prepare_video_job must return a draft quote`);
      assert.ok(typeof quoteReply.quoteId === "string" && quoteReply.quoteId.length > 0, `${label} returns quoteId`);
    }

    // BUSINESS grant overlaid on PRO row must get BUSINESS 10-min duration cap (no false >6-min Pro warning)
    const bizSevenMinQuote = await callMcpTool(grantBizPat, "prepare_video_job", {
      script: "ก".repeat(4_800),
      brollSource: "stock",
    });
    assert.equal(bizSevenMinQuote.status, "draft", "BUSINESS grant ~7-min quote succeeds");
    const bizWarnings = Array.isArray(bizSevenMinQuote.warnings) ? (bizSevenMinQuote.warnings as string[]) : [];
    assert.ok(
      !bizWarnings.some((w) => w.includes("เกินเพดานแผน Pro")),
      `BUSINESS grant must evaluate duration warning against BUSINESS cap, got: ${JSON.stringify(bizWarnings)}`,
    );

    for (const [label, bearer] of [
      ["AdministratorGrant PRO", grantProPat],
      ["AdministratorGrant BUSINESS", grantBizOauth],
      ["GRANT coupon PRO", couponProPat],
      ["Scheduled GRANT coupon PRO", scheduledCouponPat],
    ] as const) {
      const created = await callMcpTool(bearer, "create_video_job", {
        script: `สคริปต์สร้างวิดีโอจริงสำหรับ ${label} ที่ต้องผ่านทั้งใบประเมินวงเงินและการจองคิวงาน`,
        title: `Job ${label}`,
        brollSource: "stock",
        exportMode: "hold",
      });
      assert.notEqual(created.error, "plan_required", `${label} create_video_job must not return plan_required: ${JSON.stringify(created)}`);
      assert.ok(typeof created.jobId === "string" && created.jobId.length > 0, `${label} create_video_job returns jobId`);
      assert.equal(created.status, "queued", `${label} create_video_job queues the job`);
    }

    // Revoked / expired grants & coupons fail closed at both route AND direct service seams
    for (const [label, userId, pat] of [
      ["Revoked AdministratorGrant (expired trial)", revokedTrialUser.id, revokedTrialPat],
      ["Revoked AdministratorGrant (no trial)", revokedNoTrialUser.id, revokedNoTrialPat],
      ["Expired AdministratorGrant (no trial)", expiredGrantUser.id, expiredGrantPat],
      ["Expired GRANT coupon", expiredCouponUser.id, expiredCouponPat],
    ] as const) {
      const freshUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const directQuote = await prepareVideoQuote(freshUser, {
        script: "สคริปต์ทดสอบบัญชีที่หมดอายุหรือถูกเพิกถอนสิทธิ์",
        brollSource: "stock",
      });
      assert.equal("code" in directQuote && directQuote.code, "plan_required", `${label} direct prepareVideoQuote must return plan_required`);

      const directJob = await requestVideoJob(freshUser, {
        script: "สคริปต์ทดสอบบัญชีที่หมดอายุหรือถูกเพิกถอนสิทธิ์",
        brollSource: "stock",
      });
      assert.equal("code" in directJob && directJob.code, "plan_required", `${label} direct requestVideoJob must return plan_required`);

      const routePrepare = await callMcpTool(pat, "prepare_video_job", {
        script: "สคริปต์ทดสอบผ่าน route",
        brollSource: "stock",
      });
      assert.equal(routePrepare.error, "plan_required", `${label} route prepare_video_job must return plan_required`);

      const routeCreate = await callMcpTool(pat, "create_video_job", {
        script: "สคริปต์ทดสอบผ่าน route",
        brollSource: "stock",
      });
      assert.equal(routeCreate.error, "plan_required", `${label} route create_video_job must return plan_required`);
    }

    console.log("PASS Slice 2: prepare_video_job & create_video_job honor Paid-Equivalent entitlement and fail closed on revoked/expired grants");

    // ── Slice 3 Assertions: /api/mcp-tokens, PUT /api/mcp-uploads/[token], and MediaImport lane ──
    mkdirSync(process.env.TMPDIR!, { recursive: true, mode: 0o700 });
    mkdirSync(process.env.MEDIA_IMPORT_STAGING_DIR!, { recursive: true, mode: 0o700 });

    // 3A. GET & POST /api/mcp-tokens
    for (const [label, userId] of [
      ["AdministratorGrant PRO", grantProUser.id],
      ["AdministratorGrant BUSINESS", grantBizUser.id],
      ["GRANT coupon PRO", couponProUser.id],
    ] as const) {
      currentWebUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const getRes = await TOKENS_GET();
      assert.equal(getRes.status, 200, `${label} GET /api/mcp-tokens returns 200`);
      const getBody = (await getRes.json()) as { starterTrial?: { isStarterTrialPlan?: boolean } };
      assert.equal(getBody.starterTrial?.isStarterTrialPlan, false, `${label} GET /api/mcp-tokens isStarterTrialPlan must be false`);

      const postRes = await TOKENS_POST(
        new Request("https://studio.heroaiengine.com/api/mcp-tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "WebCreatedPAT" }),
        }),
      );
      assert.equal(postRes.status, 201, `${label} POST /api/mcp-tokens must succeed with 201`);
    }

    for (const [label, userId] of [
      ["Revoked AdministratorGrant (expired trial)", revokedTrialUser.id],
      ["Revoked AdministratorGrant (no trial)", revokedNoTrialUser.id],
      ["Expired AdministratorGrant (no trial)", expiredGrantUser.id],
      ["Expired GRANT coupon", expiredCouponUser.id],
    ] as const) {
      currentWebUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const postRes = await TOKENS_POST(
        new Request("https://studio.heroaiengine.com/api/mcp-tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "ShouldBeBlocked" }),
        }),
      );
      assert.equal(postRes.status, 403, `${label} POST /api/mcp-tokens must fail closed with 403`);
    }

    // 3B. PUT /api/mcp-uploads/[token]
    // Minimal valid PNG header so stagedContainerFor("image") recognizes PNG
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    ]);

    for (const [label, userId] of [
      ["AdministratorGrant PRO", grantProUser.id],
      ["GRANT coupon PRO", couponProUser.id],
    ] as const) {
      const issued = await issueUploadToken(userId, "image");
      assert.equal(issued.ok, true, `${label} issueUploadToken ok`);
      if (!issued.ok) throw new Error("unreachable");
      const putRes = await uploadRoute.PUT(
        new Request(`https://studio.heroaiengine.com/api/mcp-uploads/${issued.token}`, {
          method: "PUT",
          headers: { "content-length": String(minimalPng.byteLength) },
          body: minimalPng,
          // @ts-expect-error Node Request duplex for streamed body
          duplex: "half",
        }),
        { params: Promise.resolve({ token: issued.token }) },
      );
      assert.equal(putRes.status, 202, `${label} PUT /api/mcp-uploads/[token] must return 202`);
      await prisma.mediaImport.deleteMany({ where: { id: issued.importId } });
      rmSync(stagedUploadPath(issued.importId), { force: true });
    }

    for (const [label, userId] of [
      ["Revoked AdministratorGrant (expired trial)", revokedTrialUser.id],
      ["Revoked AdministratorGrant (no trial)", revokedNoTrialUser.id],
      ["Expired AdministratorGrant (no trial)", expiredGrantUser.id],
    ] as const) {
      const issued = await issueUploadToken(userId, "image");
      assert.equal(issued.ok, true);
      if (!issued.ok) throw new Error("unreachable");
      const putRes = await uploadRoute.PUT(
        new Request(`https://studio.heroaiengine.com/api/mcp-uploads/${issued.token}`, {
          method: "PUT",
          headers: { "content-length": String(minimalPng.byteLength) },
          body: minimalPng,
          // @ts-expect-error Node Request duplex for streamed body
          duplex: "half",
        }),
        { params: Promise.resolve({ token: issued.token }) },
      );
      assert.equal(putRes.status, 404, `${label} PUT /api/mcp-uploads/[token] must fail closed with 404`);
    }

    // 3C. MediaImport lane passes resolved Paid-Equivalent plan ("PRO" / "BUSINESS" / "FREE") to processStaged
    const observedPlanByImportId = new Map<string, string>();
    const laneCases = [
      { label: "AdministratorGrant PRO", userId: grantProUser.id, expectedPlan: "PRO" },
      { label: "AdministratorGrant BUSINESS", userId: grantBizUser.id, expectedPlan: "BUSINESS" },
      { label: "GRANT coupon PRO", userId: couponProUser.id, expectedPlan: "PRO" },
      { label: "Revoked AdministratorGrant (no trial)", userId: revokedNoTrialUser.id, expectedPlan: "FREE" },
      { label: "Expired AdministratorGrant (no trial)", userId: expiredGrantUser.id, expectedPlan: "FREE" },
    ] as const;

    const laneImportIds: Array<{ id: string; label: string; expectedPlan: string }> = [];
    for (const c of laneCases) {
      const row = await prisma.mediaImport.create({
        data: {
          userId: c.userId,
          purpose: "presenter",
          source: "upload",
          status: "pending",
          deadlineAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      writeFileSync(stagedUploadPath(row.id), minimalPng, { mode: 0o600 });
      laneImportIds.push({ id: row.id, label: c.label, expectedPlan: c.expectedPlan });
    }

    const stocksDir = join(dir, "stocks");
    mkdirSync(stocksDir, { recursive: true });
    const lane = createMediaImportLane({
      pollMs: 15,
      watchdogMs: 60_000,
      stocksDir,
      log: { info: () => {}, error: () => {} },
      processStaged: async (params) => {
        observedPlanByImportId.set(params.importId, params.plan);
        rmSync(stagedUploadPath(params.importId), { force: true });
        return { ok: true, resultSrc: `/api/stocks/broll-upload-${params.importId}.mp4`, durationMs: 4_000 };
      },
    });
    lane.start();
    const waitStart = Date.now();
    while (observedPlanByImportId.size < laneImportIds.length && Date.now() - waitStart < 10_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await lane.stop();

    for (const item of laneImportIds) {
      assert.equal(
        observedPlanByImportId.get(item.id),
        item.expectedPlan,
        `MediaImport lane plan for ${item.label} must be ${item.expectedPlan}`,
      );
    }

    console.log("PASS Slice 3: /api/mcp-tokens, /api/mcp-uploads/[token], and MediaImport lane honor Paid-Equivalent entitlement");
  } finally {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
