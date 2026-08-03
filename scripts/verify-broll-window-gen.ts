// Proof of the per-window AI-gen endpoint's money path (Task 9,
// src/app/api/videos/broll-window/generate/route.ts). Run against a throwaway SQLite:
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-broll-window-gen.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-broll-window-gen.db?connection_limit=1" npx tsx scripts/verify-broll-window-gen.ts
//
// `simulateGenerateRoute` is a FAITHFUL replica of route.ts's post-auth decision +
// charge/refund flow (the route can't export non-handler symbols), wired to the REAL
// primitives (resolveKieImageAccess / shouldGuardKieImages / spendCredits /
// refundCredits / costKeyForKieModel / creditCostFor / tryConsumeKieImageRate /
// capKiePrompt). Only the kie network call + ffmpeg Ken Burns are mocked (a
// `kieSucceeds` boolean) — everything credit/access/rate/prompt is exercised live.
//
// Covers: flag/access gate (403 not-unlocked) · model default/invalid(400)/
// non-admin-unpriced(403) · empty-prompt(400) + prompt cap · missing-key(400) ·
// rate(429) · insufficient(402 {need,balance}) · gen-failure → exact-bucket refund(502)
// with matched action id (net zero) · success(200 {creditsSpent,balanceAfter}) ·
// admin uncharged. Ledger action prefixes `broll-window-image:` / `broll-window-image-refund:`.
import { prisma } from "../src/lib/prisma";
import {
  creditCostFor,
  costKeyForKieModel,
  spendCredits,
  refundCredits,
  grantCredits,
  getBalance,
} from "../src/lib/credits";
import {
  resolveKieImageAccess,
  shouldGuardKieImages,
  tryConsumeKieImageRate,
  capKiePrompt,
  __resetKieImageRateForTest,
} from "../src/lib/kie-image-guards";
import {
  DEFAULT_KIE_IMAGE_MODEL,
  interpretKieCreditResponse,
  isKieAuthenticationError,
  isKieImageModel,
} from "../src/lib/kie-client";
import { randomUUID } from "crypto";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) {
    console.error("❌ " + m);
    process.exit(1);
  }
  console.log("✓ " + m);
  passed++;
}

const SPEND_PREFIX = "broll-window-image:";
const REFUND_PREFIX = "broll-window-image-refund:";

interface RouteInput {
  userId: string;
  isAdmin: boolean;
  plan: string;
  managedKieOn: boolean;
  creditsLive: boolean;
  kieEnvKey: string | null;
  userKieKey: string | null; // decoded BYOK key (the route base64-decodes user.kieKey)
  prompt: unknown;
  model: unknown;
  kieSucceeds: boolean; // mock for the kie network call + ffmpeg Ken Burns
}

interface RouteResult {
  status: number;
  body: Record<string, unknown>;
  spendId?: string;
}

// Faithful replica of route.ts's POST body (post flag-gate + auth). Returns the same
// {status, body} the route would, and performs the SAME real credit effects.
async function simulateGenerateRoute(input: RouteInput): Promise<RouteResult> {
  const isAdmin = input.isAdmin;
  const isPaidPlan = input.plan === "PRO" || input.plan === "BUSINESS";
  const { canUseKieImages, chargeImages } = resolveKieImageAccess({
    managedKieOn: input.managedKieOn,
    creditsLive: input.creditsLive,
    isAdmin,
    isPaidPlan,
    isInternalTester: true,
  });

  // (3) access gate
  if (!canUseKieImages) return { status: 403, body: { error: "not_unlocked" } };

  // (4) model
  let model: string;
  const rawModel = input.model;
  if (rawModel === undefined || rawModel === null || rawModel === "") {
    model = DEFAULT_KIE_IMAGE_MODEL;
  } else if (isKieImageModel(rawModel)) {
    model = rawModel;
  } else {
    return { status: 400, body: { error: "invalid_model" } };
  }
  const costKey = costKeyForKieModel(model);
  if (!isAdmin && costKey === null) return { status: 403, body: { error: "model_not_available" } };

  // (5) prompt
  const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!rawPrompt) return { status: 400, body: { error: "empty_prompt" } };
  const prompt = capKiePrompt(rawPrompt);

  // (6) token resolution
  const kieKey = input.userKieKey;
  const kieToken: string | null = !input.managedKieOn
    ? kieKey
    : isAdmin
      ? input.kieEnvKey ?? kieKey
      : isPaidPlan
        ? input.kieEnvKey
        : kieKey;
  if (!kieToken) return { status: 400, body: { error: "missing_key", missingKey: "kie" } };
  const usesManagedKey = input.managedKieOn && !!input.kieEnvKey && kieToken === input.kieEnvKey;
  const guardImages = shouldGuardKieImages({ usesManagedKey, chargeImages });

  // (7) rate
  if (guardImages && !tryConsumeKieImageRate(input.userId)) {
    return { status: 429, body: { error: "rate_limited" } };
  }

  // (8) spend-before-generate
  const cost = costKey ? creditCostFor(costKey) : 0;
  const spendId = randomUUID();
  let charged = false;
  let spent: { fromGranted: number; fromPurchased: number; balanceAfter: number } | null = null;
  if (chargeImages) {
    const spend = await spendCredits(input.userId, cost, `${SPEND_PREFIX}${spendId}`);
    if (!spend.ok) {
      return { status: 402, body: { error: "insufficient_credits", need: cost, balance: spend.balanceAfter } };
    }
    charged = true;
    spent = { fromGranted: spend.fromGranted, fromPurchased: spend.fromPurchased, balanceAfter: spend.balanceAfter };
  }

  // (9) generate (mocked)
  if (!input.kieSucceeds) {
    if (charged && spent) {
      await refundCredits(input.userId, spent.fromGranted, spent.fromPurchased, `${REFUND_PREFIX}${spendId}`);
    }
    return { status: 502, body: { error: "generation_failed" }, spendId };
  }

  const balanceAfter = charged && spent ? spent.balanceAfter : (await getBalance(input.userId)).total;
  return {
    status: 200,
    body: { src: "/api/stocks/broll-ai-x.mp4", clipDuration: 5, creditsSpent: charged ? cost : 0, balanceAfter },
    spendId,
  };
}

const managed = { managedKieOn: true, creditsLive: true, kieEnvKey: "SERVER_KIE_KEY" };

async function main() {
  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();
  __resetKieImageRateForTest();

  assert(
    isKieAuthenticationError(new Error("kie.ai createTask error: Unauthorized – Authentication failed")),
    "production KIE credential rejection is classified as an authentication/configuration failure",
  );
  assert(
    !isKieAuthenticationError(new Error("kie.ai task timed out after 180000ms")),
    "provider timeout is not misclassified as an authentication failure",
  );
  const creditAuthFailure = interpretKieCreditResponse(200, { code: 401, msg: "Unauthorized" });
  assert(
    !creditAuthFailure.ok && creditAuthFailure.reason === "auth",
    "KIE credit endpoint HTTP 200 + payload code 401 is rejected as an invalid key",
  );
  const creditOk = interpretKieCreditResponse(200, { code: 200, data: 12.5 });
  assert(creditOk.ok && creditOk.credits === 12.5,
    "KIE credit endpoint payload code 200 is accepted with its balance");

  // ── 1. Access gate: FREE non-admin → 403, never charged ─────────────────────
  const free = await simulateGenerateRoute({
    userId: "u-free", isAdmin: false, plan: "FREE", ...managed, userKieKey: null,
    prompt: "a cat", model: undefined, kieSucceeds: true,
  });
  assert(free.status === 403 && free.body.error === "not_unlocked", "FREE non-admin → 403 not_unlocked");

  // Flag-off paid non-admin → still 403 (kiePaidUnlocked false).
  const flagOff = await simulateGenerateRoute({
    userId: "u-flagoff", isAdmin: false, plan: "PRO", managedKieOn: false, creditsLive: true, kieEnvKey: "SERVER_KIE_KEY",
    userKieKey: null, prompt: "a cat", model: undefined, kieSucceeds: true,
  });
  assert(flagOff.status === 403, "flag-off paid non-admin → 403 (managed gate closed)");

  // ── 2. Model resolution ─────────────────────────────────────────────────────
  const badModel = await simulateGenerateRoute({
    userId: "u-badmodel", isAdmin: false, plan: "PRO", ...managed, userKieKey: null,
    prompt: "a cat", model: "totally-not-a-model", kieSucceeds: true,
  });
  assert(badModel.status === 400 && badModel.body.error === "invalid_model", "unknown model → 400 invalid_model");

  await grantCredits("u-unpriced", 100, "grant");
  const unpriced = await simulateGenerateRoute({
    userId: "u-unpriced", isAdmin: false, plan: "PRO", ...managed, userKieKey: null,
    // nano-banana-pro is a valid kie model but admin-only (unpriced) → non-admin 403, never spends.
    prompt: "a cat", model: "nano-banana-pro", kieSucceeds: true,
  });
  assert(unpriced.status === 403 && unpriced.body.error === "model_not_available", "non-admin unpriced model → 403 model_not_available");
  assert((await getBalance("u-unpriced")).total === 100, "non-admin unpriced 403: balance untouched (never reached spend)");

  // Admin MAY use an unpriced/admin-only model, uncharged.
  const adminUnpriced = await simulateGenerateRoute({
    userId: "u-admin-unpriced", isAdmin: true, plan: "PRO", ...managed, userKieKey: null,
    prompt: "a cat", model: "nano-banana-pro", kieSucceeds: true,
  });
  assert(adminUnpriced.status === 200 && adminUnpriced.body.creditsSpent === 0, "admin unpriced model → 200, creditsSpent 0");

  // ── 3. Prompt validation + cap ──────────────────────────────────────────────
  for (const p of ["", "   ", 42, null, undefined, {}]) {
    const r = await simulateGenerateRoute({
      userId: "u-emptyprompt", isAdmin: true, plan: "PRO", ...managed, userKieKey: null,
      prompt: p, model: undefined, kieSucceeds: true,
    });
    assert(r.status === 400 && r.body.error === "empty_prompt", `empty/invalid prompt ${JSON.stringify(p)} → 400 empty_prompt`);
  }
  assert(capKiePrompt("a".repeat(5000)).length === 2000, "prompt cap: 5000 → 2000 chars");

  // ── 4. Missing key (managed non-admin but server has no KIE_API_KEY) → 400 ───
  const noServerKey = await simulateGenerateRoute({
    userId: "u-nokey", isAdmin: false, plan: "PRO", managedKieOn: true, creditsLive: true, kieEnvKey: null,
    userKieKey: null, prompt: "a cat", model: undefined, kieSucceeds: true,
  });
  assert(noServerKey.status === 400 && noServerKey.body.missingKey === "kie", "managed non-admin + no server key → 400 missing_key");

  // Admin with neither managed nor BYOK key (flag off) → 400 missing_key.
  const adminNoKey = await simulateGenerateRoute({
    userId: "u-admin-nokey", isAdmin: true, plan: "PRO", managedKieOn: false, creditsLive: true, kieEnvKey: null,
    userKieKey: null, prompt: "a cat", model: undefined, kieSucceeds: true,
  });
  assert(adminNoKey.status === 400 && adminNoKey.body.missingKey === "kie", "admin flag-off + no BYOK key → 400 missing_key");

  // ── 5. Default model = gpt-image-2 (3 credits) — happy path, granted-first ───
  __resetKieImageRateForTest();
  await grantCredits("u-happy", 5, "grant"); // granted 5
  await grantCredits("u-happy", 10, "purchase"); // purchased 10
  const happy = await simulateGenerateRoute({
    userId: "u-happy", isAdmin: false, plan: "PRO", ...managed, userKieKey: null,
    prompt: "  a serene mountain lake  ", model: undefined, kieSucceeds: true,
  });
  assert(happy.status === 200, "happy path → 200");
  assert(happy.body.creditsSpent === 3 && costKeyForKieModel(DEFAULT_KIE_IMAGE_MODEL) === "image-gpt-1k", "default model → gpt-image-2, creditsSpent 3");
  const hb = await getBalance("u-happy");
  assert(hb.granted === 2 && hb.purchased === 10, "granted-first: granted 5→2, purchased untouched 10");
  assert(happy.body.balanceAfter === 12, "balanceAfter reports authoritative post-spend total (12)");
  const spendRow = await prisma.creditLedger.findFirst({ where: { userId: "u-happy", kind: "spend" } });
  assert(typeof spendRow?.action === "string" && spendRow!.action!.startsWith(SPEND_PREFIX), `spend ledger action starts with "${SPEND_PREFIX}"`);
  assert(spendRow?.delta === -3, "spend ledger delta -3");

  // ── 6. Insufficient → 402 {need, balance}, NO spend row, balance unchanged ───
  __resetKieImageRateForTest();
  await grantCredits("u-poor", 1, "grant"); // 1 credit, gpt costs 3
  const poor = await simulateGenerateRoute({
    userId: "u-poor", isAdmin: false, plan: "PRO", ...managed, userKieKey: null,
    prompt: "a cat", model: "gpt-image-2-text-to-image", kieSucceeds: true,
  });
  assert(poor.status === 402 && poor.body.need === 3 && poor.body.balance === 1, "insufficient → 402 {need:3, balance:1}");
  assert((await getBalance("u-poor")).total === 1, "insufficient: balance unchanged (1)");
  assert((await prisma.creditLedger.count({ where: { userId: "u-poor", kind: "spend" } })) === 0, "insufficient: NO spend ledger row");

  // ── 7. Gen-failure after charge → 502 + exact-bucket refund (net zero) ───────
  __resetKieImageRateForTest();
  await grantCredits("u-refund", 2, "grant"); // granted 2
  await grantCredits("u-refund", 10, "purchase"); // purchased 10
  const before = await getBalance("u-refund");
  const failed = await simulateGenerateRoute({
    userId: "u-refund", isAdmin: false, plan: "BUSINESS", ...managed, userKieKey: null,
    // nano-banana-2 costs 4 → drains 2 granted + 2 purchased, spanning both buckets.
    prompt: "a cat", model: "nano-banana-2", kieSucceeds: false,
  });
  assert(failed.status === 502, "gen-failure → 502");
  const after = await getBalance("u-refund");
  assert(after.granted === before.granted && after.purchased === before.purchased, "refund restores EXACT buckets (granted 2, purchased 10)");
  const spendRowR = await prisma.creditLedger.findFirst({ where: { userId: "u-refund", kind: "spend" } });
  const refundRowR = await prisma.creditLedger.findFirst({ where: { userId: "u-refund", kind: "refund" } });
  assert(spendRowR?.action === `${SPEND_PREFIX}${failed.spendId}` && refundRowR?.action === `${REFUND_PREFIX}${failed.spendId}`, "spend + refund share the SAME id (matched action)");
  assert(refundRowR?.delta === 4, "refund ledger delta +4 (exact cost)");
  const spendCnt = await prisma.creditLedger.count({ where: { userId: "u-refund", kind: "spend" } });
  const refundCnt = await prisma.creditLedger.count({ where: { userId: "u-refund", kind: "refund" } });
  assert(spendCnt === 1 && refundCnt === 1, "exactly one spend + one refund row (net zero)");

  // ── 8. Admin never charged even with a balance + gen-failure = no refund row ─
  __resetKieImageRateForTest();
  await grantCredits("u-admin", 100, "grant");
  const adminOk = await simulateGenerateRoute({
    userId: "u-admin", isAdmin: true, plan: "PRO", ...managed, userKieKey: null,
    prompt: "a cat", model: "gpt-image-2-text-to-image", kieSucceeds: true,
  });
  assert(adminOk.status === 200 && adminOk.body.creditsSpent === 0, "admin success → 200, creditsSpent 0");
  assert((await getBalance("u-admin")).total === 100, "admin: balance unchanged (100)");
  const adminFail = await simulateGenerateRoute({
    userId: "u-admin", isAdmin: true, plan: "PRO", ...managed, userKieKey: null,
    prompt: "a cat", model: "gpt-image-2-text-to-image", kieSucceeds: false,
  });
  assert(adminFail.status === 502, "admin gen-failure → 502");
  assert((await prisma.creditLedger.count({ where: { userId: "u-admin" } })) === 1, "admin: only the grant row exists — no spend/refund ever written");

  // ── 9. Rate limit (429) after 60 managed generations in the window ──────────
  __resetKieImageRateForTest();
  await grantCredits("u-rate", 10_000, "grant");
  let ok200 = 0;
  let got429 = false;
  for (let i = 0; i < 61; i++) {
    const r = await simulateGenerateRoute({
      userId: "u-rate", isAdmin: false, plan: "PRO", ...managed, userKieKey: null,
      prompt: "a cat", model: "flux-2/pro-text-to-image", kieSucceeds: true,
    });
    if (r.status === 200) ok200++;
    if (r.status === 429) got429 = true;
  }
  assert(ok200 === 60 && got429, `rate: exactly 60 generations then 429 (got ${ok200} ok, 429=${got429})`);
  // The 61st was rate-limited BEFORE spend → no over-charge (60 spends only).
  assert((await prisma.creditLedger.count({ where: { userId: "u-rate", kind: "spend" } })) === 60, "rate: 61st blocked before spend (exactly 60 spend rows)");

  // ── 10. flux-2/pro priced correctly (2 credits) ─────────────────────────────
  assert(costKeyForKieModel("flux-2/pro-text-to-image") === "image-flux-1k" && creditCostFor("image-flux-1k") === 2, "flux-2/pro → 2 credits");

  await prisma.creditLedger.deleteMany();
  await prisma.creditBalance.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} BROLL-WINDOW-GEN CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
