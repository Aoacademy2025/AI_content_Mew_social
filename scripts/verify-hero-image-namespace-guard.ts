// Verifies the P0-6 security fix of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   only the server-side render pipeline may mint a paid Hero image reservation into
//   the REFUNDABLE `video:<videoJobId>:` idempotency namespace.
//
// The hole this closes: /api/videos/fetch-stock authenticates with getCurrentUser(),
// which a plain logged-in user satisfies. It accepted `videoJobId` from the request body
// with only a regex check, so a browser could reserve `video:<id>:scene:<i>` /
// `video:<id>:automix:<i>`, receive the generated image URLs in the HTTP response, then
// deliberately fail that same VideoJob — refundSettledVideoImageBatch sweeps every
// settled job under the `video:<id>:` prefix, handing the credits back while the images
// stay delivered. Ownership validation alone does NOT fix it (the attacker uses their
// OWN job), so provenance is the invariant.
//
// Run via: node --conditions=react-server --import tsx scripts/verify-hero-image-namespace-guard.ts
// (the react-server condition makes "server-only"-tagged modules resolve to their no-op
// stub instead of throwing; same pattern as verify-automix-hero-migration.ts.)
//
// DATABASE_URL points at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, so dev.db is never touched.

import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every .ts/.tsx file under a directory (source-scan guard). */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

async function main() {
  // ── 0. Throwaway SQLite ───────────────────────────────────────────────────
  const dbDir = mkdtempSync(join(tmpdir(), "hero-namespace-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. The provenance signal itself (server-only shared secret)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[1] Service credential — the only thing a browser cannot forge");
  const { isValidServiceCredential } = await import("../src/lib/mcp/service-actor");
  const SECRET = "s3cret-pipeline-token-value";

  check(
    "no env secret configured → nothing is ever accepted as pipeline provenance",
    isValidServiceCredential(undefined, SECRET, "user-1") === false,
  );
  check(
    "a browser sending NO secret header is not the pipeline",
    isValidServiceCredential(SECRET, null, "user-1") === false,
  );
  check(
    "a wrong secret of the SAME length is rejected",
    isValidServiceCredential(SECRET, "s3cret-pipeline-token-valuX", "user-1") === false,
  );
  check(
    "a wrong secret of a DIFFERENT length is rejected (no timingSafeEqual throw)",
    isValidServiceCredential(SECRET, "short", "user-1") === false,
  );
  check(
    "the correct secret without an act-as user is rejected",
    isValidServiceCredential(SECRET, SECRET, null) === false,
  );
  check(
    "the correct secret + act-as user is accepted",
    isValidServiceCredential(SECRET, SECRET, "user-1") === true,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Mint policy (pure) — provenance first, then ownership, then state
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[2] decideHeroVideoMint policy matrix");
  const { decideHeroVideoMint, TERMINAL_VIDEO_JOB_STATUSES, HERO_VIDEO_MINT_DENIAL_RESPONSES } =
    await import("../src/lib/hero-image-namespace");

  const owned = { userId: "user-1", status: "processing" };
  check(
    "browser-originated request on its OWN running job → pipeline_only (the exploit shape)",
    JSON.stringify(decideHeroVideoMint({ fromRenderPipeline: false, userId: "user-1", videoJob: owned }))
      === JSON.stringify({ ok: false, reason: "pipeline_only" }),
  );
  check(
    "pipeline request on its own running job → allowed",
    decideHeroVideoMint({ fromRenderPipeline: true, userId: "user-1", videoJob: owned }).ok === true,
  );
  check(
    "pipeline request on ANOTHER user's job → video_not_found (no cross-user mint)",
    JSON.stringify(
      decideHeroVideoMint({ fromRenderPipeline: true, userId: "user-1", videoJob: { userId: "user-2", status: "processing" } }),
    ) === JSON.stringify({ ok: false, reason: "video_not_found" }),
  );
  check(
    "pipeline request on a non-existent job → video_not_found",
    JSON.stringify(decideHeroVideoMint({ fromRenderPipeline: true, userId: "user-1", videoJob: null }))
      === JSON.stringify({ ok: false, reason: "video_not_found" }),
  );
  for (const status of ["done", "failed", "canceled"]) {
    check(
      `pipeline request on a ${status} job → video_terminal (a failed job's images would be swept)`,
      JSON.stringify(decideHeroVideoMint({ fromRenderPipeline: true, userId: "user-1", videoJob: { userId: "user-1", status } }))
        === JSON.stringify({ ok: false, reason: "video_terminal" }),
    );
  }
  for (const status of ["queued", "processing", "waiting_provider"]) {
    check(
      `pipeline request on a ${status} job → allowed (live render states stay working)`,
      decideHeroVideoMint({ fromRenderPipeline: true, userId: "user-1", videoJob: { userId: "user-1", status } }).ok === true,
    );
  }
  check(
    "terminal set matches the VideoJob.status contract exactly (done|failed|canceled)",
    [...TERMINAL_VIDEO_JOB_STATUSES].sort().join(",") === "canceled,done,failed",
  );
  check(
    "pipeline_only answers 403 with a Thai message pointing at the editor's Render flow",
    HERO_VIDEO_MINT_DENIAL_RESPONSES.pipeline_only.status === 403
      && HERO_VIDEO_MINT_DENIAL_RESPONSES.pipeline_only.body.error === "pipeline_only"
      && /เรนเดอร์/.test(HERO_VIDEO_MINT_DENIAL_RESPONSES.pipeline_only.body.message),
  );
  check(
    "video_not_found → 404, video_terminal → 409",
    HERO_VIDEO_MINT_DENIAL_RESPONSES.video_not_found.status === 404
      && HERO_VIDEO_MINT_DENIAL_RESPONSES.video_terminal.status === 409,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. DB-backed authorization against real VideoJob rows
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[3] authorizeHeroVideoMint against real rows");
  const { prisma } = await import("../src/lib/prisma");
  const { authorizeHeroVideoMint } = await import("../src/lib/hero-image-namespace");

  const attacker = await prisma.user.create({
    data: { name: "Namespace Verify Attacker", email: "hero-namespace-attacker@example.invalid", plan: "PRO" },
  });
  const victim = await prisma.user.create({
    data: { name: "Namespace Verify Victim", email: "hero-namespace-victim@example.invalid", plan: "PRO" },
  });
  const makeJob = async (userId: string, status: string) =>
    prisma.videoJob.create({ data: { userId, status, inputJson: "{}" } });

  const attackerRunning = await makeJob(attacker.id, "processing");
  const attackerDone = await makeJob(attacker.id, "done");
  const attackerFailed = await makeJob(attacker.id, "failed");
  const victimRunning = await makeJob(victim.id, "processing");

  const browserOnOwnJob = await authorizeHeroVideoMint({
    fromRenderPipeline: false,
    userId: attacker.id,
    videoJobId: attackerRunning.id,
  });
  check(
    "session-authenticated (non-pipeline) caller is denied BEFORE any reservation, even on its own live job",
    browserOnOwnJob.ok === false && browserOnOwnJob.reason === "pipeline_only",
    JSON.stringify(browserOnOwnJob),
  );
  check(
    "pipeline caller on its own live job is authorized",
    (await authorizeHeroVideoMint({ fromRenderPipeline: true, userId: attacker.id, videoJobId: attackerRunning.id })).ok === true,
  );
  const foreign = await authorizeHeroVideoMint({
    fromRenderPipeline: true,
    userId: attacker.id,
    videoJobId: victimRunning.id,
  });
  check(
    "pipeline caller binding to ANOTHER user's videoJobId is rejected (ownership defense in depth)",
    foreign.ok === false && foreign.reason === "video_not_found",
    JSON.stringify(foreign),
  );
  const missing = await authorizeHeroVideoMint({
    fromRenderPipeline: true,
    userId: attacker.id,
    videoJobId: "video-job-that-does-not-exist",
  });
  check(
    "pipeline caller binding to a non-existent videoJobId is rejected",
    missing.ok === false && missing.reason === "video_not_found",
    JSON.stringify(missing),
  );
  for (const [label, job] of [["done", attackerDone], ["failed", attackerFailed]] as const) {
    const terminal = await authorizeHeroVideoMint({
      fromRenderPipeline: true,
      userId: attacker.id,
      videoJobId: job.id,
    });
    check(
      `pipeline caller binding to a ${label} videoJobId is rejected (terminal state)`,
      terminal.ok === false && terminal.reason === "video_terminal",
      JSON.stringify(terminal),
    );
  }
  check(
    "no AiGenerationJob was created by any denied authorization (nothing reserved)",
    (await prisma.aiGenerationJob.count()) === 0,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Regression guard (Tasks 2-3): the legitimate pipeline money path is intact
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[4] Pipeline path still reserves → settles → batch-refunds");
  const { createReservedImageJob, completeImageJob } = await import("../src/lib/ai-generation-jobs.server");
  const { refundSettledVideoImageBatch } = await import("../src/lib/video-image-batch-settlement");
  const { HERO_AI_IMAGE_CREDITS } = await import("../src/lib/credit-costs");

  const cost = HERO_AI_IMAGE_CREDITS as number;
  await prisma.creditBalance.upsert({
    where: { userId: attacker.id },
    create: { userId: attacker.id, granted: 2 * cost, purchased: 2 * cost },
    update: { granted: 2 * cost, purchased: 2 * cost },
  });
  const balanceNow = async () => {
    const row = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: attacker.id } });
    return row.granted + row.purchased;
  };
  const startingBalance = await balanceNow();

  const reserve = async (idempotencyKey: string) =>
    createReservedImageJob({
      userId: attacker.id,
      model: "z-image-turbo",
      inputPreview: "verify namespace guard",
      inputJson: "{}",
      creditCost: cost,
      quoteVersion: "verify",
      costBudgetUsdMicros: 100_000,
      provider: "runpod",
      providerModel: "z-image-turbo",
      providerRoute: "runpod-custom",
      providerEndpoint: "verify-endpoint",
      estimatedCostUsdMicros: 10_000,
      idempotencyKey,
      mediaExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

  // Two images the pipeline charged to this video (hero-mode scene + AutoMix slot),
  // plus two deliberately non-refundable purchases that must never be swept.
  const sweptKeys = [
    `video:${attackerRunning.id}:scene:0`,
    `video:${attackerRunning.id}:automix:3`,
  ];
  const untouchedKeys = [
    `broll-window:${attackerRunning.id}:scene:4:request:11111111-2222-3333-4444-555555555555`,
    `studio:video:${attackerRunning.id}:scene:0`,
  ];
  const settledJobIds: string[] = [];
  for (const key of [...sweptKeys, ...untouchedKeys]) {
    const reserved = await reserve(key);
    if (!reserved.ok) throw new Error(`reservation failed for ${key}: ${reserved.reason}`);
    settledJobIds.push(reserved.job.id);
    const completed = await completeImageJob({
      userId: attacker.id,
      jobId: reserved.job.id,
      outputUrl: "/api/renders/verify-stub.png",
    });
    if (!completed) throw new Error(`settlement failed for ${key}`);
  }
  check(
    `4 reservations each debited exactly ${cost} credits`,
    (await balanceNow()) === startingBalance - 4 * cost,
    `balance=${await balanceNow()} expected=${startingBalance - 4 * cost}`,
  );
  const settledRows = await prisma.aiGenerationJob.findMany({ where: { userId: attacker.id } });
  check(
    "every reservation settled (status=completed, chargeState=settled)",
    settledRows.length === 4
      && settledRows.every((row) => row.status === "completed" && row.chargeState === "settled"),
  );

  const compensation = await refundSettledVideoImageBatch({
    userId: attacker.id,
    videoJobId: attackerRunning.id,
    reason: "verify_namespace_guard",
  });
  check(
    `a genuinely failed render still refunds exactly its own video: images (2 jobs, ${2 * cost} credits)`,
    compensation.refundedJobs === 2 && compensation.refundedCredits === 2 * cost,
    JSON.stringify(compensation),
  );
  // The two swept jobs were the FIRST two reservations, so they spent granted credits
  // only — the refund must restore them to `granted`, never silently as `purchased`.
  const restored = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: attacker.id } });
  check(
    "refund restores the exact granted/purchased split it debited",
    restored.granted === 2 * cost && restored.purchased === 0
      && restored.granted + restored.purchased === startingBalance - 2 * cost,
    `granted=${restored.granted} purchased=${restored.purchased}`,
  );
  const survivors = await prisma.aiGenerationJob.findMany({
    where: { userId: attacker.id, chargeState: "settled" },
  });
  check(
    "delivered purchases outside the video: namespace (broll-window:, studio:) are NOT swept",
    survivors.length === 2
      && survivors.every((row) => untouchedKeys.includes(row.idempotencyKey ?? "")),
    survivors.map((row) => row.idempotencyKey).join(", "),
  );
  const secondPass = await refundSettledVideoImageBatch({
    userId: attacker.id,
    videoJobId: attackerRunning.id,
    reason: "verify_namespace_guard",
  });
  check("batch compensation stays idempotent (second pass refunds nothing)", secondPass.refundedJobs === 0);
  const crossUser = await refundSettledVideoImageBatch({
    userId: victim.id,
    videoJobId: attackerRunning.id,
    reason: "verify_namespace_guard",
  });
  check("a different user cannot sweep this video's images", crossUser.refundedJobs === 0);

  await prisma.$disconnect();

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Static guard — a future edit cannot silently reintroduce an ungated mint
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[5] Static guard: every video: mint sits behind the provenance gate");
  const fetchStock = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");

  // 5a. The refundable namespace is minted in exactly one file, at exactly two sites.
  const mintSites: string[] = [];
  for (const file of walkSources("src")) {
    const source = readFileSync(file, "utf8");
    for (const at of allIndexesOf(source, "idempotencyKey: `video:")) {
      mintSites.push(`${file.replace(/\\/g, "/")}@${at}`);
    }
  }
  check(
    "`video:` reservations are minted only inside fetch-stock (2 sites: hero mode + AutoMix)",
    mintSites.length === 2
      && mintSites.every((site) => site.startsWith("src/app/api/videos/fetch-stock/route.ts@")),
    mintSites.join(" | ") || "no mint site found",
  );

  // 5b. Provenance comes from the service-credential header check, nothing else.
  check(
    "fetch-stock derives provenance from isServiceActorRequest() and nowhere else",
    fetchStock.includes('import { isServiceActorRequest } from "@/lib/mcp/service-actor";')
      && fetchStock.includes("const fromRenderPipeline = await isServiceActorRequest();")
      && allIndexesOf(fetchStock, "fromRenderPipeline =").length === 1,
  );
  check(
    "provenance is never taken from the request body",
    !/fromRenderPipeline\s*[:=]\s*(true|body|req)/.test(fetchStock)
      && !fetchStock.includes("fromRenderPipeline,\n  }: {"),
  );

  // 5c. Both mint sites are downstream of an authorizeHeroVideoMint decision.
  const authorizeSites = allIndexesOf(fetchStock, "await authorizeHeroVideoMint({");
  check(
    "fetch-stock authorizes the mint at BOTH entry points (hero mode + AutoMix AI slots)",
    authorizeSites.length === 2,
    `${authorizeSites.length} call site(s)`,
  );
  const heroMintAt = fetchStock.indexOf("idempotencyKey: `video:${videoJobId}:scene:");
  const autoMixMintAt = fetchStock.indexOf("idempotencyKey: `video:${videoJobId}:automix:");
  check(
    "every authorization runs before the first reservation in source order",
    authorizeSites.length > 0
      && heroMintAt > 0
      && autoMixMintAt > 0
      && Math.max(...authorizeSites) < Math.min(heroMintAt, autoMixMintAt),
    `authorize@[${authorizeSites.join(",")}] hero@${heroMintAt} automix@${autoMixMintAt}`,
  );
  check(
    "hero-only mode answers a denial with the shared denial constant (no re-typed copy)",
    /if \(useHeroRunpodImage\) \{\s*const mint = await authorizeHeroVideoMint\(\{ fromRenderPipeline, userId, videoJobId: videoJobId! \}\);\s*if \(!mint\.ok\) \{\s*const denial = HERO_VIDEO_MINT_DENIAL_RESPONSES\[mint\.reason\];/.test(
      fetchStock,
    ),
  );
  check(
    "AutoMix AI slots require an ok mint decision before any slot is planned",
    /const heroAutoMixMint = [\s\S]{0,320}?await authorizeHeroVideoMint\(\{ fromRenderPipeline, userId, videoJobId: videoJobId! \}\)/.test(
      fetchStock,
    )
      && /canUseHeroAutoMixAi = Boolean\([\s\S]{0,400}?heroAutoMixMint\?\.ok,/.test(fetchStock),
  );

  // 5d. The policy module itself must keep provenance as the FIRST gate — an
  // ownership-only check would not close the hole (the attacker uses their own job).
  const policy = readFileSync("src/lib/hero-image-namespace.ts", "utf8");
  const provenanceAt = policy.indexOf('if (!input.fromRenderPipeline) return { ok: false, reason: "pipeline_only" };');
  const ownershipAt = policy.indexOf("input.videoJob.userId !== input.userId");
  check(
    "the policy denies non-pipeline callers before it even considers ownership",
    provenanceAt >= 0 && ownershipAt > provenanceAt,
    `provenance@${provenanceAt} ownership@${ownershipAt}`,
  );
  check(
    "the DB-backed authorizer short-circuits before querying on a forgeable caller",
    /export async function authorizeHeroVideoMint\([\s\S]{0,400}?if \(!input\.fromRenderPipeline\) return \{ ok: false, reason: "pipeline_only" \};[\s\S]{0,200}?prisma\.videoJob\.find/.test(
      policy,
    ),
  );

  // 5e. The sweep contract itself is unchanged (Tasks 2-3 depend on this prefix).
  const settlement = readFileSync("src/lib/video-image-batch-settlement.ts", "utf8");
  check(
    "refundSettledVideoImageBatch still sweeps exactly the `video:<jobId>:` prefix, scoped by userId",
    settlement.includes("const prefix = `video:${input.videoJobId}:`;")
      && settlement.includes("idempotencyKey: { startsWith: prefix }")
      && settlement.includes("userId: input.userId,"),
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
