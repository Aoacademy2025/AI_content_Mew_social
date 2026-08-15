// Verifies task 2 of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   Every customer image generation runs on the RunPod Hero seam —
//   AutoMix "ai" slots + per-window regeneration — and kie.ai is admin-only.
//
// Run via: node --conditions=react-server --import tsx scripts/verify-automix-hero-migration.ts
// (the react-server condition makes the "server-only"-tagged modules exercised here —
// image-generation-provider.server.ts / video-hero-image.server.ts — resolve to their
// no-op stub instead of throwing; same pattern as verify-hero-image-price.ts.)
//
// DATABASE_URL points at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, and the RunPod HTTP layer is
// stubbed on globalThis.fetch, so nothing here touches dev.db or a real provider.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// ── Source-scan helpers (static guard) ────────────────────────────────────────

/** Range of the block that starts at the first "{" at/after `headerIndex`. */
function blockRange(source: string, headerIndex: number): [number, number] {
  const open = source.indexOf("{", headerIndex);
  if (open < 0) throw new Error("block opener not found");
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return [open, i];
    }
  }
  throw new Error("unbalanced block");
}

function allIndexesOf(source: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) return out;
    out.push(at);
    from = at + needle.length;
  }
}

async function main() {
  // ── 0. Throwaway SQLite + fake-but-valid RunPod custom route ───────────────
  const dbDir = mkdtempSync(join(tmpdir(), "automix-hero-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const workflowDir = mkdtempSync(join(tmpdir(), "automix-hero-workflow-"));
  const workflowPath = join(workflowDir, "z-image-turbo.json");
  writeFileSync(
    workflowPath,
    JSON.stringify({
      input: {
        prompt: "{{PROMPT}}",
        negative_prompt: "{{NEGATIVE_PROMPT}}",
        width: "{{WIDTH}}",
        height: "{{HEIGHT}}",
        seed: "{{SEED}}",
      },
    }),
    "utf8",
  );
  process.env.AI_STUDIO_IMAGE_ENABLED = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.RUNPOD_API_KEY = "verify-automix-hero-test-key";
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "custom";
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = "verify-automix-hero-endpoint";
  process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH = workflowPath;
  delete process.env.AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS;

  // ── 1. Planner ↔ estimate parity (no credit-quote drift) ──────────────────
  console.log("\n[1] AutoMix planner ↔ Render Receipt estimate");
  const {
    planAutoMixSources,
    clampAutoMixAiSlots,
    distributeAutoMixAiSlots,
    parseAutoMixReceiptImageCeiling,
  } = await import("../src/lib/automix-plan");
  const { HERO_AI_IMAGE_CREDITS } = await import("../src/lib/credit-costs");
  const { disclosedAutoMixAiImageCount, estimateAutoMixAiImageCount, estimatePresetCredits } = await import(
    "../src/app/(dashboard)/video-editor/_v2/estimate"
  );
  const { buildReceipt } = await import("../src/app/(dashboard)/video-editor/_v2/receipt");

  const recommended = { video: 3, photo: 2, ai: 1 };
  const aiForward = { video: 1, photo: 1, ai: 2 };
  const plannerAi = (pieces: number, weights: typeof recommended) =>
    planAutoMixSources(pieces, weights).filter((source) => source === "ai").length;

  check("HERO_AI_IMAGE_CREDITS === 2", (HERO_AI_IMAGE_CREDITS as number) === 2);
  check(
    "the public AutoMix receipt ceiling accepts only exact integer image counts",
    parseAutoMixReceiptImageCeiling(0) === 0
      && parseAutoMixReceiptImageCeiling(60) === 60
      && [undefined, null, "3", -1, 1.5, 61, Number.NaN]
        .every((value) => parseAutoMixReceiptImageCeiling(value) === null),
  );
  check(
    "planAutoMixSources(15, 3:2:1) yields exactly 3 ai slots",
    plannerAi(15, recommended) === 3,
    `got ${plannerAi(15, recommended)}`,
  );
  // 60s at the 4s window knob = 15 pieces — the same 15 the planner just planned.
  const estCount60 = estimateAutoMixAiImageCount(60, recommended, 4);
  check(
    "estimateAutoMixAiImageCount(60s, 3:2:1) === planner count (3)",
    estCount60 === 3 && estCount60 === plannerAi(15, recommended),
    `estimate=${estCount60}`,
  );
  check(
    "estimatePresetCredits(60s, 3:2:1) === 3 × HERO_AI_IMAGE_CREDITS === 6",
    estimatePresetCredits(60, recommended, HERO_AI_IMAGE_CREDITS, 4) === 6,
    `got ${estimatePresetCredits(60, recommended, HERO_AI_IMAGE_CREDITS, 4)}`,
  );
  // Regression: the old naive share formula (ceil(windows × ai/total)) reported 8
  // images for the AI-forward preset where the planner actually generates 7.
  const naiveAiForward = Math.ceil(15 * (aiForward.ai / (aiForward.video + aiForward.photo + aiForward.ai)));
  check(
    "AI-forward preset (1:1:2) estimate follows the planner (7), not the naive share (8)",
    estimateAutoMixAiImageCount(60, aiForward, 4) === plannerAi(15, aiForward)
      && estimateAutoMixAiImageCount(60, aiForward, 4) === 7
      && naiveAiForward === 8,
    `estimate=${estimateAutoMixAiImageCount(60, aiForward, 4)} planner=${plannerAi(15, aiForward)} naive=${naiveAiForward}`,
  );
  for (const seconds of [8, 21, 45, 60, 90, 180]) {
    for (const weights of [recommended, aiForward, { video: 3, photo: 2, ai: 0 }]) {
      const windows = Math.ceil(seconds / 4);
      const estimated = estimateAutoMixAiImageCount(seconds, weights, 4);
      const planned = weights.ai > 0 ? plannerAi(windows, weights) : 0;
      check(
        `no drift at ${seconds}s / ${weights.video}:${weights.photo}:${weights.ai} (${estimated} images)`,
        estimated === planned,
        `estimate=${estimated} planner=${planned}`,
      );
    }
  }
  const receipt = buildReceipt({
    estSec: 60,
    remainingMinutes: 10,
    totalMinutes: 10,
    usesAi: true,
    presetWeights: recommended,
    perImageCredits: HERO_AI_IMAGE_CREDITS,
    creditBalance: 100,
    minuteCreditRate: 2,
    hasAvatar: false,
  });
  check(
    "Render Receipt prices AutoMix AI slots at the Hero price (60s, 3:2:1 → 6 credits)",
    receipt.estCredits === 6,
    `got ${receipt.estCredits}`,
  );

  // ── 1b. Disclosure ceiling (maxAiImages): quoted count caps the charge ─────
  // The receipt plans with the RAW preset weights; the server plans with the source
  // families it can actually serve, which can raise the AI share (worst case: no
  // photo provider + video off → every piece becomes AI). The clamp is what keeps
  // the charge inside the quote the user approved.
  const disclosedManual = disclosedAutoMixAiImageCount(0, aiForward, 15);
  const disclosedAuto = disclosedAutoMixAiImageCount(60, aiForward, 0, 4);
  check(
    "disclosedAutoMixAiImageCount: manual clip count plans from that exact count",
    disclosedManual === plannerAi(15, aiForward) && disclosedManual === 7,
    `got ${disclosedManual}`,
  );
  check(
    "disclosedAutoMixAiImageCount: auto falls back to the duration estimate (same 7)",
    disclosedAuto === 7,
    `got ${disclosedAuto}`,
  );
  // Server-side worst case: every family but AI is unavailable → planner says 15 AI.
  const serverSidePlan = planAutoMixSources(15, { video: 0, photo: 0, ai: 1 });
  const serverAiSlots = serverSidePlan
    .map((source, index) => (source === "ai" ? index : -1))
    .filter((index) => index >= 0);
  check(
    "unclamped worst case would over-charge (15 images = 30 credits vs a 14-credit quote)",
    serverAiSlots.length === 15 && serverAiSlots.length * HERO_AI_IMAGE_CREDITS === 30,
    `${serverAiSlots.length} slots`,
  );
  const clamped = clampAutoMixAiSlots(serverAiSlots, disclosedAuto);
  check(
    "clampAutoMixAiSlots honors maxAiImages: charge never exceeds the disclosed quote",
    clamped.kept.length === disclosedAuto
      && clamped.demoted.length === 15 - disclosedAuto
      && clamped.kept.length * HERO_AI_IMAGE_CREDITS === disclosedAuto * HERO_AI_IMAGE_CREDITS,
    `kept=${clamped.kept.length} demoted=${clamped.demoted.length}`,
  );
  check(
    "clampAutoMixAiSlots keeps the earliest slots and never reorders",
    clamped.kept.every((value, index) => value === serverAiSlots[index])
      && clamped.demoted.every((value, index) => value === serverAiSlots[disclosedAuto + index]),
  );
  check(
    "clampAutoMixAiSlots with no ceiling demotes nothing",
    clampAutoMixAiSlots(serverAiSlots, null).demoted.length === 0
      && clampAutoMixAiSlots(serverAiSlots, null).kept.length === 15,
  );
  check(
    "clampAutoMixAiSlots(…, 0) demotes every paid slot",
    clampAutoMixAiSlots(serverAiSlots, 0).kept.length === 0
      && clampAutoMixAiSlots(serverAiSlots, 0).demoted.length === 15,
  );
  const distributed = distributeAutoMixAiSlots([0, 2, 4, 6, 8], 2);
  check(
    "allowance density keeps new AI work distributed across the timeline",
    JSON.stringify(distributed.kept) === JSON.stringify([2, 6])
      && JSON.stringify(distributed.demoted) === JSON.stringify([0, 4, 8]),
    JSON.stringify(distributed),
  );

  // ── 2. RunPod stub: every provider call is intercepted ────────────────────
  console.log("\n[2] Hero seam: AutoMix slot reservations, charges and refunds");
  type StubMode = "fail" | "queue";
  let stubMode: StubMode = "fail";
  const submittedPayloads: string[] = [];
  let submitCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://api.runpod.ai/v2/")) {
      throw new Error(`unexpected outbound request in verify script: ${url}`);
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/run")) {
      submitCount += 1;
      submittedPayloads.push(String(init?.body ?? ""));
      return json({ id: `stub-provider-job-${submitCount}`, status: "IN_QUEUE" });
    }
    if (url.includes("/status/")) {
      return stubMode === "fail"
        ? json({ status: "FAILED", error: "CUDA out of memory" })
        : json({ status: "IN_QUEUE", delayTime: 10 });
    }
    if (url.includes("/cancel/")) return json({ status: "CANCELLED" });
    if (url.endsWith("/health")) return json({ jobs: { inQueue: 0, inProgress: 0 }, workers: { idle: 0, running: 0 } });
    throw new Error(`unstubbed RunPod operation: ${url}`);
  }) as typeof fetch;

  const { prisma } = await import("../src/lib/prisma");
  const { generateHeroImageForVideo, HeroImageGenerationError, describeHeroImageOffer } = await import(
    "../src/lib/video-hero-image.server"
  );
  const offer = describeHeroImageOffer();
  check(
    "hero offer is live on the verified custom route at 2 credits",
    offer.available && offer.providerRoute === "runpod-custom" && offer.quote.credits === 2,
  );

  // Active paid evidence selects the existing shared Credit wallet. Starter
  // allowance behavior has its own regression suite.
  const user = await prisma.user.create({
    data: {
      name: "AutoMix Hero Verify",
      email: "automix-hero-verify@example.invalid",
      plan: "PRO",
      subStatus: "active",
    },
  });
  const videoJobId = "video-job-automix-verify";
  const seedBalance = async (granted: number, purchased: number) => {
    await prisma.creditBalance.upsert({
      where: { userId: user.id },
      create: { userId: user.id, granted, purchased, grantedResetAt: new Date() },
      update: { granted, purchased, grantedResetAt: new Date() },
    });
  };
  const balanceNow = async () => {
    const row = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: user.id } });
    return row.granted + row.purchased;
  };

  // Three planned AI slots, 2cr each = 6 credits. Balance is exactly 6.
  await seedBalance(4, 2);
  const automixKeys = [0, 1, 2].map((sourceIndex) => `video:${videoJobId}:automix:${sourceIndex}`);
  for (const idempotencyKey of automixKeys) {
    let thrown: unknown = null;
    try {
      await generateHeroImageForVideo({
        userId: user.id,
        plan: "PRO",
        prompt: "thai street food market at golden hour",
        idempotencyKey,
        videoJobId,
        sceneIndex: Number(idempotencyKey.split(":").pop()),
      });
    } catch (error) {
      thrown = error;
    }
    check(
      `AutoMix slot ${idempotencyKey} fails closed on an injected provider failure`,
      thrown instanceof HeroImageGenerationError && (thrown as HeroImageGenerationError).code === "PROVIDER_FAILED",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  }

  const automixJobs = await prisma.aiGenerationJob.findMany({
    where: { userId: user.id, kind: "image" },
    orderBy: { createdAt: "asc" },
  });
  check("3 durable AutoMix image jobs were created", automixJobs.length === 3, `got ${automixJobs.length}`);
  check(
    "each AutoMix job reserved exactly 2 credits on the custom route",
    automixJobs.every((job) => job.creditCost === 2 && job.providerRoute === "runpod-custom" && job.model === "z-image-turbo"),
  );
  check(
    "AutoMix keys use the :automix: namespace (never the hero-mode :scene: namespace)",
    automixJobs.every((job) => (job.idempotencyKey ?? "").startsWith(`video:${videoJobId}:automix:`))
      && new Set(automixJobs.map((job) => job.idempotencyKey)).size === 3,
    automixJobs.map((job) => job.idempotencyKey).join(", "),
  );
  check(
    "every failed AutoMix reservation was refunded exactly once",
    automixJobs.every((job) => job.chargeState === "refunded" && job.status === "failed"),
  );
  check("balance is fully restored after the failed AutoMix batch (6)", (await balanceNow()) === 6);
  const refundLedger = await prisma.creditLedger.findMany({ where: { userId: user.id, kind: "refund" } });
  check(
    "refund ledger carries one 2-credit row per failed AutoMix slot",
    refundLedger.length === 3 && refundLedger.every((row) => row.delta === 2),
  );

  // The hero-mode namespace must be able to coexist with :automix: for the SAME video.
  let sceneError: unknown = null;
  try {
    await generateHeroImageForVideo({
      userId: user.id,
      plan: "PRO",
      prompt: "same video, hero-mode scene 0",
      idempotencyKey: `video:${videoJobId}:scene:0`,
      videoJobId,
      sceneIndex: 0,
    });
  } catch (error) {
    sceneError = error;
  }
  check(
    "hero-mode :scene:0 and AutoMix :automix:0 of the same video are separate jobs",
    sceneError instanceof HeroImageGenerationError
      && (await prisma.aiGenerationJob.count({ where: { userId: user.id } })) === 4,
  );

  // No silent overspend: a balance that funds only two slots cannot reserve a third.
  // Exercised on the reservation helper the seam itself calls, so the outstanding
  // reservations stay held instead of being refunded by the injected failure.
  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });
  await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
  await seedBalance(0, 5);
  const { createReservedImageJob } = await import("../src/lib/ai-generation-jobs.server");
  const budgetOutcomes: string[] = [];
  for (const sourceIndex of [10, 11, 12]) {
    const reserved = await createReservedImageJob({
      userId: user.id,
      model: "z-image-turbo",
      inputPreview: "budget probe",
      inputJson: "{}",
      creditCost: offer.quote.credits,
      quoteVersion: offer.quote.version,
      costBudgetUsdMicros: offer.quote.costBudgetUsdMicros,
      provider: offer.provider,
      providerModel: offer.providerModel,
      providerRoute: offer.providerRoute,
      providerEndpoint: offer.providerEndpoint,
      estimatedCostUsdMicros: offer.quote.estimatedProviderCostUsdMicros,
      idempotencyKey: `video:${videoJobId}:automix:${sourceIndex}`,
      mediaExpiresAt: new Date(Date.now() + 60_000),
    });
    budgetOutcomes.push(reserved.ok ? "reserved" : reserved.reason);
  }
  check(
    "a 5-credit balance reserves exactly two 2-credit AutoMix slots; the third is refused — no partial/silent spend",
    budgetOutcomes[0] === "reserved"
      && budgetOutcomes[1] === "reserved"
      && budgetOutcomes[2] === "insufficient"
      && (await balanceNow()) === 1,
    `${budgetOutcomes.join(",")} balance=${await balanceNow()}`,
  );

  // ── 3. Per-window regeneration: one charge per attempt, refunded on failure ──
  console.log("\n[3] Per-window regeneration charges and refunds per attempt");
  const { parseHeroBrollWindowRequest } = await import("../src/lib/broll-window-hero");
  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });
  await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
  await seedBalance(0, 6);

  const windowRequestIds = [
    "3f1d6a52-6f1e-4a6e-8d47-4d0a2f6f9d11",
    "9c2b4e77-2a0c-4d5e-9c31-7b6a5c4d3e22",
  ];
  const windowKeys: string[] = [];
  for (const requestId of windowRequestIds) {
    const parsed = parseHeroBrollWindowRequest({
      prompt: "thai coffee shop in morning light",
      requestId,
      videoJobId,
      sceneIndex: 4,
      durationSec: 6,
      visualStyle: "cinematic",
    });
    if (!parsed.ok) throw new Error(`per-window contract rejected a valid request: ${parsed.error}`);
    windowKeys.push(parsed.value.idempotencyKey);
    let thrown: unknown = null;
    try {
      await generateHeroImageForVideo({
        userId: user.id,
        plan: "PRO",
        // The browser contract intentionally strips raw prompts in Brand
        // Visual V1. This lower-level funding regression supplies a trusted
        // server-side prompt directly.
        prompt: "thai coffee shop in morning light",
        idempotencyKey: parsed.value.idempotencyKey,
        videoJobId: parsed.value.videoJobId,
        sceneIndex: parsed.value.sceneIndex,
        style: parsed.value.heroStyle,
      });
    } catch (error) {
      thrown = error;
    }
    check(
      `per-window regen ${requestId.slice(0, 8)} fails closed on provider failure`,
      thrown instanceof HeroImageGenerationError,
    );
  }
  check(
    "each regeneration attempt of the SAME window derives a distinct idempotency key from its requestId",
    windowKeys.length === 2
      && windowKeys[0] !== windowKeys[1]
      && windowKeys.every((key) => key.startsWith(`broll-window:${videoJobId}:scene:4:request:`)),
    windowKeys.join(", "),
  );
  const windowJobs = await prisma.aiGenerationJob.findMany({ where: { userId: user.id, kind: "image" } });
  check(
    "each regen attempt reserved its own 2 credits and was refunded on failure",
    windowJobs.length === 2
      && windowJobs.every((job) => job.creditCost === 2 && job.chargeState === "refunded"),
    `${windowJobs.length} jobs`,
  );
  check("balance restored to 6 after both failed regenerations", (await balanceNow()) === 6);

  // A retry that reuses the SAME requestId must NOT reserve twice.
  const repeat = parseHeroBrollWindowRequest({
    prompt: "thai coffee shop in morning light",
    requestId: windowRequestIds[0],
    videoJobId,
    sceneIndex: 4,
    durationSec: 6,
    visualStyle: "cinematic",
  });
  check(
    "a same-requestId retry maps back to the same key (no double charge on recovery)",
    repeat.ok && repeat.value.idempotencyKey === windowKeys[0],
  );

  // ── 4. Video-failure compensation covers AutoMix images too ────────────────
  console.log("\n[4] Video-failure compensation covers the :automix: namespace");
  const { refundSettledVideoImageBatch } = await import("../src/lib/video-image-batch-settlement");
  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });
  await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
  await seedBalance(0, 0);
  const settledSeed = [
    { key: `video:${videoJobId}:scene:0`, credits: 2 },
    { key: `video:${videoJobId}:automix:3`, credits: 2 },
    { key: `broll-window:${videoJobId}:scene:4:request:${windowRequestIds[0]}`, credits: 2 },
    // AI Studio keys are caller-minted. Server-side `studio:` namespacing is what stops
    // a caller from minting `video:<jobId>:…` and getting a free refund from a sweep.
    { key: `studio:video:${videoJobId}:scene:0`, credits: 2 },
  ];
  for (const seed of settledSeed) {
    await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-custom",
        status: "completed",
        chargeState: "settled",
        creditCost: seed.credits,
        creditsFromGranted: 0,
        creditsFromPurchased: seed.credits,
        idempotencyKey: seed.key,
        outputUrl: "/api/renders/stub.png",
      },
    });
  }
  const compensation = await refundSettledVideoImageBatch({
    userId: user.id,
    videoJobId,
    reason: "verify_automix_hero",
  });
  check(
    "a failed video refunds BOTH its hero-mode scenes and its AutoMix AI slots (2 jobs, 4 credits)",
    compensation.refundedJobs === 2 && compensation.refundedCredits === 4,
    JSON.stringify(compensation),
  );
  const untouchedWindowJob = await prisma.aiGenerationJob.findFirstOrThrow({
    where: { userId: user.id, idempotencyKey: { startsWith: "broll-window:" } },
  });
  check(
    "a deliberate per-window purchase is NOT swept by the video-failure batch refund",
    untouchedWindowJob.chargeState === "settled",
  );
  const untouchedStudioJob = await prisma.aiGenerationJob.findFirstOrThrow({
    where: { userId: user.id, idempotencyKey: { startsWith: "studio:" } },
  });
  check(
    "an AI Studio job whose caller-minted key embeds `video:<id>:` is NOT swept",
    untouchedStudioJob.chargeState === "settled",
  );
  const secondPass = await refundSettledVideoImageBatch({
    userId: user.id,
    videoJobId,
    reason: "verify_automix_hero",
  });
  check("batch compensation is idempotent (second pass refunds nothing)", secondPass.refundedJobs === 0);

  // ── 4b. The cost guard really can throw — the preflight must survive it ────
  // getRunpodImageCostSnapshot reads env + the billing ledger; a missing endpoint or a
  // transient DB error rejects. AutoMix must degrade to free slots, never 500 the whole
  // fetch (which would also lose the free video/photo b-roll).
  console.log("\n[4b] Cost guard failure is survivable");
  const { getRunpodImageCostSnapshot } = await import("../src/lib/runpod-image-cost.server");
  const savedEndpointId = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID;
  delete process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID;
  let costGuardThrew = false;
  try {
    await getRunpodImageCostSnapshot({ endpointId: "" });
  } catch {
    costGuardThrew = true;
  }
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = savedEndpointId;
  check(
    "getRunpodImageCostSnapshot can reject (so an unguarded await would 500 the route)",
    costGuardThrew,
  );

  globalThis.fetch = realFetch;
  await prisma.$disconnect();

  // ── 5. Static guard: kie image entry points are admin-only ────────────────
  console.log("\n[5] Static guard: no non-admin path can construct a kie image request");
  const fetchStock = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const brollGenerate = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
  const videoJobs = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");

  // Every function that actually talks to kie.ai for an image.
  const KIE_IMAGE_ENTRY_POINTS = [
    "generateKieImageKenBurns(",
    "kieCreateTask(",
    "kiePollResult(",
    "buildKieImageInput(",
  ];

  check(
    "per-window regeneration never references a kie image entry point",
    KIE_IMAGE_ENTRY_POINTS.every((entry) => !brollGenerate.includes(entry))
      && !brollGenerate.includes("KIE_API_KEY")
      && brollGenerate.includes("generateHeroImageForVideo"),
  );
  check(
    "fetch-stock resolves the direct kie mode admin-only",
    /const canUseKieImage = [^\n;]*isAdmin/.test(fetchStock)
      && /useKieImage && !useHeroRunpodImage && \(!canUseKieImages \|\| !isAdmin\)/.test(fetchStock),
  );
  check(
    "fetch-stock resolves the AutoMix kie slot admin-only and by explicit opt-in",
    /const autoMixKieAdminOnly = [\s\S]{0,240}?isAdmin[\s\S]{0,240}?imageEngine === "kie"/.test(fetchStock)
      && fetchStock.includes('const canUseKieFallback = autoMixAiEngine === "kie";'),
  );
  check(
    "AutoMix AI slots default to the Hero RunPod seam with the :automix: namespace",
    fetchStock.includes('idempotencyKey: `video:${videoJobId}:automix:${ki}`')
      && /const autoMixAiEngine: "runpod" \| "kie" \| null = autoMixKieAdminOnly[\s\S]{0,160}canUseHeroAutoMixAi/.test(fetchStock),
  );
  check(
    "AutoMix AI eligibility no longer depends on kie access or a kie token",
    /canUseHeroAutoMixAi = Boolean\([\s\S]{0,400}?heroAiEligible[\s\S]{0,200}?\)/.test(fetchStock)
      && !/canUseHeroAutoMixAi = Boolean\([\s\S]{0,400}?(canUseKieImages|kieToken|managedKieOn)/.test(fetchStock),
  );
  check(
    "AutoMix credit preflight runs before any reservation and degrades instead of overspending",
    fetchStock.includes("Math.floor(balance.total / heroAutoMixCreditCost)")
      && fetchStock.includes("heroAutoMixDegradeReason"),
  );
  check(
    "AutoMix reuses unchanged current Visual Beats before provider/rate/funding work",
    fetchStock.includes("autoMixReusableByScene")
      && fetchStock.includes("reusableVisualBeatAssetsForVideoJob")
      && fetchStock.includes("const retained = autoMixReusableByScene.get(ki)")
      && fetchStock.includes('step: "fetchStock.autoMixHero"')
      && fetchStock.includes("aiSlotsNeedingGeneration().length"),
  );
  check(
    "AutoMix mode follows the Hero rollout gate in job creation",
    // Task 4 (public-launch plan gate) widened this call site from the beta-only
    // isHeroAiBetaUser to isHeroAiImageEligible, which still admits the beta
    // cohort unconditionally and additionally opens to PRO/BUSINESS/trial once
    // HERO_AI_IMAGE_PUBLIC=1 — see internal-ai-access.ts.
    /requestedSource === "auto-mix"[\s\S]{0,400}?isHeroAiImageEligible\(user\)/.test(videoJobs),
  );

  // The cost-guard await MUST sit inside a try whose catch continues without AI.
  const costGuardAt = fetchStock.indexOf("runpodCost = await getRunpodImageCostSnapshot({");
  let costGuardWrapped = false;
  if (costGuardAt >= 0) {
    const tryAt = fetchStock.lastIndexOf("try {", costGuardAt);
    if (tryAt >= 0) {
      const [, tryClose] = blockRange(fetchStock, tryAt);
      const tail = fetchStock.slice(tryClose, tryClose + 400);
      costGuardWrapped = costGuardAt < tryClose
        && /^\s*}?\s*catch/.test(tail)
        && !/throw/.test(tail.slice(0, tail.indexOf("}\n") + 1));
    }
  }
  check(
    "the AutoMix cost-guard call is wrapped in try/catch and never rethrows (no 500 on a DB blip)",
    costGuardWrapped && fetchStock.includes("heroAutoMixCostGuardError"),
  );
  check(
    "the disclosed AI-image ceiling is enforced after zero-cost reusable assets are removed",
    /maxAiImages !== null && aiSlotsNeedingGeneration\(\)\.length > maxAiImages/.test(fetchStock)
      && fetchStock.includes("distributeAutoMixAiSlots(candidates, keep)")
      && fetchStock.includes('demoteGeneratedAiSlotsTo(maxAiImages, "omit")')
      && fetchStock.includes("const maxAiImages = parseAutoMixReceiptImageCeiling(maxAiImagesRaw)"),
  );
  check(
    "Starter allowance shortfall reduces AI density instead of adding hidden Stock slots",
    fetchStock.includes('const densityReduction = degradeReason === "starter_allowance_density"')
      && fetchStock.includes('densityReduction ? "omit" : "photo"')
      && /if \(replacement === "photo"\) autoMixPhotoSlots\.add\(sceneIndex\)/.test(fetchStock),
  );
  check(
    "a provider-side degrade tells the client 'provider', not 'credits'",
    /aiSkippedReason = "provider"/.test(fetchStock)
      && fetchStock.includes('degradeReason === "provider_circuit_open" || degradeReason === "provider_cost_guard"'),
  );
  check(
    "public Hero failures expose product-level codes while raw provider codes stay telemetry-only",
    fetchStock.includes('code: "HERO_IMAGE_COST_GUARD"')
      && !fetchStock.includes('code: "RUNPOD_COST_GUARD"')
      && fetchStock.includes("const publicFailureCode =")
      && fetchStock.includes("code: publicFailureCode,"),
  );
  check(
    "public AutoMix fails closed when the Render Receipt ceiling is missing or malformed",
    videoJobs.includes("parseAutoMixReceiptImageCeiling(body.maxAiImages)")
      && videoJobs.includes('error: "render_receipt_required"')
      && videoJobs.includes("autoMixRequestsAi && !isAdmin && maxAiImages === null")
      && fetchStock.includes("download && !isAdmin && maxAiImages === null")
      && fetchStock.includes('error: "render_receipt_required"'),
  );

  // Output-file namespaces: AutoMix hero slots must not share hero-only mode's id space.
  const offsetOf = (name: string): number | null => {
    const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(fetchStock);
    return match ? Number(match[1].replace(/_/g, "")) : null;
  };
  const heroOffset = offsetOf("HERO_RUNPOD_ID_OFFSET");
  const automixOffset = offsetOf("AUTOMIX_RUNPOD_ID_OFFSET");
  const kieOffset = offsetOf("KIE_ID_OFFSET");
  check(
    "AutoMix hero outputs use their own id offset, far from hero-mode and kie",
    automixOffset === 2_200_000_000
      && heroOffset === 2_100_000_000
      && kieOffset === 2_000_000_000
      && Math.abs(automixOffset! - heroOffset!) >= 1_000
      && Math.abs(automixOffset! - kieOffset!) >= 1_000,
    `hero=${heroOffset} automix=${automixOffset} kie=${kieOffset}`,
  );
  check(
    "the AutoMix hero block writes files under AUTOMIX_RUNPOD_ID_OFFSET",
    fetchStock.includes("const id = AUTOMIX_RUNPOD_ID_OFFSET + slot;")
      && fetchStock.includes("const id = HERO_RUNPOD_ID_OFFSET + sourceIndex;"),
  );

  // AI Studio keys are namespaced server-side so they can never enter a video sweep.
  const studioImages = readFileSync("src/app/api/ai-studio/images/route.ts", "utf8");
  check(
    "AI Studio prefixes caller-minted idempotency keys with `studio:`",
    studioImages.includes("const storedIdempotencyKey = `studio:${idempotencyKey}`;")
      && studioImages.includes("idempotencyKey: storedIdempotencyKey,")
      && /\{8,113\}/.test(studioImages),
  );

  // Containment: every kie image call in fetch-stock sits inside an admin-gated block.
  const adminGatedBlocks: Array<[number, number]> = [];
  for (const header of ["if (canUseKieImage) {", 'if (kind === "ai" && canUseKieFallback) {']) {
    const at = fetchStock.indexOf(header);
    if (at < 0) {
      failures += 1;
      console.error(`  FAIL  expected admin-gated kie block header not found: ${header}`);
      continue;
    }
    adminGatedBlocks.push(blockRange(fetchStock, at));
  }
  const strayKieCalls: string[] = [];
  let kieCallSites = 0;
  for (const entry of KIE_IMAGE_ENTRY_POINTS) {
    for (const at of allIndexesOf(fetchStock, entry)) {
      // Skip the import statement / type positions — only real call sites matter.
      const lineStart = fetchStock.lastIndexOf("\n", at) + 1;
      const line = fetchStock.slice(lineStart, fetchStock.indexOf("\n", at));
      if (line.trimStart().startsWith("//") || line.includes("import ")) continue;
      kieCallSites += 1;
      const contained = adminGatedBlocks.some(([open, close]) => at > open && at < close);
      if (!contained) strayKieCalls.push(`${entry} @ ${line.trim().slice(0, 90)}`);
    }
  }
  // The count guard makes this test fail loudly if kie is rewired or renamed rather
  // than passing vacuously: kie is PAUSED behind admin, not deleted (ADR 0004).
  check(
    `every kie image call in fetch-stock is inside an admin-gated block (${kieCallSites} call sites)`,
    strayKieCalls.length === 0 && kieCallSites >= 3,
    strayKieCalls.join(" | ") || `only ${kieCallSites} call sites found`,
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
