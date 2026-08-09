// Verifies task 4 of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   Plan gate (isHeroAiImageEligible) + rate caps (checkHeroImageRate) + the
//   HERO_AI_IMAGE_PUBLIC launch flag, wired into all three Hero AI Image entry
//   points (fetch-stock hero mode, fetch-stock AutoMix AI slots,
//   broll-window/generate).
//
// Run via: node --conditions=react-server --import tsx scripts/verify-hero-image-gate.ts
// (the react-server condition is required so "server-only"-tagged modules this
// script exercises resolve to their no-op stub instead of throwing; same pattern
// as verify-hero-image-price.ts / verify-automix-hero-migration.ts.)
//
// DATABASE_URL is pointed at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, so the cached PrismaClient
// singleton never touches the real dev.db.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // ── 0. Throwaway SQLite ─────────────────────────────────────────────────
  const dbDir = mkdtempSync(join(tmpdir(), "hero-image-gate-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Eligibility matrix
  // ═══════════════════════════════════════════════════════════════════════
  const { isHeroAiImageEligible } = await import("../src/lib/internal-ai-access");

  type Actor = { email?: string | null; role?: string | null; plan?: string | null; trialEndsAt?: Date | null };
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const admin: Actor = { email: "admin@example.com", role: "ADMIN", plan: "FREE", trialEndsAt: null };
  const allowlisted: Actor = { email: "tester@aoacademy.co", role: "USER", plan: "FREE", trialEndsAt: null };
  const proUser: Actor = { email: "pro@example.com", role: "USER", plan: "PRO", trialEndsAt: null };
  const proTrial: Actor = { email: "trial@example.com", role: "USER", plan: "PRO", trialEndsAt: future };
  const freeUser: Actor = { email: "free@example.com", role: "USER", plan: "FREE", trialEndsAt: null };
  const businessUser: Actor = { email: "biz@example.com", role: "USER", plan: "BUSINESS", trialEndsAt: null };

  function withPublicFlag<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env.HERO_AI_IMAGE_PUBLIC;
    if (value === undefined) delete process.env.HERO_AI_IMAGE_PUBLIC;
    else process.env.HERO_AI_IMAGE_PUBLIC = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env.HERO_AI_IMAGE_PUBLIC;
      else process.env.HERO_AI_IMAGE_PUBLIC = prior;
    }
  }

  const matrix: Array<[string, Actor, boolean, boolean]> = [
    // [label, actor, expected when flag unset, expected when flag="1"]
    ["ADMIN", admin, true, true],
    ["allowlisted USER (aoacademy.co)", allowlisted, true, true],
    ["PRO USER", proUser, false, true],
    ["PRO trial (trialEndsAt future)", proTrial, false, true],
    ["FREE USER", freeUser, false, false],
    ["BUSINESS USER", businessUser, false, true],
  ];

  for (const [label, actor, expectUnset, expectPublic] of matrix) {
    withPublicFlag(undefined, () => {
      check(`${label} × flag unset → ${expectUnset ? "allow" : "deny"}`, isHeroAiImageEligible(actor) === expectUnset);
    });
    withPublicFlag("1", () => {
      check(`${label} × flag="1" → ${expectPublic ? "allow" : "deny"}`, isHeroAiImageEligible(actor) === expectPublic);
    });
  }
  // A value other than the literal "1" must behave exactly like unset.
  withPublicFlag("true", () => {
    check("flag=\"true\" (not the literal \"1\") behaves like unset for PRO", isHeroAiImageEligible(proUser) === false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Rate math
  // ═══════════════════════════════════════════════════════════════════════
  const { prisma } = await import("../src/lib/prisma");
  const {
    checkHeroImageRate,
    HERO_IMAGE_HOURLY_CAP,
    HERO_IMAGE_DAILY_CAP,
  } = await import("../src/lib/hero-image-rate-limit");

  check("HERO_IMAGE_HOURLY_CAP === 20", HERO_IMAGE_HOURLY_CAP === 20);
  check("HERO_IMAGE_DAILY_CAP === 120", HERO_IMAGE_DAILY_CAP === 120);

  const user = await prisma.user.create({
    data: { name: "Hero Image Gate Verify", email: "hero-image-gate-verify@example.invalid" },
  });

  async function seedJobs(count: number, opts: { minutesAgo: number; chargeState?: string }) {
    const createdAt = new Date(Date.now() - opts.minutesAgo * 60 * 1000);
    for (let i = 0; i < count; i += 1) {
      await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          chargeState: opts.chargeState ?? "settled",
          createdAt,
        },
      });
    }
  }

  // ── 2a. usedHour/usedDay counts + hourly SOFT semantics ────────────────
  await seedJobs(19, { minutesAgo: 10 });
  {
    const r = await checkHeroImageRate(user.id, 60);
    check(
      "19 used this hour → a 60-image batch is ALLOWED (soft gate only blocks starting once at cap)",
      r.ok === true,
      JSON.stringify(r),
    );
  }
  await seedJobs(1, { minutesAgo: 5 }); // now 20 used in the trailing hour
  {
    const r = await checkHeroImageRate(user.id, 1);
    check(
      "20 used this hour → denied, scope=hour",
      r.ok === false && r.scope === "hour" && r.usedHour === 20,
      JSON.stringify(r),
    );
    check("retryAfterSec is a sane positive number (<= 1 hour)", !r.ok && r.retryAfterSec > 0 && r.retryAfterSec <= 3600, JSON.stringify(r));
  }

  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });

  // ── 2b. Daily HARD semantics (jobs old enough to have left the hourly window) ──
  await seedJobs(100, { minutesAgo: 90 }); // 1.5h ago: counts toward day, not hour
  {
    const rDenied = await checkHeroImageRate(user.id, 21);
    check(
      "100 used today (all >1h old) + 21-image batch → denied, scope=day (121 > 120)",
      rDenied.ok === false && rDenied.scope === "day" && rDenied.usedDay === 100 && rDenied.usedHour === 0,
      JSON.stringify(rDenied),
    );
    const rAllowed = await checkHeroImageRate(user.id, 20);
    check(
      "100 used today + 20-image batch → allowed (120 <= 120)",
      rAllowed.ok === true,
      JSON.stringify(rAllowed),
    );
  }

  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });

  // ── 2c. Refunded/failed rows still count (they consumed provider capacity) ──
  await seedJobs(20, { minutesAgo: 10, chargeState: "refunded" });
  {
    const r = await checkHeroImageRate(user.id, 1);
    check(
      "20 REFUNDED jobs this hour still trip the hourly cap",
      r.ok === false && r.scope === "hour" && r.usedHour === 20,
      JSON.stringify(r),
    );
  }

  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });

  // ── 2d. Jobs outside the 24h window never count ─────────────────────────
  await seedJobs(50, { minutesAgo: 25 * 60 }); // 25h ago — outside both windows
  {
    // A planned count equal to the FULL daily cap would be denied (usedDay +
    // planned > cap) if the 50 stale rows were (incorrectly) still counted, so
    // this positively proves rows older than 24h are excluded from usedDay too.
    const r = await checkHeroImageRate(user.id, HERO_IMAGE_DAILY_CAP);
    check(
      `jobs older than 24h are excluded from both windows (a ${HERO_IMAGE_DAILY_CAP}-image batch is allowed despite 50 stale rows)`,
      r.ok === true,
      JSON.stringify(r),
    );
  }

  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });

  // ── 2e. ADMIN bypass ─────────────────────────────────────────────────────
  await seedJobs(500, { minutesAgo: 1 }); // grossly over both caps
  {
    const r = await checkHeroImageRate(user.id, 500, { isAdmin: true });
    check("opts.isAdmin bypasses the caps entirely, even far over both ceilings", r.ok === true, JSON.stringify(r));
  }

  await prisma.$disconnect();

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Static asserts (grep-level) — every entry point wired correctly
  // ═══════════════════════════════════════════════════════════════════════
  const fetchStock = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const videoJobs = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  const brollWindowGenerate = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");

  check(
    "fetch-stock calls isHeroAiImageEligible",
    fetchStock.includes("isHeroAiImageEligible(user)"),
  );
  check(
    "videos/jobs calls isHeroAiImageEligible at both the hero-mode and AutoMix gate",
    videoJobs.match(/isHeroAiImageEligible\(user\)/g)?.length === 2,
  );
  check(
    "broll-window/generate calls isHeroAiImageEligible",
    brollWindowGenerate.includes("isHeroAiImageEligible(user)"),
  );

  function assertBefore(source: string, needleA: string, needleB: string, label: string) {
    const at = source.indexOf(needleA);
    const bt = source.indexOf(needleB);
    check(label, at >= 0 && bt >= 0 && at < bt, `needleA@${at} needleB@${bt}`);
  }

  // fetch-stock hero-only mode: rate check before the first generateHeroImageForVideo call.
  assertBefore(
    fetchStock,
    "const heroRate = await checkHeroImageRate(userId, clipsToGenerate);",
    "const generated = await generateHeroImageForVideo({",
    "fetch-stock hero mode: checkHeroImageRate runs before generateHeroImageForVideo (reservation)",
  );
  // fetch-stock AutoMix AI slots: rate check before the AutoMix generateHeroImageForVideo call.
  assertBefore(
    fetchStock,
    "const heroRate = isAdmin ? null : await checkHeroImageRate(userId, aiSlotsNeedingGeneration().length);",
    "generated = await generateHeroImageForVideo({",
    "fetch-stock AutoMix: checkHeroImageRate runs before generateHeroImageForVideo (reservation)",
  );
  // broll-window/generate: rate check before its generateHeroImageForVideo call.
  assertBefore(
    brollWindowGenerate,
    "const heroRate = await checkHeroImageRate(user.id, 1);",
    "generated = await generateHeroImageForVideo({",
    "broll-window/generate: checkHeroImageRate runs before generateHeroImageForVideo (reservation)",
  );

  check(
    "ADMIN is exempted from the rate cap at every call site (skip-the-call pattern)",
    /if \(!isAdmin\) \{\s*if \(clipsToGenerate > 0\) \{\s*const heroRate = await checkHeroImageRate\(userId, clipsToGenerate\);/.test(fetchStock)
      && fetchStock.includes("const heroRate = isAdmin ? null : await checkHeroImageRate(userId, aiSlotsNeedingGeneration().length);")
      && /if \(!isAdmin\) \{\s*const heroRate = await checkHeroImageRate\(user\.id, 1\);/.test(brollWindowGenerate),
  );

  check(
    "AutoMix rate-limit degrade sets aiSkippedReason to \"rate\" and a distinct telemetry marker",
    fetchStock.includes('aiSkippedReason = "rate";')
      && fetchStock.includes("heroAutoMixDegradeReason")
      && fetchStock.includes('"rate_limited"'),
  );

  check(
    "the public-flag plan_required response is reused (not re-typed) at every ineligible-and-flag-on branch",
    (fetchStock.match(/HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE\.body/g)?.length ?? 0) >= 2
      && (videoJobs.match(/HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE\.body/g)?.length ?? 0) >= 2
      && brollWindowGenerate.includes("HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.body"),
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
