import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "hero-mcp-brand-kit-"));
  process.env.DATABASE_URL = `file:${join(dir, "brand-kit.db")}`;
  process.env.MINUTE_QUOTA = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.NEXT_PUBLIC_APP_URL = "https://studio.example.test";
  globalThis.fetch = async () => {
    throw new Error("No provider/network calls permitted during quote preparation");
  };

  execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], {
    env: process.env,
    stdio: "pipe",
  });

  const { prisma } = await import("../src/lib/prisma");
  const { createBlankBrandProfileSeed } = await import("../src/lib/brand-profile-seed");
  const { applyStylePackToPayload } = await import("../src/lib/style-pack-apply");
  const { stylePack } = await import("../src/lib/style-pack-catalog");
  const service = await import("../src/lib/mcp/video-quote.server");

  try {
    const owner = await prisma.user.create({
      data: {
        name: "Pro Creator",
        email: "mcp-brand-kit@example.test",
        clerkId: "clerk-pro-brand",
        role: "USER",
        plan: "PRO",
        minutesLimit: 100,
        usagePeriodStartedAt: new Date(),
      },
    });
    const other = await prisma.user.create({
      data: {
        name: "Other User",
        email: "mcp-brand-other@example.test",
        clerkId: "clerk-other-brand",
        role: "USER",
        plan: "PRO",
      },
    });
    await prisma.creditBalance.create({ data: { userId: owner.id, purchased: 100 } });

    const asset = await prisma.brandAsset.create({
      data: {
        userId: owner.id,
        originalName: "brand-logo.png",
        mimeType: "image/png",
        storageKey: "brand-assets/fixture-logo.png",
        sizeBytes: 1024,
        width: 256,
        height: 256,
      },
    });
    const foreignAsset = await prisma.brandAsset.create({
      data: {
        userId: other.id,
        originalName: "foreign-logo.png",
        mimeType: "image/png",
        storageKey: "brand-assets/foreign-logo.png",
        sizeBytes: 1024,
        width: 256,
        height: 256,
      },
    });

    const base = createBlankBrandProfileSeed();
    const styled = applyStylePackToPayload(
      {
        ...base,
        name: "Mew Motion Kit",
        visual: {
          ...base.visual,
          peopleAndSetting: "",
          memorableCues: [],
          defaultBrollSource: "motion",
          motionThemeId: "apple-bento-glass",
          motionMascot: "ai-bot",
        },
        voice: {
          provider: "gemini",
          voiceId: "Kore",
          geminiVoiceStyle: "energetic",
          ttsSpeed: 1.15,
        },
        brandMark: {
          assetId: asset.id,
          enabled: true,
          position: "top-left",
          sizePct: 16,
          opacity: 0.85,
        },
      },
      stylePack("finance-clear"),
    );

    const profile = await prisma.brandProfile.create({
      data: {
        userId: owner.id,
        name: styled.name,
        niche: styled.niche,
        audience: styled.audience,
        tone: styled.script.tone,
        bannedWords: JSON.stringify(styled.script.bannedWords),
        ctaStyle: styled.script.ctaStyle,
        language: styled.script.language,
        activeRevisionNumber: 1,
      },
    });
    await prisma.brandProfileRevision.create({
      data: {
        brandProfileId: profile.id,
        version: 1,
        payloadJson: JSON.stringify(styled),
        visualRecipeJson: "{}",
      },
    });

    // 1. Bare brandProfileId inherits full Brand Kit: Motion, Mascot, Style Pack, Voice, Speed, Overlays, Paid Logo
    const inheritedQuote = await service.prepareVideoQuote(owner, {
      script: "สวัสดีครับ นี่คือสคริปต์ทดสอบ Brand Kit ผ่าน MCP เพื่อตรวจการสืบทอดค่าทั้งหมด",
      brandProfileId: profile.id,
    });
    assert.ok("quoteId" in inheritedQuote, `expected quoteId, got ${JSON.stringify(inheritedQuote)}`);
    assert.equal(inheritedQuote.imageCreditCeiling, 0, "Motion Brand Kit charges 0 AI image credits");
    const review = await service.getVideoQuoteReview(owner.id, inheritedQuote.quoteId);
    assert.ok(review, "quote review must exist");
    const job = review!.execution.jobInput;
    assert.equal(job.motionThemeId, "apple-bento-glass", "inherits Brand Kit motionThemeId");
    assert.equal(job.motionMascot, "ai-bot", "inherits Brand Kit motionMascot");
    assert.equal(job.stockSource, "none", "Motion Brand Kit sets stockSource to none");
    assert.equal(job.templateId, "finance-clear", "inherits Brand Kit stylePackId as templateId");
    assert.equal(job.voiceProvider, "gemini", "inherits Brand Kit voiceProvider");
    assert.equal(job.geminiVoiceName, "Kore", "inherits Brand Kit geminiVoiceName");
    assert.equal(job.ttsSpeed, 1.15, "inherits Brand Kit ttsSpeed");
    assert.equal(job.sfxMode, stylePack("finance-clear").sfxMode, "inherits Style Pack sfxMode");
    assert.equal(job.brollTransition, stylePack("finance-clear").brollTransition, "inherits Style Pack brollTransition");
    assert.equal(job.logoOverlay?.enabled, true, "paid account inherits Brand Kit logoOverlay");
    assert.equal(job.logoOverlay?.assetId, asset.id);
    assert.equal(job.logoOverlay?.position, "top-left");
    assert.equal(job.logoOverlay?.sizePct, 16);

    // 2. Explicit MCP arguments ALWAYS override Brand Kit defaults
    const overrideQuote = await service.prepareVideoQuote(owner, {
      script: "สคริปต์ทดสอบการ Override ค่า Brand Kit ด้วยพารามิเตอร์ที่ระบุชัดเจนใน MCP",
      brandProfileId: profile.id,
      brollSource: "stock",
      voiceProvider: "gemini",
      geminiVoiceName: "Aoede",
      templateId: "news-fast",
      ttsSpeed: 1,
    });
    assert.ok("quoteId" in overrideQuote);
    const overrideReview = await service.getVideoQuoteReview(owner.id, overrideQuote.quoteId);
    const overrideJob = overrideReview!.execution.jobInput;
    assert.equal(overrideJob.motionThemeId, undefined, "explicit brollSource:'stock' overrides Brand Kit Motion mode");
    assert.notEqual(overrideJob.stockSource, "none", "explicit brollSource:'stock' does not force stockSource='none'");
    assert.equal(overrideJob.geminiVoiceName, "Aoede", "explicit geminiVoiceName overrides Brand Kit voice");
    assert.equal(overrideJob.templateId, "news-fast", "explicit templateId overrides Brand Kit stylePackId");
    assert.equal(overrideJob.ttsSpeed, 1, "explicit ttsSpeed overrides Brand Kit speed");

    // 3. Ownership isolation: foreign logo asset is never attached, and another user cannot read owner's brand
    const tamperedProfile = await prisma.brandProfile.create({
      data: {
        userId: owner.id,
        name: "Tampered Logo Brand",
        niche: "test",
        audience: "test",
        tone: "test",
        bannedWords: "[]",
        ctaStyle: "follow",
        language: "th",
        activeRevisionNumber: 1,
      },
    });
    await prisma.brandProfileRevision.create({
      data: {
        brandProfileId: tamperedProfile.id,
        version: 1,
        payloadJson: JSON.stringify({
          ...styled,
          brandMark: { assetId: foreignAsset.id, enabled: true, position: "top-right", sizePct: 14, opacity: 0.9 },
        }),
        visualRecipeJson: "{}",
      },
    });
    const tamperedQuote = await service.prepareVideoQuote(owner, {
      script: "ทดสอบความปลอดภัยของโลโก้ข้ามบัญชี",
      brandProfileId: tamperedProfile.id,
    });
    assert.ok("quoteId" in tamperedQuote);
    const tamperedReview = await service.getVideoQuoteReview(owner.id, tamperedQuote.quoteId);
    assert.equal(tamperedReview!.execution.jobInput.logoOverlay, undefined, "foreign brandMark asset must never attach");

    // Cross-user brandProfileId fails closed with brand_not_found
    const crossUserQuote = await service.prepareVideoQuote(other, {
      script: "ทดสอบการเข้าถึงแบรนด์ของบัญชีอื่น",
      brandProfileId: profile.id,
    });
    assert.ok("code" in crossUserQuote && crossUserQuote.code === "brand_not_found", "cross-user brandProfileId must be rejected with brand_not_found");

    console.log("PASS verify-mcp-brand-kit-inheritance: Motion/Mascot + Style Pack + Voice + Speed + Paid Logo inherited; explicit MCP args override; cross-user & foreign assets isolated");
  } finally {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
