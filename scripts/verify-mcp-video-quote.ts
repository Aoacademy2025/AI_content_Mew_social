import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "hero-quote-test-"));
  process.env.DATABASE_URL = `file:${join(dir, "quote.db")}`;
  process.env.MINUTE_QUOTA = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.HERO_AI_IMAGE_PUBLIC = "1";
  process.env.NEXT_PUBLIC_APP_URL = "https://studio.example.test";
  globalThis.fetch = async () => { throw new Error("No provider/network calls permitted during quote preparation"); };
  // Import first: the initial red check must fail on the missing implementation.
  const domain = await import("../src/lib/mcp/video-quote");
  const service = await import("../src/lib/mcp/video-quote.server");
  execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { env: process.env, stdio: "pipe" });
  const { prisma } = await import("../src/lib/prisma");
  try {
    const owner = await prisma.user.create({ data: { name: "Fixture", email: "quote@example.test", clerkId: "clerk-owner", role: "USER", plan: "PRO", minutesLimit: 100, usagePeriodStartedAt: new Date() } });
    const other = await prisma.user.create({ data: { name: "Other", email: "other@example.test", clerkId: "clerk-other" } });
    await prisma.creditBalance.create({ data: { userId: owner.id, purchased: 100 } });
    const input = { script: "This is a private fixture script.", brollSource: "stock" as const };
    const before = { jobs: await prisma.videoJob.count(), ledger: await prisma.creditLedger.count(), images: await prisma.aiGenerationJob.count(), renders: await prisma.renderJob.count(), imports: await prisma.mediaImport.count() };
    const quote = await service.prepareVideoQuote(owner, { ...input, confirmed: true } as typeof input);
    assert.equal(quote.status, "draft");
    const preparedWork = await service.getVideoQuoteReview(owner.id, quote.quoteId);
    assert.equal(preparedWork!.execution.jobInput.geminiVoiceName, "Aoede");
    await prisma.user.update({ where: { id: owner.id }, data: { geminiVoiceName: "Kore", ttsProvider: "elevenlabs" } });
    assert.equal((await service.getVideoQuoteReview(owner.id, quote.quoteId))!.execution.jobInput.geminiVoiceName, "Aoede", "account drift does not change approved work");
    assert.equal(await service.getVideoQuoteReview(other.id, quote.quoteId), null);
    assert.equal(quote.imageCreditCeiling, 0);
    assert.equal(quote.totalHeroCreditCeiling, 0);
    assert.equal(quote.includedRenderMinutes, 1);
    assert.ok(!JSON.stringify(quote).includes(input.script));
    assert.equal((await service.getVideoQuote(other.id, quote.quoteId)).code, "quote_not_found");
    assert.equal((await service.decideVideoQuote(other.id, quote.quoteId, "approve")).code, "quote_not_found");
    assert.equal((await service.getVideoQuote(owner.id, quote.quoteId)).status, "draft", "GET does not approve");
    assert.equal((await service.decideVideoQuote(owner.id, quote.quoteId, "approve")).status, "approved");
    assert.equal((await service.decideVideoQuote(owner.id, quote.quoteId, "reject")).status, "rejected");
    assert.equal((await service.decideVideoQuote(owner.id, quote.quoteId, "approve")).code, "quote_not_actionable");
    const expired = await service.prepareVideoQuote(owner, input);
    await prisma.mcpVideoQuote.update({ where: { id: expired.quoteId }, data: { expiresAt: new Date(0) } });
    assert.equal((await service.getVideoQuote(owner.id, expired.quoteId)).status, "expired");
    assert.equal((await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: expired.quoteId } })).status, "draft", "GET derives expiry without writing");
    assert.equal((await service.decideVideoQuote(owner.id, expired.quoteId, "approve")).code, "quote_expired");
    const fresh = await service.prepareVideoQuote(owner, input);
    const row = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: fresh.quoteId } });
    assert.equal(domain.quoteExecutionRefusal(row, owner.id, { ...input, script: "changed" }, domain.currentQuotePricing()).code, "quote_input_changed");
    assert.equal(domain.quoteExecutionRefusal(row, owner.id, input, { ...domain.currentQuotePricing(), perImageCredits: 99 }).code, "quote_price_changed");
    assert.equal(domain.quoteExecutionRefusal(row, owner.id, input, domain.currentQuotePricing()).code, "confirmation_required");
    await prisma.mcpVideoQuote.update({ where: { id: fresh.quoteId }, data: { pricingHash: "stale-price" } });
    assert.equal((await service.decideVideoQuote(owner.id, fresh.quoteId, "approve")).code, "quote_price_changed");
    await prisma.mcpVideoQuote.update({ where: { id: fresh.quoteId }, data: { pricingHash: domain.quoteHash(domain.currentQuotePricing()) } });
    const external = await service.prepareVideoQuote(owner, { ...input, brollSource: "external" });
    assert.equal(external.imageCountCeiling, 0);
    assert.equal(external.imageCreditCeiling, 0);
    assert.ok(external.externalCharges.length > 0);
    const remote = await service.prepareVideoQuote(owner, { clipUrl: "https://example.test/presenter.mp4" });
    assert.equal(remote.code, "presenter_import_required");
    assert.equal((await service.prepareVideoQuote(owner, { clipUploadId: "foreign-or-missing" })).code, "presenter_import_required");
    const imported = await prisma.mediaImport.create({ data: { userId: owner.id, purpose: "presenter", source: "upload", status: "ready", resultSrc: "/api/renders/fixture.mp4", durationMs: 61000, deadlineAt: new Date(Date.now() + 60000) } });
    const presenter = await service.prepareVideoQuote(owner, { clipUploadId: imported.id, brollSource: "external" });
    assert.equal(presenter.durationSeconds, 61);
    assert.equal(presenter.exactDuration, true);
    assert.equal(presenter.includedRenderMinutes, 1);
    // HERO-87: a script that LOOKS longer than the plan's per-clip cap warns at quote time
    // (advisory — the exact post-TTS gate still decides), so the agent can shorten it first.
    assert.equal(quote.warnings, undefined, "a short script carries no plan-length warning");
    const overPlan = await service.prepareVideoQuote(owner, { script: "ก".repeat(4_400), brollSource: "stock" });
    assert.equal(overPlan.status, "draft", "the estimate never blocks");
    assert.ok(overPlan.warnings?.some((w: string) => /เกินเพดานแผน Pro/.test(w)), "over-cap estimate returns duration_estimate_over_plan copy");
    assert.ok(!presenter.warnings?.some((w: string) => /เกินเพดานแผน/.test(w)), "exact presenter duration is not an estimate");
    const after = { jobs: await prisma.videoJob.count(), ledger: await prisma.creditLedger.count(), images: await prisma.aiGenerationJob.count(), renders: await prisma.renderJob.count(), imports: (await prisma.mediaImport.count()) - 1 };
    assert.deepEqual(after, before, "prepare/read/approval never create generation/render/import or billing records");
    assert.equal((await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } })).purchased, 100);
    const { createQuoteHttpHandlers } = await import("../src/lib/mcp/video-quote-http");
    const context = { params: Promise.resolve({ quoteId: fresh.quoteId }) };
    const signedOut = createQuoteHttpHandlers(async () => null);
    const post = (headers: Record<string, string> = {}) => new Request(`https://studio.example.test/api/mcp-quotes/${fresh.quoteId}`, { method: "POST", headers: { origin: "https://studio.example.test", "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "approve" }) });
    assert.equal((await signedOut.POST(post({ authorization: "Bearer mcp-token" }), context)).status, 401);
    const signedIn = createQuoteHttpHandlers(async () => owner.id);
    assert.equal((await signedIn.POST(new Request("https://studio.example.test/api/mcp-quotes/fixture", { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"approve"}' }), context)).status, 403);
    const wrongOwner = createQuoteHttpHandlers(async () => other.id);
    assert.equal((await wrongOwner.POST(post(), context)).status, 404);
    assert.equal((await signedIn.POST(post({ origin: "https://evil.example.test" }), context)).status, 403);
    assert.equal((await signedIn.POST(post({ authorization: "Bearer service-actor" }), context)).status, 401);
    assert.equal((await signedIn.POST(post({ "x-heroai-service-secret": "fixture", "x-heroai-act-as": owner.id }), context)).status, 401);
    assert.equal((await signedIn.GET(new Request("https://studio.example.test?approve=true"), context)).status, 200);
    assert.equal((await service.getVideoQuote(owner.id, fresh.quoteId)).status, "draft");
    assert.equal((await signedIn.POST(post(), context)).status, 200);
    assert.equal((await service.getVideoQuote(owner.id, fresh.quoteId)).status, "approved");
    // Ordinary paid and trial owners, never ADMIN: image and wallet units remain distinct.
    await prisma.user.update({ where: { id: owner.id }, data: { planExpiresAt: new Date(Date.now() + 86400000) } });
    await prisma.payment.create({ data: { userId: owner.id, stripeSessionId: "paid-fixture", plan: "PRO", amount: 100, status: "PAID", paidAt: new Date() } });
    const paidImage = await service.prepareVideoQuote(owner, { script: "An ordinary paid user creates this video with generated images.", brollSource: "hero-ai-image" });
    assert.ok(paidImage.imageCountCeiling > 0);
    assert.equal(paidImage.imageCreditCeiling, paidImage.imageCountCeiling * domain.currentQuotePricing().perImageCredits);
    const trialOwner = await prisma.user.create({ data: { name: "Trial", email: "trial@example.test", role: "USER", plan: "PRO", minutesLimit: 5, trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 86400000) } });
    const trialImage = await service.prepareVideoQuote(trialOwner, { script: "This trial video uses image allowance separately from credits.", brollSource: "hero-ai-image" });
    assert.equal(trialImage.imageCreditCeiling, 0);
    assert.ok(trialImage.imageCountCeiling > 0);
    assert.ok(trialImage.trialImageAllowance.remaining > 0);
    assert.equal(await prisma.videoJob.count(), 0);
    assert.equal(await prisma.aiGenerationJob.count(), 0);
    await prisma.mcpVideoQuote.update({ where: { id: fresh.quoteId }, data: { status: "consumed", consumedAt: new Date(), rootJobId: "fixture-original-root", expiresAt: new Date(0) } });
    const consumed = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: fresh.quoteId } });
    assert.equal(domain.quoteExecutionRefusal(consumed, owner.id, { ...input, idempotencyKey: "new-retry" }, domain.currentQuotePricing()), null);
    assert.equal((await service.getVideoQuote(owner.id, fresh.quoteId)).rootJobId, "fixture-original-root");
    assert.equal((await service.decideVideoQuote(owner.id, fresh.quoteId, "reject")).code, "quote_not_actionable");
    const regressions: string[] = [];
    async function regression(name: string, check: () => Promise<void>) {
      try { await check(); } catch (error) { regressions.push(name); console.error(`FAIL snapshot regression: ${name}`, error instanceof Error ? error.message : "assertion"); }
    }
    await regression("missing ElevenLabs voice fails before a quote", async () => {
      const missing = await service.prepareVideoQuote(owner, { ...input, voiceProvider: "elevenlabs" });
      assert.equal(missing.code, "voice_setup_required");
      assert.ok(missing.next.includes("voiceId"));
    });
    await regression("music selector is pinned before library changes", async () => {
      await prisma.music.create({ data: { title: "Lofi approved track", filename: "approved.mp3", createdAt: new Date(0) } });
      const musicQuote = await service.prepareVideoQuote(owner, { ...input, bgmFile: "chill" });
      assert.ok("quoteId" in musicQuote);
      const musicWork = await service.getVideoQuoteReview(owner.id, musicQuote.quoteId);
      assert.equal(musicWork!.execution.jobInput.bgmFile, "/music/approved.mp3");
      assert.equal(musicWork!.execution.jobInput.bgmVolume, 0.12);
      await prisma.music.create({ data: { title: "Lofi newly added track", filename: "later.mp3" } });
      const { resolveBgm } = await import("../src/lib/mcp/bgm-resolve");
      const library = await prisma.music.findMany({ orderBy: { createdAt: "desc" } });
      const resolved = resolveBgm(String(musicWork!.execution.jobInput.bgmFile), library.map((track) => ({ title: track.title, bgmFile: `/music/${track.filename}` })));
      assert.equal(resolved.kind === "resolved" && resolved.bgmFile, "/music/approved.mp3");
      const unresolved = await service.prepareVideoQuote(owner, { ...input, bgmFile: "not-a-real-music-mood" });
      assert.equal(unresolved.code, "bgm_not_found");
      const noMusic = await service.prepareVideoQuote(owner, { ...input, bgmFile: "none" });
      assert.equal((await service.getVideoQuoteReview(owner.id, noMusic.quoteId))!.execution.jobInput.bgmFile, undefined);
    });
    await regression("ElevenLabs model is pinned and setting drift refused", async () => {
      const eleven = await service.prepareVideoQuote(owner, { ...input, voiceProvider: "elevenlabs", voiceId: "approved-voice" });
      assert.ok("quoteId" in eleven);
      const work = await service.getVideoQuoteReview(owner.id, eleven.quoteId);
      assert.equal(work!.execution.jobInput.elevenlabsModel, "v3");
      assert.equal((await service.decideVideoQuote(owner.id, eleven.quoteId, "approve")).status, "approved");
      const elevenRow = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: eleven.quoteId } });
      assert.equal(domain.quoteExecutionRefusal(elevenRow, owner.id, undefined, domain.currentQuotePricing(), new Date(), { elevenlabsModel: "v3" }), null);
      assert.equal(domain.quoteExecutionRefusal(elevenRow, owner.id, undefined, domain.currentQuotePricing(), new Date(), { elevenlabsModel: "v4" }).code, "quote_settings_changed");
      assert.equal(domain.quoteExecutionRefusal(elevenRow, owner.id, undefined).code, "quote_settings_changed", "missing current model evidence fails closed");
      await prisma.user.update({ where: { id: owner.id }, data: { elevenlabsModel: "v4", elevenlabsVoiceId: "later-voice" } });
      assert.equal((await service.decideVideoQuote(owner.id, eleven.quoteId, "approve")).code, "quote_settings_changed");
      assert.equal((await service.getVideoQuoteReview(owner.id, eleven.quoteId))!.execution.jobInput.voiceId, "approved-voice");
    });
    await regression("quote HTTP handlers map P2028/SQLite lock errors to 503 database_busy and decideVideoQuote avoids interactive $transaction", async () => {
      const busyHandlers = createQuoteHttpHandlers(async () => {
        const err = Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" });
        throw err;
      });
      const busyGetRes = await busyHandlers.GET(new Request(`https://studio.example.test/api/mcp-quotes/${fresh.quoteId}`), context);
      assert.equal(busyGetRes.status, 503);
      assert.equal((await busyGetRes.json()).code, "database_busy");
      const busyPostRes = await busyHandlers.POST(post(), context);
      assert.equal(busyPostRes.status, 503);
      assert.equal((await busyPostRes.json()).code, "database_busy");

      await prisma.user.update({ where: { id: owner.id }, data: { elevenlabsModel: "v3" } });
      const noTxQuote = await service.prepareVideoQuote(owner, input);
      assert.ok("quoteId" in noTxQuote);
      const origTx = prisma.$transaction.bind(prisma);
      (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = (async () => {
        throw Object.assign(new Error("decideVideoQuote must not open an interactive transaction"), { code: "P2028" });
      }) as unknown as typeof prisma.$transaction;
      try {
        const approved = await service.decideVideoQuote(owner.id, noTxQuote.quoteId, "approve");
        assert.ok("status" in approved && approved.status === "approved");
      } finally {
        (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = origTx;
      }

      const startNowQuote = await service.prepareVideoQuote(owner, { script: "Auto-start from web confirmation click.", brollSource: "stock" });
      assert.ok("quoteId" in startNowQuote);
      const startNowRes = await signedIn.POST(
        new Request(`https://studio.example.test/api/mcp-quotes/${startNowQuote.quoteId}`, {
          method: "POST",
          headers: { origin: "https://studio.example.test", "content-type": "application/json" },
          body: JSON.stringify({ action: "approve", startNow: true }),
        }),
        { params: Promise.resolve({ quoteId: startNowQuote.quoteId }) },
      );
      assert.equal(startNowRes.status, 200);
      const startNowBody = await startNowRes.json();
      assert.equal(startNowBody.status, "consumed");
      assert.ok(startNowBody.rootJobId);
      assert.ok(typeof startNowBody.editorUrl === "string" && startNowBody.editorUrl.startsWith("/video-editor?projectId="));
    });
    assert.deepEqual(regressions, []);
    console.log("PASS quote owner/auth/expiry/input/price/zero-spend and presenter checks");
  } finally { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
