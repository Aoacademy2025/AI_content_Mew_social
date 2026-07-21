import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { getCurrentUser } from "@/lib/clerk-auth";
import { decryptKey } from "@/lib/key-crypto";
import {
  DEFAULT_KIE_IMAGE_MODEL,
  isKieImageModel,
  type KieImageModel,
} from "@/lib/kie-client";
import {
  generateKieImageKenBurns,
  isValidMp4Path,
  normalizedMarkerPath,
  safeUnlink,
  KEN_BURNS_DURATION_SEC,
} from "@/lib/broll-asset-lib";
import {
  resolveKieImageAccess,
  shouldGuardKieImages,
  tryConsumeKieImageRate,
  capKiePrompt,
} from "@/lib/kie-image-guards";
import {
  spendCredits,
  refundCredits,
  getBalance,
  creditCostFor,
  costKeyForKieModel,
  ensureMonthlyGrant,
} from "@/lib/credits";
import { isInternalAiBetaEnabledFor, isInternalAiTester } from "@/lib/internal-ai-access";

// POST /api/videos/broll-window/generate — Phase 2 "สร้างด้วย AI" tab (Task 9).
// Regenerates ONE b-roll window as a fresh AI image (kie.ai text-to-image → Ken Burns
// motion clip, ~5s), metered to the user's credits on the managed key. The output is a
// locally-served `stocks/` mp4 the editor drops straight into the window's `bgVideos[]`
// entry. Internal AI testers receive the beta before NEXT_PUBLIC_BROLL_WINDOW_EDIT
// opens the scene editor publicly; the managed-image policy below remains authoritative.
//
// MONEY PATH — the access gate + token resolution + spend/refund mirror
// fetch-stock/route.ts's kie-image path EXACTLY (the single source of truth for who
// may reach kie and who is charged is src/lib/kie-image-guards.ts::resolveKieImageAccess).
// Security invariants:
//   • A crafted request body can never skip the spend: `chargeImages` is derived from
//     server env + the user's role/plan, never from the body. FREE/locked users never
//     reach generation (403). Non-admins are restricted to PRICED models (403 otherwise),
//     so `chargeImages` always implies cost > 0 — no free unpriced generation.
//   • Spend happens BEFORE generation; on ANY post-spend failure the EXACT buckets the
//     spend drained are refunded (never over-refunded — we pass back spend.fromGranted /
//     spend.fromPurchased) under a matched `broll-window-image-refund:<id>` action.
//   • The kie token (managed KIE_API_KEY or admin BYOK) is never logged.

export const runtime = "nodejs";
// kie poll (≤180s) + image download + Ken Burns encode can legitimately take minutes.
export const maxDuration = 600;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  const publicEnabled = process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1";
  if (!user) return NextResponse.json({ error: publicEnabled ? "Unauthorized" : "not_enabled" }, { status: publicEnabled ? 401 : 404 });
  if (!isInternalAiBetaEnabledFor(user, publicEnabled)) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as
    | { prompt?: unknown; model?: unknown }
    | null;

  // 3) Managed-kie access gate + metering decision — single source of truth
  //    (resolveKieImageAccess), identical to fetch-stock. Flag-off → kiePaidUnlocked
  //    false → admin-only; FREE non-admin never unlocked.
  const managedKieOn = process.env.MANAGED_KIE === "1";
  const creditsLive = process.env.CREDITS_LIVE === "1";
  const isAdmin = user.role === "ADMIN";
  const isPaidPlan = user.plan === "PRO" || user.plan === "BUSINESS";
  const kieEnvKey = process.env.KIE_API_KEY || null;
  const { canUseKieImages, chargeImages } = resolveKieImageAccess({
    managedKieOn,
    creditsLive,
    isAdmin,
    isPaidPlan,
    isInternalTester: isInternalAiTester(user),
  });

  // AI image gen is admin-always; paid users only when fully unlocked (managed + credits + paid).
  if (!canUseKieImages) {
    return NextResponse.json(
      { error: "not_unlocked", message: "สร้างรูป AI ยังไม่เปิดให้ใช้งาน — เร็วๆ นี้" },
      { status: 403 },
    );
  }

  // 4) Model: default when omitted; reject unknown (400). Non-admins are restricted to
  //    PRICED models server-side (403 otherwise) — we never coerce, so a paid user can't
  //    request an unpriced/admin-only model and get free generation.
  const rawModel = body?.model;
  let model: KieImageModel;
  if (rawModel === undefined || rawModel === null || rawModel === "") {
    model = DEFAULT_KIE_IMAGE_MODEL;
  } else if (isKieImageModel(rawModel)) {
    model = rawModel;
  } else {
    return NextResponse.json(
      { error: "invalid_model", message: "โมเดลรูปภาพไม่ถูกต้อง" },
      { status: 400 },
    );
  }
  const costKey = costKeyForKieModel(model);
  if (!isAdmin && costKey === null) {
    return NextResponse.json(
      { error: "model_not_available", message: "โมเดลนี้ยังไม่เปิดให้ใช้งาน" },
      { status: 403 },
    );
  }

  // 5) Prompt: required, non-empty; length-capped (defense-in-depth, same 2000-char cap
  //    fetch-stock applies on the managed path).
  const rawPrompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!rawPrompt) {
    return NextResponse.json(
      { error: "empty_prompt", message: "กรุณาระบุคำอธิบายรูปภาพที่ต้องการ" },
      { status: 400 },
    );
  }
  const prompt = capKiePrompt(rawPrompt);

  // 6) Token actually sent to kie.ai — mirrors fetch-stock's resolution order:
  //    flag-off → BYOK; admin → managed key when set else own BYOK; paid → managed key only.
  const kieKey = user.kieKey ? decryptKey(user.kieKey) : null;
  const kieToken: string | null = !managedKieOn
    ? kieKey
    : isAdmin
      ? kieEnvKey ?? kieKey
      : isPaidPlan
        ? kieEnvKey
        : kieKey;
  if (!kieToken) {
    return NextResponse.json(
      {
        error: "missing_key",
        missingKey: "kie",
        message: "ยังไม่ได้ตั้งค่า kie.ai API key — ไปที่ Settings > API Keys",
      },
      { status: 400 },
    );
  }
  // Does this request run on the shared server key? Guardrails (hourly rate) apply to any
  // managed-key generation — admins included (still uncharged) — so one client can't loop
  // the shared key. BYOK/admin-BYOK stays unguarded (byte-identical to fetch-stock).
  const usesManagedKey = managedKieOn && !!kieEnvKey && kieToken === kieEnvKey;
  const guardImages = shouldGuardKieImages({ usesManagedKey, chargeImages });

  // 7) Per-user hourly rate ceiling on managed-key generations. Runs AFTER validation so
  //    a rejected (400/403) request never consumes a rate slot, and BEFORE any spend.
  if (guardImages && !tryConsumeKieImageRate(user.id)) {
    return NextResponse.json(
      { error: "rate_limited", message: "สร้างรูป AI บ่อยเกินไปในชั่วโมงนี้ กรุณาลองใหม่ภายหลัง" },
      { status: 429 },
    );
  }

  // 8) Spend-before-generate (non-admin managed only). `cost` is > 0 here whenever
  //    chargeImages is true (non-admins were restricted to priced models above).
  const cost = costKey ? creditCostFor(costKey) : 0;
  const spendId = randomUUID();
  let charged = false;
  let spent: { fromGranted: number; fromPurchased: number; balanceAfter: number } | null = null;
  if (chargeImages) {
    // Ensure the paid user's current-period monthly allowance is granted before the first
    // spend (idempotent; itself CREDITS_LIVE-gated). Non-fatal.
    try {
      await ensureMonthlyGrant(user.id);
    } catch {
      /* non-fatal */
    }
    const spend = await spendCredits(user.id, cost, `broll-window-image:${spendId}`);
    if (!spend.ok) {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          need: cost,
          balance: spend.balanceAfter,
          message: "เครดิตไม่พอสำหรับสร้างรูป AI",
        },
        { status: 402 },
      );
    }
    charged = true;
    spent = {
      fromGranted: spend.fromGranted,
      fromPurchased: spend.fromPurchased,
      balanceAfter: spend.balanceAfter,
    };
  }

  // 9) Generate: kie text-to-image → 5s vertical Ken Burns clip, served from stocks/.
  //    Output name is 100% server-generated (Date.now()+randomUUID) — the /api/stocks/
  //    [filename] route only serves flat basenames, so nothing escapes the stocks dir.
  const stocksDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const outFile = `broll-ai-${stamp}.mp4`;
  const outPath = path.join(stocksDir, outFile);
  // Scratch input for the downloaded source image (Ken Burns reads it, writes a fresh mp4).
  const tmpImagePath = path.join(os.tmpdir(), `broll-ai-src-${stamp}.jpg`);

  try {
    const { duration } = await generateKieImageKenBurns(
      prompt,
      "broll-window",
      kieToken,
      model,
      tmpImagePath,
      outPath,
    );
    if (!isValidMp4Path(outPath)) {
      throw new Error("kie Ken Burns produced no usable output");
    }
    // Ken Burns output is already CFR/no-B-frame/yuv420p @30fps — mark it normalized so a
    // later render step skips a redundant (and possibly failing) re-encode. Mirrors
    // fetch-stock's AI path.
    try {
      fs.writeFileSync(normalizedMarkerPath(outPath), "");
    } catch {}

    const clipDuration = duration || KEN_BURNS_DURATION_SEC;
    // Charged path: authoritative post-spend balance. Uncharged (admin/BYOK): read current.
    const balanceAfter = charged && spent ? spent.balanceAfter : (await getBalance(user.id)).total;
    return NextResponse.json({
      src: `/api/stocks/${outFile}`,
      clipDuration,
      creditsSpent: charged ? cost : 0,
      balanceAfter,
    });
  } catch (e) {
    // Drop any partial output, then refund the EXACT buckets the spend drained (matched
    // action id). Refund failure is logged but still surfaces the 502 — never swallow the
    // gen error.
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    if (charged && spent) {
      try {
        await refundCredits(
          user.id,
          spent.fromGranted,
          spent.fromPurchased,
          `broll-window-image-refund:${spendId}`,
        );
      } catch (re) {
        console.error("[broll-window/generate] refund failed after gen error:", re);
      }
    }
    console.error("[broll-window/generate] generation failed:", e);
    return NextResponse.json(
      { error: "generation_failed", message: "สร้างรูป AI ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" },
      { status: 502 },
    );
  } finally {
    safeUnlink(tmpImagePath);
  }
}
