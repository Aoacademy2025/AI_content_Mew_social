// smoke-hero-script-live.ts — permanent LIVE smoke test for the Hero Script
// LLM path (the one thing scripts/verify-hero-script.ts can never cover: that
// the configured model ids still exist and still answer in the JSON shape the
// validators demand — exactly the failure that forced HERO_SCRIPT_MODEL_PRO off
// gemini-2.5-pro on 2026-07-31).
//
// It runs the REAL path for both tiers, on BOTH providers (Task 7, 2026-07-31 —
// the HERO_SCRIPT_PROVIDER switch): prompt builder → heroScriptGenerateText
// (via generateValidatedJson, retry-once included) → the real validator.
//
//   (a) fast tier — /api/scripts/hooks       → validateHooksResponse
//   (b) pro  tier — /api/scripts/generate    → validateGenerateResponse
//
// Contract:
//   • Each provider SKIPs cleanly when its key is absent (no GEMINI_SERVER_KEY /
//     no OPENROUTER_API_KEY) — safe in CI / on a laptop with only one of them.
//   • NO DB writes: DATABASE_URL is repointed at a throwaway file before any
//     import, so the always-on Prisma client in src/lib/prisma.ts cannot touch
//     prisma/dev.db (or prod's DB) even to open it.
//   • Exit 1 if any step fails, 0 if all pass (or everything skipped).
//
// Run: npx tsx scripts/smoke-hero-script-live.ts

import dotenv from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

dotenv.config({ path: ".env", override: false, quiet: true });

// Belt and braces: src/lib/hero-script.server.ts pulls in src/lib/prisma.ts,
// which opens a connection at module load. Point it at a throwaway file so this
// script can never read or write a real database. Nothing here queries.
process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "heroscript-smoke-")), "unused.db")}`;

const TOPIC = "วิธีเก็บเงินก้อนแรกให้ได้ใน 3 เดือน";
const DURATION_SEC = 30;

/** A tiny brand profile so the shared brand block (including analysisNotes, the
 *  differentiator the profile analyze step feeds) is exercised too. */
const PROFILE = {
  niche: "การเงินส่วนบุคคลสำหรับมนุษย์เงินเดือนปีแรก",
  audience: "พนักงานออฟฟิศอายุ 23-28 เพิ่งเริ่มทำงาน",
  tone: "เป็นกันเอง ตรงไปตรงมา ไม่สอนแบบครู",
  bannedWords: ["รวยเร็ว"],
  analysisNotes: "ชอบเปิดด้วยตัวเลขจริง, ประโยคสั้น, ปิดด้วยคำถามชวนคิด",
};

/** Same redactions as api-error.ts's scrubSecrets, for the one place a raw
 *  provider message is printed — a Gemini error can carry `?key=AIza…`, an
 *  OpenRouter one an `Authorization: Bearer sk-or-…`. */
function scrub(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<redacted>")
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, "$1<redacted>")
    .replace(/([?&](?:key|api[_-]?key)=)[^&\s"'<>]+/gi, "$1<redacted>");
}

let failures = 0;
let ran = 0;
function step(name: string, passed: boolean, detail?: string) {
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

type Provider = "gemini" | "openrouter";

/** The key each provider needs; "" means "skip this provider". */
function keyFor(provider: Provider): string {
  // GEMINI_SERVER_KEY is the env src/lib/gemini-key.ts resolves for managed
  // mode; OPENROUTER_API_KEY is the server credential src/lib/openrouter.ts uses
  // for EVERY user (there is no OpenRouter BYOK).
  const raw = provider === "gemini" ? process.env.GEMINI_SERVER_KEY : process.env.OPENROUTER_API_KEY;
  return (raw ?? "").trim();
}

async function smokeProvider(provider: Provider) {
  const key = keyFor(provider);
  if (!key) {
    const envName = provider === "gemini" ? "GEMINI_SERVER_KEY" : "OPENROUTER_API_KEY";
    console.log(`\nSKIP [${provider}]: ${envName} is not set — that provider's live smoke skipped.`);
    return;
  }
  ran++;

  // The switch itself is what we are smoking: everything below reaches the
  // model through heroScriptGenerateText, which reads this env.
  process.env.HERO_SCRIPT_PROVIDER = provider;

  const { buildHooksPrompt, buildGeneratePrompt } = await import("../src/lib/prompts/hero-script");
  const {
    generateValidatedJson,
    validateHooksResponse,
    validateGenerateResponse,
    wordBudgetForDuration,
    heroScriptModel,
    heroScriptProvider,
    isModelUnavailableError,
    countWords,
    HOOK_MAX_WORDS,
  } = await import("../src/lib/hero-script.server");
  const { isOpenRouterCreditError, isOpenRouterAuthError } = await import("../src/lib/openrouter");

  console.log(`\n── provider: ${heroScriptProvider()} ──────────────────────────────`);
  console.log(`fast model: ${heroScriptModel("fast")}`);
  console.log(`pro  model: ${heroScriptModel("pro")}`);

  // Gemini reads the key from the caller; OpenRouter reads the server key
  // inside the client (apiKey is unused on that path).
  const apiKey = provider === "gemini" ? key : "";

  /** Why did a live call blow up? (never prints the raw provider message —
   *  that can embed a credential). */
  const why = (error: unknown, tier: "fast" | "pro"): string => {
    if (isOpenRouterCreditError(error)) return "PROVIDER_CREDIT — the OpenRouter balance/allowance is spent";
    if (isOpenRouterAuthError(error)) return "PROVIDER_AUTH — the server's OpenRouter credential was rejected/missing";
    if (isModelUnavailableError(error)) return `MODEL_UNAVAILABLE — '${heroScriptModel(tier)}' is gone/unusable`;
    return error instanceof Error ? `${error.name}: ${scrub(error.message).slice(0, 160)}` : String(error);
  };

  // ── (a) fast tier: hooks ────────────────────────────────────────────────
  let chosenHook: { formula: string; text: string } | null = null;
  const hooksStep = `[${provider}] fast tier (hooks) parses through validateHooksResponse`;
  try {
    const started = Date.now();
    const hooks = await generateValidatedJson({
      apiKey,
      prompt: buildHooksPrompt({ topic: TOPIC, durationSec: DURATION_SEC, profile: PROFILE }),
      maxOutputTokens: 2048,
      tier: "fast",
      validate: validateHooksResponse,
    });
    const ms = Date.now() - started;
    if (!hooks) {
      step(hooksStep, false, `no valid JSON after the retry (${ms}ms)`);
    } else {
      chosenHook = hooks.hooks[0];
      const longest = Math.max(...hooks.hooks.map((h) => countWords(h.text)));
      step(hooksStep, true, `${hooks.hooks.length} hooks, longest ${longest}/${HOOK_MAX_WORDS} คำ, ${ms}ms`);
      console.log(`       hook[0] (${chosenHook.formula}): ${chosenHook.text}`);
    }
  } catch (error) {
    step(hooksStep, false, why(error, "fast"));
  }

  // ── (b) pro tier: full script ───────────────────────────────────────────
  // Uses the hook from step (a) when there is one, so the two steps chain the
  // way the real flow does; falls back to a fixed hook so (b) still runs alone.
  const hookText = chosenHook?.text ?? "เงินเดือนออกวันที่ 25 แต่หมดวันที่ 5 ทุกเดือน";
  const genStep = `[${provider}] pro tier (generate) parses through validateGenerateResponse`;
  try {
    const started = Date.now();
    const script = await generateValidatedJson({
      apiKey,
      prompt: buildGeneratePrompt({
        topic: TOPIC,
        durationSec: DURATION_SEC,
        wordBudget: wordBudgetForDuration(DURATION_SEC),
        hookText,
        ctaStyle: "follow",
        profile: PROFILE,
      }),
      maxOutputTokens: 4096,
      tier: "pro",
      validate: validateGenerateResponse,
    });
    const ms = Date.now() - started;
    if (!script) {
      step(genStep, false, `no valid JSON after the retry (${ms}ms)`);
    } else {
      const lines = script.bodyText.split("\n");
      const blank = lines.some((l) => l.trim() === "");
      step(genStep, true, `structure='${script.structure}', ${lines.length} body lines, ${ms}ms`);
      step(`[${provider}] pro tier body holds the 1 บรรทัด = 1 ประโยค invariant`, !blank,
        blank ? "a blank line survived normalizeLines" : "no blank lines");
      console.log(`       body[0]: ${lines[0]}`);
      console.log(`       cta    : ${script.ctaText.split("\n")[0]}`);
    }
  } catch (error) {
    const detail = why(error, "pro");
    step(genStep, false,
      detail.startsWith("MODEL_UNAVAILABLE") ? `${detail} (set the tier's model env to a live id)` : detail);
  }
}

async function main() {
  console.log(`topic: ${TOPIC} (${DURATION_SEC}s)`);

  // Both providers, every time: the switch is only trustworthy if the path it
  // is NOT currently pointing at is known to work too (that is the rollback).
  for (const provider of ["gemini", "openrouter"] as Provider[]) {
    await smokeProvider(provider);
  }

  if (ran === 0) {
    console.log("\nSKIP: no provider key configured — nothing was smoked.");
    process.exit(0);
  }
  console.log(`\n${failures === 0 ? `✅ live smoke passed (${ran} provider(s))` : `❌ ${failures} step(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  // Scrubbed: a raw provider error message can embed the API key.
  console.error(
    "FAIL: smoke aborted —",
    e instanceof Error ? `${e.name}: ${scrub(e.message).slice(0, 300)}` : "unknown error"
  );
  process.exit(1);
});
