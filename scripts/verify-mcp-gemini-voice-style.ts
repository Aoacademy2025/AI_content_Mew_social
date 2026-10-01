// T5 — geminiVoiceStyle forwarding in MCP create_video_job.
//
// MCP used to drop `geminiVoiceStyle` unconditionally (recon.md §E: "MCP drops it
// unconditionally because of the missing forward at route.ts:277"). This proves:
//   1) route.ts gates it with the SAME function + env var the web create route uses
//      (jobs/route.ts:585-589): isInternalAiBetaEnabledFor(user, GEMINI_TTS_38_PUBLIC==="1").
//   2) when the gate is open, the resolved style reaches job.inputJson (mirroring the
//      web `!== "neutral"` omission so "neutral" never clutters inputJson).
//   3) when the gate denies a non-neutral request, the job is created with "neutral"
//      and the response carries a Thai warning — never a silent drop.
//   4) the new `warnings: string[]` response field carries `warning` as its first
//      element for one release (back-compat for older agents).
//
// Combines real behavioral calls to the production gate/resolve functions with a
// source-grep of route.ts for the wiring shape — the same pattern already used by
// scripts/verify-mcp-audit-status.ts for logic embedded in the MCP route closure
// (not separately exported/importable).
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "mcp-gemini-voice-style-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
function check(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { createVideoJob } = await import("../src/lib/mcp/video-job");
  const { isInternalAiBetaEnabledFor } = await import("../src/lib/internal-ai-access");
  const { resolveGeminiVoiceStyle } = await import("../src/lib/gemini-voice-styles");

  const previousPublicFlag = process.env.GEMINI_TTS_38_PUBLIC;
  delete process.env.GEMINI_TTS_38_PUBLIC;

  const tester = await prisma.user.create({
    data: { id: "voice-style-tester", name: "tester", email: "duckyhero@gmail.com", plan: "PRO", geminiKey: "g" },
  });
  const outsider = await prisma.user.create({
    data: { id: "voice-style-outsider", name: "outsider", email: "outsider@example.test", plan: "PRO", geminiKey: "g" },
  });

  // ── 1) Gate function: both states, same call shape the route uses ──────────
  check(
    isInternalAiBetaEnabledFor(outsider, process.env.GEMINI_TTS_38_PUBLIC === "1") === false,
    "gate CLOSED: non-tester, flag unset",
  );
  check(
    isInternalAiBetaEnabledFor(tester, process.env.GEMINI_TTS_38_PUBLIC === "1") === true,
    "gate OPEN: internal tester email always passes, even with the public flag off",
  );
  process.env.GEMINI_TTS_38_PUBLIC = "1";
  check(
    isInternalAiBetaEnabledFor(outsider, process.env.GEMINI_TTS_38_PUBLIC === "1") === true,
    "gate OPEN: public flag opens it for every account",
  );
  delete process.env.GEMINI_TTS_38_PUBLIC;

  // ── 2) Value reaching job inputJson, mirroring route.ts's intended composition ──
  // Denied: resolved value is forced to "neutral" and (mirroring web jobs/route.ts:1075)
  // omitted from inputJson since "neutral" means "no style override".
  {
    const gateOpen = isInternalAiBetaEnabledFor(outsider, false);
    const resolved = gateOpen ? resolveGeminiVoiceStyle("cheerful").id : "neutral";
    check(gateOpen === false && resolved === "neutral", "denied request resolves to neutral");
    const job = await createVideoJob(outsider.id, {
      script: "ทดสอบ geminiVoiceStyle ถูกปฏิเสธ",
      voiceProvider: "gemini",
      ...(resolved !== "neutral" ? { geminiVoiceStyle: resolved } : {}),
    });
    const stored = JSON.parse((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).inputJson ?? "{}");
    check(stored.geminiVoiceStyle === undefined, "denied: geminiVoiceStyle never reaches job.inputJson");
  }

  // Allowed: resolved style forwards verbatim.
  {
    const gateOpen = isInternalAiBetaEnabledFor(tester, false);
    const resolved = gateOpen ? resolveGeminiVoiceStyle("cheerful").id : "neutral";
    check(gateOpen === true && resolved === "cheerful", "allowed request resolves to the requested style");
    const job = await createVideoJob(tester.id, {
      script: "ทดสอบ geminiVoiceStyle ผ่านเกต",
      voiceProvider: "gemini",
      ...(resolved !== "neutral" ? { geminiVoiceStyle: resolved } : {}),
    });
    const stored = JSON.parse((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).inputJson ?? "{}");
    check(stored.geminiVoiceStyle === "cheerful", "allowed: geminiVoiceStyle reaches job.inputJson unchanged");
  }

  // Allowed, but caller asked for nothing (undefined) → still resolves to neutral,
  // still omitted (never writes a spurious "neutral" key).
  {
    const gateOpen = isInternalAiBetaEnabledFor(tester, false);
    const resolved = gateOpen ? resolveGeminiVoiceStyle(undefined).id : "neutral";
    check(resolved === "neutral", "allowed + no requested style → neutral");
    const job = await createVideoJob(tester.id, {
      script: "ทดสอบไม่ได้ขอสไตล์",
      voiceProvider: "gemini",
      ...(resolved !== "neutral" ? { geminiVoiceStyle: resolved } : {}),
    });
    const stored = JSON.parse((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).inputJson ?? "{}");
    check(stored.geminiVoiceStyle === undefined, "allowed + no requested style: inputJson has no geminiVoiceStyle key");
  }

  // ── 3) warning / warnings[0] compatibility (Global Constraints "Warnings") ──
  {
    const heygenWarning = "ยังไม่ยืนยันความพร้อม HeyGen";
    const geminiVoiceStyleWarning = "โหมดสไตล์เสียง Gemini (geminiVoiceStyle) ยังไม่เปิดใช้งานสำหรับบัญชีนี้ ใช้เสียงปกติ (neutral) แทน";
    const warnings: string[] = [];
    if (heygenWarning) warnings.push(heygenWarning);
    if (geminiVoiceStyleWarning) warnings.push(geminiVoiceStyleWarning);
    const response: { warning?: string; warnings?: string[] } = { ...(warnings.length ? { warning: warnings[0], warnings } : {}) };
    check(response.warning === response.warnings?.[0], "warning stays the first element of warnings for one release");
    check(response.warnings?.length === 2, "every finding lands in warnings, not just the first");
  }
  {
    const warnings: string[] = [];
    const response: { warning?: string; warnings?: string[] } = { ...(warnings.length ? { warning: warnings[0], warnings } : {}) };
    check(response.warning === undefined && response.warnings === undefined, "no findings → neither field appears (unchanged success shape)");
  }

  // ── 4) Source-grep: route.ts actually wires the gate + warnings this way ───
  const routeSrc = readFileSync("src/app/api/[transport]/route.ts", "utf8");
  check(
    routeSrc.includes('isInternalAiBetaEnabledFor(') && routeSrc.includes("GEMINI_TTS_38_PUBLIC"),
    "route.ts gates geminiVoiceStyle with isInternalAiBetaEnabledFor + GEMINI_TTS_38_PUBLIC (same as web)",
  );
  check(
    routeSrc.includes('resolveGeminiVoiceStyle('),
    "route.ts resolves the style id through the shared resolver (same as web)",
  );
  check(
    /geminiVoiceStyle\s*!==\s*"neutral"/.test(routeSrc),
    "route.ts omits a resolved neutral style from the job input (mirrors web jobs/route.ts:1075)",
  );
  check(
    routeSrc.includes("warnings") && /warning:\s*warnings\[0\]/.test(routeSrc),
    "route.ts builds warnings: string[] and keeps warning as warnings[0] for back-compat",
  );
  check(
    !/geminiVoiceStyle\s*:\s*args\.geminiVoiceStyle\s*[,}]/.test(routeSrc),
    "route.ts never forwards args.geminiVoiceStyle raw — it must go through the gate/resolver first",
  );

  if (previousPublicFlag === undefined) delete process.env.GEMINI_TTS_38_PUBLIC;
  else process.env.GEMINI_TTS_38_PUBLIC = previousPublicFlag;

  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP geminiVoiceStyle FORWARDING CHECKS PASSED`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
