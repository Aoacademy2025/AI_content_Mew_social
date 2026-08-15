// Verifies task 3 of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   the stale-reserved AI image credit sweeper (src/lib/ai-image-reconcile.ts)
//   settles or refunds every reservation that got stuck at chargeState="reserved",
//   across every image namespace, and is safe to re-run.
//
// Run via: node --conditions=react-server --import tsx scripts/verify-ai-image-reconcile.ts
// (the react-server condition makes the "server-only"-tagged modules exercised here —
// ai-image-reconcile.ts / image-generation-provider.server.ts — resolve to their no-op
// stub instead of throwing; same pattern as verify-hero-image-price.ts.)
//
// DATABASE_URL points at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, and the RunPod HTTP layer is
// stubbed on globalThis.fetch, so nothing here touches dev.db or a real provider.

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const SETTLED_IMAGE_URL = "https://verify-bucket.s3.amazonaws.com/hero-image.png";

async function main() {
  // ── 0. Throwaway SQLite + fake-but-valid RunPod custom route ───────────────
  const dbDir = mkdtempSync(join(tmpdir(), "ai-image-reconcile-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const workflowDir = mkdtempSync(join(tmpdir(), "ai-image-reconcile-workflow-"));
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
  process.env.RUNPOD_API_KEY = "verify-ai-image-reconcile-test-key";
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "custom";
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = "verify-ai-image-reconcile-endpoint";
  process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH = workflowPath;
  delete process.env.AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS;
  // The kie scenario below must hit "provider cannot be polled", not a live call.
  delete process.env.KIE_API_KEY;

  // ── 1. RunPod stub keyed by provider job id; any other host is a failure ───
  let statusCalls = 0;
  const cancelledProviderJobIds: string[] = [];
  const outboundHosts = new Set<string>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    outboundHosts.add(new URL(url).host);
    if (!url.startsWith("https://api.runpod.ai/v2/")) {
      throw new Error(`unexpected outbound request in verify script: ${url}`);
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/status/")) {
      statusCalls += 1;
      const providerJobId = decodeURIComponent(url.split("/status/")[1] ?? "");
      if (providerJobId === "stub-terminal-failed") {
        return json({ status: "FAILED", error: "CUDA out of memory" });
      }
      if (providerJobId === "stub-completed") {
        return json({
          status: "COMPLETED",
          output: {
            images: [{ filename: "hero-image.png", type: "s3_url", data: SETTLED_IMAGE_URL }],
            cost: 0.0052,
          },
          delayTime: 900,
          executionTime: 4200,
        });
      }
      if (providerJobId === "stub-completed-output-lost") {
        // COMPLETED, but the stored location is not retrievable (non-HTTPS).
        return json({
          status: "COMPLETED",
          output: {
            images: [{ filename: "hero-image.png", type: "s3_url", data: "http://verify-bucket.invalid/x.png" }],
          },
        });
      }
      if (providerJobId === "stub-poll-throws") {
        return new Response("<html>502 bad gateway</html>", { status: 502 });
      }
      if (providerJobId === "stub-still-queued" || providerJobId === "stub-still-queued-cancel-throws") {
        return json({ status: "IN_QUEUE", delayTime: 1_900_000 });
      }
      throw new Error(`unstubbed provider job id: ${providerJobId}`);
    }
    if (url.includes("/cancel/")) {
      const providerJobId = decodeURIComponent(url.split("/cancel/")[1] ?? "");
      cancelledProviderJobIds.push(providerJobId);
      if (providerJobId === "stub-still-queued-cancel-throws") {
        throw new TypeError("fetch failed: connection reset by peer");
      }
      return json({ status: "CANCELLED" });
    }
    throw new Error(`unstubbed RunPod operation: ${url}`);
  }) as typeof fetch;

  const { prisma } = await import("../src/lib/prisma");
  const { describeHeroImageOffer } = await import("../src/lib/video-hero-image.server");
  const {
    completeImageJob,
    createReservedImageJob,
    failAndRefundAiJob,
    markImageAttemptSubmitted,
  } = await import("../src/lib/ai-generation-jobs.server");
  const { sweepStaleReservedImageJobs, SWEEP_MIN_STALE_MINUTES } = await import(
    "../src/lib/ai-image-reconcile"
  );

  const offer = describeHeroImageOffer();
  check(
    "hero offer is live on the verified custom route at 2 credits",
    offer.available && offer.providerRoute === "runpod-custom" && offer.quote.credits === 2,
  );

  // ── Seeding helpers ───────────────────────────────────────────────────────
  let userSeq = 0;
  async function makeUser(label: string, granted: number, purchased: number) {
    userSeq += 1;
    // Paid evidence selects the shared Credit wallet; these assertions pin the
    // existing granted-first split rather than the new never-paid allowance.
    const user = await prisma.user.create({
      data: {
        name: `Reconcile ${label}`,
        email: `reconcile-${userSeq}-${label}@example.invalid`,
        plan: "PRO",
        subStatus: "active",
      },
    });
    await prisma.creditBalance.create({ data: { userId: user.id, granted, purchased } });
    return user;
  }

  async function reserve(input: {
    userId: string;
    idempotencyKey: string;
    videoJobId?: string;
    sceneIndex?: number;
    provider?: string;
    providerModel?: string;
    providerRoute?: string;
    providerEndpoint?: string;
  }) {
    const reserved = await createReservedImageJob({
      userId: input.userId,
      model: "z-image-turbo",
      inputPreview: "verify ai image reconcile",
      inputJson: JSON.stringify({
        engine: "runpod",
        videoJobId: input.videoJobId ?? "video-reconcile-verify",
        sceneIndex: input.sceneIndex ?? 0,
      }),
      creditCost: offer.quote.credits,
      quoteVersion: offer.quote.version,
      costBudgetUsdMicros: offer.quote.costBudgetUsdMicros,
      provider: input.provider ?? offer.provider,
      providerModel: input.providerModel ?? offer.providerModel,
      providerRoute: input.providerRoute ?? offer.providerRoute,
      providerEndpoint: input.providerEndpoint ?? offer.providerEndpoint,
      estimatedCostUsdMicros: offer.quote.estimatedProviderCostUsdMicros,
      idempotencyKey: input.idempotencyKey,
      mediaExpiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!reserved.ok) throw new Error(`expected reservation to succeed for ${input.idempotencyKey}`);
    return reserved.job;
  }

  async function submit(userId: string, jobId: string, providerJobId: string) {
    await markImageAttemptSubmitted({ userId, jobId, sequence: 1, providerJobId, inProgress: false });
  }

  /** `updatedAt` is `@updatedAt`, so age is forced with a raw write after seeding. */
  async function backdate(jobId: string, minutes: number) {
    const at = Date.now() - minutes * 60_000;
    await prisma.$executeRawUnsafe("UPDATE AiGenerationJob SET updatedAt = ? WHERE id = ?", at, jobId);
  }

  const balanceOf = async (userId: string) =>
    prisma.creditBalance.findUniqueOrThrow({ where: { userId } });
  const jobById = async (id: string) => prisma.aiGenerationJob.findUniqueOrThrow({ where: { id } });
  const refundRows = async (userId: string) =>
    prisma.creditLedger.findMany({ where: { userId, kind: "refund" }, orderBy: { createdAt: "asc" } });

  /** Stable fingerprint of every row the sweeper could possibly touch. */
  async function snapshot(): Promise<string> {
    const [jobs, balances, ledger, images] = await Promise.all([
      prisma.aiGenerationJob.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          status: true,
          chargeState: true,
          outputUrl: true,
          errorCode: true,
          creditCost: true,
          generatedImageId: true,
          updatedAt: true,
        },
      }),
      prisma.creditBalance.findMany({
        orderBy: { userId: "asc" },
        select: { userId: true, granted: true, purchased: true },
      }),
      prisma.creditLedger.findMany({
        orderBy: { id: "asc" },
        select: { id: true, action: true, delta: true, balanceAfter: true },
      }),
      prisma.generatedImage.findMany({ orderBy: { id: "asc" }, select: { id: true, url: true } }),
    ]);
    return JSON.stringify({ jobs, balances, ledger, images });
  }

  // ── 2. Seed one stale job per decision-table branch ────────────────────────
  console.log("\n[2] Seeding stale reserved jobs (one per sweep decision)");

  // A — provider terminal failure. granted=1 forces a split reservation so the
  // refund has to restore BOTH buckets exactly.
  const userA = await makeUser("terminal", 1, 5);
  const jobA = await reserve({ userId: userA.id, idempotencyKey: "video:v1:scene:0" });
  await submit(userA.id, jobA.id, "stub-terminal-failed");
  await backdate(jobA.id, 180);

  // B — provider COMPLETED with a retrievable image: the charge must STAND.
  const userB = await makeUser("completed", 0, 10);
  const jobB = await reserve({
    userId: userB.id,
    idempotencyKey: "video:v2:automix:3",
    videoJobId: "v2",
    sceneIndex: 0,
  });
  await submit(userB.id, jobB.id, "stub-completed");
  await backdate(jobB.id, 170);

  // B1 — the provider completed only after its parent video had already failed.
  // This output can no longer be delivered, so the stale reservation must refund
  // instead of being settled by the reconciler.
  const userB1 = await makeUser("terminalparent", 0, 10);
  await prisma.videoJob.create({
    data: {
      id: "terminal-parent-failed",
      userId: userB1.id,
      status: "processing",
      inputJson: "{}",
    },
  });
  const jobB1 = await reserve({
    userId: userB1.id,
    idempotencyKey: "video:terminal-parent-failed:scene:0",
    videoJobId: "terminal-parent-failed",
    sceneIndex: 0,
  });
  await submit(userB1.id, jobB1.id, "stub-completed");
  await prisma.videoJob.update({
    where: { id: "terminal-parent-failed" },
    data: { status: "failed", finishedAt: new Date() },
  });
  await backdate(jobB1.id, 165);

  // B2 — COMPLETED but the output cannot be stored.
  const userB2 = await makeUser("outputlost", 4, 0);
  const jobB2 = await reserve({ userId: userB2.id, idempotencyKey: "broll-window:w7:1" });
  await submit(userB2.id, jobB2.id, "stub-completed-output-lost");
  await backdate(jobB2.id, 160);

  // C — status poll throws (the PROVIDER_POLL_FAILED outage case).
  const userC = await makeUser("pollthrows", 3, 3);
  const jobC = await reserve({ userId: userC.id, idempotencyKey: "studio:abc123" });
  await submit(userC.id, jobC.id, "stub-poll-throws");
  await backdate(jobC.id, 150);

  // C2 — still IN_QUEUE long after the caller's bounded wait (PROVIDER_TIMEOUT case).
  const userC2 = await makeUser("queued", 2, 0);
  const jobC2 = await reserve({ userId: userC2.id, idempotencyKey: "video:v3:scene:4" });
  await submit(userC2.id, jobC2.id, "stub-still-queued");
  await backdate(jobC2.id, 140);

  // D — reservation that never got a provider job id.
  const userD = await makeUser("noproviderjob", 0, 2);
  const jobD = await reserve({ userId: userD.id, idempotencyKey: "video:v4:automix:0" });
  await backdate(jobD.id, 130);

  // G — a non-RunPod namespace that cannot be polled at all (kie, no key configured).
  const userG = await makeUser("unpollable", 2, 0);
  const jobG = await reserve({
    userId: userG.id,
    idempotencyKey: "studio:kie-legacy",
    provider: "kie",
    providerModel: "google/nano-banana",
    providerRoute: "kie-market",
    providerEndpoint: "kie-market",
  });
  await submit(userG.id, jobG.id, "stub-kie-task");
  await backdate(jobG.id, 120);

  // C3 — still IN_QUEUE, and the best-effort cancel itself throws.
  const userC3 = await makeUser("queuedcancelfails", 0, 2);
  const jobC3 = await reserve({ userId: userC3.id, idempotencyKey: "broll-window:w9:2" });
  await submit(userC3.id, jobC3.id, "stub-still-queued-cancel-throws");
  await backdate(jobC3.id, 110);

  // E — fresh reservation (5 minutes old): outside the window, must be untouched.
  const userE = await makeUser("fresh", 5, 0);
  const jobE = await reserve({ userId: userE.id, idempotencyKey: "video:v5:scene:0" });
  await submit(userE.id, jobE.id, "stub-terminal-failed");
  await backdate(jobE.id, 5);

  // F — already-terminal rows, stale on purpose: settled + refunded must be skipped.
  const userF = await makeUser("terminalstates", 6, 6);
  const jobFSettled = await reserve({ userId: userF.id, idempotencyKey: "video:v6:scene:0" });
  await submit(userF.id, jobFSettled.id, "stub-completed");
  await completeImageJob({
    userId: userF.id,
    jobId: jobFSettled.id,
    outputUrl: "https://verify-bucket.s3.amazonaws.com/already-settled.png",
  });
  await backdate(jobFSettled.id, 300);
  const jobFRefunded = await reserve({ userId: userF.id, idempotencyKey: "video:v6:scene:1" });
  await submit(userF.id, jobFRefunded.id, "stub-terminal-failed");
  await failAndRefundAiJob(userF.id, jobFRefunded.id, "PROVIDER_FAILED", "already refunded by the request path");
  await backdate(jobFRefunded.id, 300);

  const staleIdsInOrder = [jobA.id, jobB.id, jobB1.id, jobB2.id, jobC.id, jobC2.id, jobD.id, jobG.id, jobC3.id];
  check(
    "seeded 10 reserved (9 stale + 1 fresh) + 1 settled + 1 refunded",
    (await prisma.aiGenerationJob.count({ where: { chargeState: "reserved" } })) === 10
      && (await prisma.aiGenerationJob.count({ where: { chargeState: "settled" } })) === 1
      && (await prisma.aiGenerationJob.count({ where: { chargeState: "refunded" } })) === 1,
    `reserved=${await prisma.aiGenerationJob.count({ where: { chargeState: "reserved" } })}`,
  );

  // The 15-minute sweep query must be index-covered, not a table scan.
  const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'AiGenerationJob'",
  );
  check(
    "prisma db push created the sweep's covering index (kind, chargeState, updatedAt)",
    indexes.some((row) => row.name === "AiGenerationJob_kind_chargeState_updatedAt_idx"),
    indexes.map((row) => row.name).join(", "),
  );

  // ── 3. dryRun: correct would-do counts, zero mutations ────────────────────
  console.log("\n[3] dryRun sweep");
  const beforeDry = await snapshot();
  const statusCallsBeforeDry = statusCalls;
  const dry = await sweepStaleReservedImageJobs({ dryRun: true });
  check("dryRun scanned exactly the 9 stale reserved jobs", dry.scanned === 9, `got ${dry.scanned}`);
  // A dry run reports an UPPER BOUND on settlements: it cannot prove the image is
  // still retrievable without storing it, so B2 (COMPLETED, unretrievable) reads as
  // "would settle" here and becomes a SWEEP_OUTPUT_LOST refund in the live run.
  check(
    "dryRun would settle 2 deliverable provider-COMPLETED jobs",
    dry.settled === 2,
    `got ${dry.settled}`,
  );
  check("dryRun would refund the other 7, including the terminal-parent child", dry.refunded === 7, `got ${dry.refunded}`);
  check(
    "dryRun would refund 14 credits (7 × 2cr)",
    dry.refundedCredits === 14,
    `got ${dry.refundedCredits}`,
  );
  check("dryRun reports no errors", dry.errors.length === 0, JSON.stringify(dry.errors));
  check(
    "dryRun visits jobs oldest-first",
    dry.decisions.map((d) => d.jobId).join(",") === staleIdsInOrder.join(","),
    dry.decisions.map((d) => d.reason).join(","),
  );
  check(
    "dryRun still polls RunPod (read-only) exactly once per pollable RunPod job",
    statusCalls - statusCallsBeforeDry === 6,
    `got ${statusCalls - statusCallsBeforeDry}`,
  );
  check(
    "dryRun cancels nothing at the provider",
    cancelledProviderJobIds.length === 0 && dry.decisions.every((d) => d.cancelAttempted !== true),
    cancelledProviderJobIds.join(","),
  );
  check("dryRun mutated nothing", (await snapshot()) === beforeDry);
  check(
    "dryRun created no images",
    (await prisma.generatedImage.count()) === 1, // only the pre-settled F row
    `got ${await prisma.generatedImage.count()}`,
  );

  // ── 4. Real sweep ─────────────────────────────────────────────────────────
  console.log("\n[4] Live sweep");
  const live = await sweepStaleReservedImageJobs({});
  check("live sweep scanned 9", live.scanned === 9, `got ${live.scanned}`);
  check("live sweep settled 1", live.settled === 1, `got ${live.settled}`);
  check("live sweep refunded 8", live.refunded === 8, `got ${live.refunded}`);
  check("live sweep refunded 16 credits", live.refundedCredits === 16, `got ${live.refundedCredits}`);
  check("live sweep skipped 0", live.skipped === 0, `got ${live.skipped}`);
  check("live sweep reported no errors", live.errors.length === 0, JSON.stringify(live.errors));
  const dryActions = new Map(dry.decisions.map((d) => [d.jobId, d.action]));
  const divergent = live.decisions.filter((d) => dryActions.get(d.jobId) !== d.action);
  check(
    "live sweep matched the dryRun plan on every job except the unretrievable output",
    live.scanned === dry.scanned
      && divergent.length === 1
      && divergent[0].jobId === jobB2.id
      && divergent[0].action === "refund"
      && dryActions.get(jobB2.id) === "settle",
    divergent.map((d) => `${d.jobId}:${d.action}`).join(","),
  );
  check(
    "sweep made no outbound request outside api.runpod.ai",
    [...outboundHosts].join(",") === "api.runpod.ai",
    [...outboundHosts].join(","),
  );

  // A — refunded exactly once, into the exact buckets it was drawn from.
  const afterA = await jobById(jobA.id);
  const balA = await balanceOf(userA.id);
  const ledgerA = await refundRows(userA.id);
  check(
    "A terminal-failed: chargeState=refunded, status=failed, errorCode=SWEEP_STALE_RESERVED",
    afterA.chargeState === "refunded" && afterA.status === "failed" && afterA.errorCode === "SWEEP_STALE_RESERVED",
    `${afterA.chargeState}/${afterA.status}/${afterA.errorCode}`,
  );
  check(
    "A refund restored the exact granted/purchased split (1 granted + 1 purchased)",
    balA.granted === 1 && balA.purchased === 5,
    `granted=${balA.granted} purchased=${balA.purchased}`,
  );
  check(
    "A wrote exactly one ai-image-refund:<id> ledger row of +2",
    ledgerA.length === 1 && ledgerA[0].action === `ai-image-refund:${jobA.id}` && ledgerA[0].delta === 2,
    JSON.stringify(ledgerA.map((row) => ({ action: row.action, delta: row.delta }))),
  );
  check(
    "A ledger balanceAfter matches the restored balance",
    ledgerA[0]?.balanceAfter === balA.granted + balA.purchased,
  );

  // B — settled: image kept, charge stands, no refund.
  const afterB = await jobById(jobB.id);
  const balB = await balanceOf(userB.id);
  check(
    "B completed: status=completed, chargeState=settled",
    afterB.status === "completed" && afterB.chargeState === "settled",
    `${afterB.status}/${afterB.chargeState}`,
  );
  check("B persisted the provider outputUrl", afterB.outputUrl === SETTLED_IMAGE_URL, afterB.outputUrl ?? "null");
  check(
    "B charge STANDS (balance still 8, unchanged by the sweep)",
    balB.granted === 0 && balB.purchased === 8,
    `granted=${balB.granted} purchased=${balB.purchased}`,
  );
  check("B wrote no refund ledger row", (await refundRows(userB.id)).length === 0);
  check(
    "B recorded provider timings + reported cost from the poll",
    afterB.delayTimeMs === 900 && afterB.executionTimeMs === 4200 && afterB.providerReportedCostUsdMicros === 5200,
    `${afterB.delayTimeMs}/${afterB.executionTimeMs}/${afterB.providerReportedCostUsdMicros}`,
  );

  const afterB1 = await jobById(jobB1.id);
  const balB1 = await balanceOf(userB1.id);
  check(
    "B1 terminal parent: provider-completed child is refunded, never settled",
    afterB1.status === "failed"
      && afterB1.chargeState === "refunded"
      && afterB1.errorCode === "PARENT_VIDEO_TERMINAL"
      && afterB1.outputUrl === null,
    `${afterB1.status}/${afterB1.chargeState}/${afterB1.errorCode}`,
  );
  check("B1 restores the full reservation", balB1.granted === 0 && balB1.purchased === 10);
  const imageB = afterB.generatedImageId
    ? await prisma.generatedImage.findUnique({ where: { id: afterB.generatedImageId } })
    : null;
  check(
    "B created the GeneratedImage row the normal settle path would have created",
    imageB?.url === SETTLED_IMAGE_URL && imageB?.sceneTitle === "Video v2 · scene 1",
    `${imageB?.url} / ${imageB?.sceneTitle}`,
  );

  // B2 — completed but unretrievable output → refunded under SWEEP_OUTPUT_LOST.
  const afterB2 = await jobById(jobB2.id);
  const balB2 = await balanceOf(userB2.id);
  check(
    "B2 output-lost: chargeState=refunded with errorCode=SWEEP_OUTPUT_LOST",
    afterB2.chargeState === "refunded" && afterB2.errorCode === "SWEEP_OUTPUT_LOST",
    `${afterB2.chargeState}/${afterB2.errorCode}`,
  );
  check("B2 balance restored to 4 granted", balB2.granted === 4 && balB2.purchased === 0);
  check("B2 job kept no outputUrl", afterB2.outputUrl === null);

  // C — poll throws → refunded.
  const afterC = await jobById(jobC.id);
  const balC = await balanceOf(userC.id);
  check(
    "C poll-throws: refunded under SWEEP_STALE_RESERVED",
    afterC.chargeState === "refunded" && afterC.errorCode === "SWEEP_STALE_RESERVED",
    `${afterC.chargeState}/${afterC.errorCode}`,
  );
  check("C balance restored (3/3)", balC.granted === 3 && balC.purchased === 3);

  // C2 — still queued → orphan cancelled at the provider, then refunded.
  const afterC2 = await jobById(jobC2.id);
  const decisionC2 = live.decisions.find((d) => d.jobId === jobC2.id);
  check(
    "C2 still-IN_QUEUE past the window: refunded under SWEEP_STALE_RESERVED",
    afterC2.chargeState === "refunded" && afterC2.errorCode === "SWEEP_STALE_RESERVED",
    `${afterC2.chargeState}/${afterC2.errorCode}`,
  );
  check("C2 balance restored (2 granted)", (await balanceOf(userC2.id)).granted === 2);
  check(
    "C2 asked RunPod to cancel the orphaned job before refunding",
    cancelledProviderJobIds.includes("stub-still-queued")
      && decisionC2?.cancelAttempted === true
      && decisionC2?.cancelOk === true,
    JSON.stringify(decisionC2),
  );

  // C3 — still queued, cancel throws: the refund must still happen, exactly once.
  const afterC3 = await jobById(jobC3.id);
  const decisionC3 = live.decisions.find((d) => d.jobId === jobC3.id);
  check(
    "C3 cancel failure never blocks the refund",
    afterC3.chargeState === "refunded" && afterC3.errorCode === "SWEEP_STALE_RESERVED",
    `${afterC3.chargeState}/${afterC3.errorCode}`,
  );
  check(
    "C3 records the failed cancel (cancelAttempted, not cancelOk) and refunds once",
    decisionC3?.cancelAttempted === true
      && decisionC3?.cancelOk === false
      && (await refundRows(userC3.id)).length === 1
      && (await balanceOf(userC3.id)).purchased === 2,
    JSON.stringify(decisionC3),
  );
  check(
    "cancel is attempted only for still-running provider jobs (not terminal/no-id/unpollable ones)",
    live.decisions
      .filter((d) => ![jobC2.id, jobC3.id].includes(d.jobId))
      .every((d) => d.cancelAttempted !== true)
      && cancelledProviderJobIds.length === 2,
    cancelledProviderJobIds.join(","),
  );

  // D — no provider job id → refunded without any provider call.
  const afterD = await jobById(jobD.id);
  check(
    "D no-providerJobId: refunded under SWEEP_STALE_RESERVED",
    afterD.chargeState === "refunded" && afterD.errorCode === "SWEEP_STALE_RESERVED",
    `${afterD.chargeState}/${afterD.errorCode}`,
  );
  check("D balance restored (2 purchased)", (await balanceOf(userD.id)).purchased === 2);

  // G — unpollable provider namespace → refunded, and the sweep continued past it.
  const afterG = await jobById(jobG.id);
  check(
    "G unpollable kie job: refunded under SWEEP_STALE_RESERVED (namespace/provider agnostic)",
    afterG.chargeState === "refunded" && afterG.errorCode === "SWEEP_STALE_RESERVED",
    `${afterG.chargeState}/${afterG.errorCode}`,
  );
  check("G balance restored (2 granted)", (await balanceOf(userG.id)).granted === 2);

  // E — fresh reservation untouched.
  const afterE = await jobById(jobE.id);
  const balE = await balanceOf(userE.id);
  check(
    "E fresh (5 min) reservation untouched: still reserved/queued, credits still held",
    afterE.chargeState === "reserved" && afterE.status === "queued" && balE.granted === 3,
    `${afterE.chargeState}/${afterE.status}/granted=${balE.granted}`,
  );

  // F — settled + refunded rows untouched.
  const afterFSettled = await jobById(jobFSettled.id);
  const afterFRefunded = await jobById(jobFRefunded.id);
  const balF = await balanceOf(userF.id);
  check(
    "F already-settled job untouched (still settled, output intact)",
    afterFSettled.chargeState === "settled" && afterFSettled.status === "completed",
    `${afterFSettled.chargeState}/${afterFSettled.status}`,
  );
  check(
    "F already-refunded job untouched (still refunded, one refund row only)",
    afterFRefunded.chargeState === "refunded" && (await refundRows(userF.id)).length === 1,
  );
  check(
    "F balance unchanged by the sweep (12 seeded − 2 for the settled job = 10)",
    balF.granted === 4 && balF.purchased === 6,
    `granted=${balF.granted} purchased=${balF.purchased}`,
  );

  // ── 5. Idempotency ────────────────────────────────────────────────────────
  console.log("\n[5] Idempotency");
  const afterLive = await snapshot();
  const second = await sweepStaleReservedImageJobs({});
  check(
    "second sweep finds nothing (every reservation is resolved)",
    second.scanned === 0 && second.settled === 0 && second.refunded === 0 && second.refundedCredits === 0,
    JSON.stringify({ scanned: second.scanned, settled: second.settled, refunded: second.refunded }),
  );
  check("second sweep changed nothing in the database", (await snapshot()) === afterLive);

  // Direct re-entry into the shared helpers — the guards, not the query filter,
  // are what make a re-run safe.
  const reRefund = await failAndRefundAiJob(userA.id, jobA.id, "SWEEP_STALE_RESERVED", "second attempt");
  const balAAfterReRefund = await balanceOf(userA.id);
  check(
    "failAndRefundAiJob on an already-refunded job never pays twice",
    reRefund?.chargeState === "refunded"
      && balAAfterReRefund.granted === 1
      && balAAfterReRefund.purchased === 5
      && (await refundRows(userA.id)).length === 1,
    `granted=${balAAfterReRefund.granted} purchased=${balAAfterReRefund.purchased}`,
  );
  const reSettle = await completeImageJob({
    userId: userA.id,
    jobId: jobA.id,
    outputUrl: "https://verify-bucket.s3.amazonaws.com/late-arrival.png",
  });
  check(
    "completeImageJob can never settle a refunded job (no re-charge after a refund)",
    reSettle?.chargeState === "refunded" && reSettle?.status === "failed" && reSettle?.outputUrl === null,
    `${reSettle?.chargeState}/${reSettle?.status}`,
  );
  const reRefundB = await failAndRefundAiJob(userB.id, jobB.id, "SWEEP_STALE_RESERVED", "second attempt");
  check(
    "failAndRefundAiJob on a settled job never refunds a delivered image",
    reRefundB?.chargeState === "settled"
      && (await refundRows(userB.id)).length === 0
      && (await balanceOf(userB.id)).purchased === 8,
  );

  // ── 5B. A provider result that arrives after AutoMix already finished ─────
  // AutoMix may deliberately omit an ambiguous Hero slot and still finish the
  // parent video. A late provider COMPLETED result was not delivered in that
  // video, so reconciliation must refund it before persisting/settling output.
  console.log("\n[5B] Late provider completion after parent video is done");
  const userDone = await makeUser("doneparent", 0, 6);
  await prisma.videoJob.create({
    data: {
      id: "terminal-parent-done",
      userId: userDone.id,
      status: "processing",
      inputJson: "{}",
    },
  });
  const jobDone = await reserve({
    userId: userDone.id,
    idempotencyKey: "video:terminal-parent-done:automix:2",
    videoJobId: "terminal-parent-done",
    sceneIndex: 2,
  });
  await submit(userDone.id, jobDone.id, "stub-completed");
  await prisma.videoJob.update({
    where: { id: "terminal-parent-done" },
    data: { status: "done", finishedAt: new Date() },
  });
  await backdate(jobDone.id, 90);
  const statusCallsBeforeDoneParent = statusCalls;
  const doneParentSweep = await sweepStaleReservedImageJobs({});
  const afterDone = await jobById(jobDone.id);
  check(
    "done-parent late child is reported as one refund, not a settlement/skip",
    doneParentSweep.scanned === 1
      && doneParentSweep.refunded === 1
      && doneParentSweep.settled === 0
      && doneParentSweep.skipped === 0
      && doneParentSweep.decisions[0]?.reason === "parent_done",
    JSON.stringify(doneParentSweep),
  );
  check(
    "done-parent late child is refunded without accepting provider output",
    afterDone.status === "failed"
      && afterDone.chargeState === "refunded"
      && afterDone.errorCode === "PARENT_VIDEO_TERMINAL"
      && afterDone.outputUrl === null
      && afterDone.generatedImageId === null,
    `${afterDone.status}/${afterDone.chargeState}/${afterDone.errorCode}`,
  );
  check(
    "done-parent refund restores credits before polling the late provider result",
    (await balanceOf(userDone.id)).purchased === 6
      && statusCalls === statusCallsBeforeDoneParent,
    `purchased=${(await balanceOf(userDone.id)).purchased} statusCalls=${statusCalls - statusCallsBeforeDoneParent}`,
  );

  // ── 6. limit + oldest-first ordering ──────────────────────────────────────
  console.log("\n[6] limit + ordering");
  const userI = await makeUser("ordering", 20, 0);
  const ordered: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const job = await reserve({ userId: userI.id, idempotencyKey: `video:v9:scene:${index}` });
    await submit(userI.id, job.id, "stub-terminal-failed");
    // index 0 is the oldest (600 min) down to index 4 (200 min).
    await backdate(job.id, 600 - index * 100);
    ordered.push(job.id);
  }
  const limited = await sweepStaleReservedImageJobs({ limit: 2, dryRun: true });
  check(
    "limit=2 scans exactly 2 jobs",
    limited.scanned === 2 && limited.decisions.length === 2,
    `got ${limited.scanned}`,
  );
  check(
    "limit=2 picks the two OLDEST reservations, in order",
    limited.decisions.map((d) => d.jobId).join(",") === ordered.slice(0, 2).join(","),
  );
  const unlimited = await sweepStaleReservedImageJobs({ limit: 50, dryRun: true });
  check(
    "unlimited dry sweep returns all 5 in ascending staleness order",
    unlimited.decisions.map((d) => d.jobId).join(",") === ordered.join(","),
  );
  check(
    "olderThanMinutes cannot be tightened below the 30-minute floor",
    (await sweepStaleReservedImageJobs({ olderThanMinutes: 1, dryRun: true })).olderThanMinutes
      === SWEEP_MIN_STALE_MINUTES,
  );
  check(
    "limit is bounded (0 and 10_000 are clamped into range)",
    (await sweepStaleReservedImageJobs({ limit: 0, dryRun: true })).limit === 1
      && (await sweepStaleReservedImageJobs({ limit: 10_000, dryRun: true })).limit === 200,
  );

  globalThis.fetch = realFetch;
  await prisma.$disconnect();

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
