import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "hero-97-test-"));
  process.env.DATABASE_URL = `file:${join(dir, "hero97.db")}`;
  process.env.MINUTE_QUOTA = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.HERO_AI_IMAGE_PUBLIC = "1";
  process.env.NEXT_PUBLIC_APP_URL = "https://studio.heroaiengine.com";

  execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], {
    env: process.env,
    stdio: "pipe",
  });

  const { prisma } = await import("../src/lib/prisma");
  const {
    canCreateMcpTokenForUser,
    canInvokeMcpTool,
    getMcpStarterTrialStatus,
    MCP_UPGRADE_URL,
  } = await import("../src/lib/mcp/starter-trial");
  const {
    MCP_CREATOR_PROMPT_TEMPLATES,
    buildClaudeDesktopConfigJson,
    buildCursorMcpConfigJson,
    buildClaudeCodeCommand,
  } = await import("../src/lib/mcp/creator-prompt-pack");
  const { prepareVideoQuote } = await import("../src/lib/mcp/video-quote.server");
  const { requestVideoJob } = await import("../src/lib/mcp/video-budget.server");
  const { getCurrentUserTool } = await import("../src/lib/mcp/tools");

  try {
    // 1. Prompt pack & 1-click config builders
    assert.equal(MCP_CREATOR_PROMPT_TEMPLATES.length, 5, "5 ready-to-run creator templates");
    for (const tpl of MCP_CREATOR_PROMPT_TEMPLATES) {
      assert.ok(tpl.prompt.includes(tpl.templateId), `template ${tpl.id} embeds templateId ${tpl.templateId}`);
    }
    const desktopCfg = JSON.parse(buildClaudeDesktopConfigJson("hero_test_123"));
    assert.ok(desktopCfg.mcpServers?.heroai?.args?.some((a: string) => a.includes("Bearer hero_test_123")));
    const cursorCfg = JSON.parse(buildCursorMcpConfigJson("hero_test_123"));
    assert.equal(cursorCfg.mcpServers?.heroai?.headers?.Authorization, "Bearer hero_test_123");
    assert.ok(buildClaudeCodeCommand("hero_test_123").includes("Bearer hero_test_123"));

    // 2. Verified FREE user gets 1-clip MCP starter trial allowance
    const freeUser = await prisma.user.create({
      data: {
        name: "Starter Free",
        email: "starter-free@example.test",
        clerkId: "clerk_starter_free",
        role: "USER",
        plan: "FREE",
        usageCount: 0,
        usageLimit: 3,
        minutesUsed: 0,
        minutesLimit: 3,
        usagePeriodStartedAt: new Date(),
      },
    });
    await prisma.creditBalance.create({
      data: { userId: freeUser.id, granted: 0, purchased: 50 },
    });

    assert.equal(canCreateMcpTokenForUser(freeUser), true, "verified FREE user can create MCP token");
    assert.equal(canInvokeMcpTool(freeUser, "FREE", "get_current_user"), true);
    assert.equal(canInvokeMcpTool(freeUser, "FREE", "prepare_video_job"), true);
    assert.equal(canInvokeMcpTool(freeUser, "FREE", "create_video_job"), true);
    assert.equal(canInvokeMcpTool(freeUser, "FREE", "generate_hero_script"), false, "advanced script tool stays PRO/BUSINESS");
    assert.equal(canInvokeMcpTool(freeUser, "FREE", "replace_broll_window"), false, "edit tools stay PRO/BUSINESS");

    const initialStatus = await getMcpStarterTrialStatus(freeUser);
    assert.equal(initialStatus.eligible, true);
    assert.equal(initialStatus.remainingClips, 1);
    assert.equal(initialStatus.limitClips, 1);

    const mePayload = await getCurrentUserTool(freeUser);
    assert.equal(mePayload.mcpStarterTrial.eligible, true);
    assert.equal(mePayload.mcpStarterTrial.remainingClips, 1);

    // 3. Disallowed features on Starter Trial return plan_required with Thai upgrade CTA
    const heroImageRefusal = await prepareVideoQuote(freeUser, {
      script: "สวัสดีครับ วันนี้มาสรุปข่าวเทคโนโลยีสั้นๆ",
      brollSource: "hero-ai-image",
    });
    assert.equal("error" in heroImageRefusal && heroImageRefusal.code, "plan_required");
    if ("error" in heroImageRefusal) {
      assert.ok(heroImageRefusal.message.includes(MCP_UPGRADE_URL));
      assert.ok(heroImageRefusal.next.includes(MCP_UPGRADE_URL));
    }

    const elevenRefusal = await prepareVideoQuote(freeUser, {
      script: "สวัสดีครับ วันนี้มาสรุปข่าวเทคโนโลยีสั้นๆ",
      brollSource: "stock",
      voiceProvider: "elevenlabs",
      voiceId: "voice-1",
    });
    assert.equal("error" in elevenRefusal && elevenRefusal.code, "plan_required");

    const holdRefusal = await prepareVideoQuote(freeUser, {
      script: "สวัสดีครับ วันนี้มาสรุปข่าวเทคโนโลยีสั้นๆ",
      brollSource: "stock",
      exportMode: "hold",
    });
    assert.equal("error" in holdRefusal && holdRefusal.code, "plan_required");

    const overDurationRefusal = await prepareVideoQuote(freeUser, {
      script: "ก".repeat(4500),
      brollSource: "stock",
    });
    assert.equal("error" in overDurationRefusal && overDurationRefusal.code, "plan_required");

    // 4. First valid Stock + Gemini TTS clip <= 3 min succeeds with 0 credit spend and reserves from minute ledger
    const started = await requestVideoJob(freeUser, {
      script: "สวัสดีครับ วันนี้เรามาดู 3 เทคนิคการใช้ AI ช่วยทำงานให้เร็วขึ้นภายใน 1 นาที",
      title: "3 เทคนิค AI",
      brollSource: "stock",
      templateId: "news-fast",
    });
    assert.ok("jobId" in started && started.jobId, "first starter trial clip succeeds");

    const walletAfter = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: freeUser.id } });
    assert.equal(walletAfter.purchased, 50, "0 Hero credits spent from wallet");
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: freeUser.id } });
    assert.equal(userAfter.minutesUsed, 1, "reserves 1 minute from existing minute ledger");

    const afterStatus = await getMcpStarterTrialStatus(userAfter);
    assert.equal(afterStatus.usedClips, 1);
    assert.equal(afterStatus.remainingClips, 0);
    assert.equal(afterStatus.eligible, false);

    // 5. Second clip attempt returns structured plan_required with Thai upgrade message + pricing URL
    const secondAttempt = await requestVideoJob(userAfter, {
      script: "คลิปที่สองต้องถูกบล็อกและแนะนำให้อัปเกรดเป็น PRO หรือ BUSINESS",
      brollSource: "stock",
    });
    assert.equal("error" in secondAttempt && secondAttempt.code, "plan_required");
    if ("error" in secondAttempt) {
      assert.ok(secondAttempt.message.includes(MCP_UPGRADE_URL));
      assert.ok(secondAttempt.next.includes(MCP_UPGRADE_URL));
    }

    console.log("PASS verify-hero-97-mcp-starter-trial");
  } finally {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
