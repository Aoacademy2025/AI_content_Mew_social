// verify-hero-script.ts — Hero Script v1 (Tasks 1-2): schema + BrandProfile
// vertical slice, viral framework library, and ideas/hooks generation.
//
// Exercises the service layer directly (src/lib/hero-script.server.ts,
// src/lib/prompts/hero-script.ts, src/lib/viral-frameworks.ts) against a
// throwaway SQLite DB — the routes stay thin wrappers over this logic (per
// the shared spec) so there's no need to fake a Clerk session here. NEVER
// points at prisma/dev.db.
//
// Run: npx tsx scripts/verify-hero-script.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "heroscript-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const {
    parseBannedWords,
    serializeBannedWords,
    toBrandProfileDTO,
    canCreateBrandProfile,
    validateNicheSeed,
    NICHE_SEED_MAX_CHARS,
    parseJsonResponse,
    validateAnalyzeResponse,
    validateNicheIdeasResponse,
    resolveLlmTriad,
    wordBudgetForDuration,
    getRecentScriptTopics,
    validateIdeasResponse,
    validateHooksResponse,
    countWords,
    validateTopic,
    TOPIC_MAX_CHARS,
    isValidDurationSec,
    // Task 3
    assembleScript,
    containsBannedWord,
    findBannedWord,
    bannedWordWarning,
    generateWithBannedWordGuard,
    heroScriptModel,
    validateGenerateResponse,
    validateRegenResponse,
    isValidRegenTarget,
    stripEchoedHook,
    createScript,
    listScripts,
    getScript,
    updateScript,
    deleteScript,
    ownsBrandProfile,
    SCRIPT_LIST_LIMIT,
    // Task 4
    normalizeLines,
    assembleScriptForHandoff,
    countScriptsInWindow,
    canCreateScript,
    createScriptWithinCap,
    sendScriptToEditor,
    SCRIPT_WINDOW_DAYS,
    // Fix wave (final review)
    isModelUnavailableError,
    MODEL_UNAVAILABLE_CODE,
    MODEL_UNAVAILABLE_MESSAGE,
    PRO_TIER_TEXT_CALL_COST,
    // Task 7: provider switch (Gemini ⇄ OpenRouter)
    resolveHeroScriptProvider,
    heroScriptProvider,
    heroScriptLlmErrorResponse,
    HERO_SCRIPT_PROVIDER_DEFAULT,
    PROVIDER_CREDIT_CODE,
    PROVIDER_UNAVAILABLE_CODE,
  } = await import("../src/lib/hero-script.server");
  const {
    classifyOpenRouterFailure,
    openRouterError,
    isOpenRouterCreditError,
    isOpenRouterAuthError,
    extractOpenRouterContent,
    scrubOpenRouterSecrets,
    wrapOpenRouterTransportError,
    OPENROUTER_CREDIT_MESSAGE,
    OPENROUTER_MODEL_FAST_DEFAULT,
    OPENROUTER_MODEL_PRO_DEFAULT,
  } = await import("../src/lib/openrouter");
  // The generic scrubber every route's error path runs through (defense in
  // depth for the sk-or- key shape — see the OpenRouter classification block).
  const { scrubSecrets: scrubApiErrorSecrets } = await import("../src/lib/api-error");
  const { BRAND_PROFILE_CAPS, checkBrandProfileFieldLimits } = await import("../src/lib/brand-profile-limits");
  const { providerError, toErrorResponse } = await import("../src/lib/provider-errors");
  const { reserveAiTextCall, aiTextCallCeilingFor } = await import("../src/lib/ai-text-limits");
  const { syncMinuteWindow } = await import("../src/lib/minute-limits");
  const {
    buildAnalyzePrompt,
    buildNicheDrilldownPrompt,
    buildBrandBlock,
    buildIdeasPrompt,
    buildHooksPrompt,
    // Task 3
    buildGeneratePrompt,
    buildRegenPrompt,
    buildBannedWordRetryNote,
  } = await import("../src/lib/prompts/hero-script");
  const {
    HOOK_FORMULAS,
    HOOK_FORMULA_KEYS,
    STORY_STRUCTURES,
    RETENTION_RULES,
    CTA_STYLES,
    isValidHookFormulaKey,
    isValidStoryStructureKey,
    isValidCtaStyleKey,
  } = await import("../src/lib/viral-frameworks");
  const { checkAiInputCaps } = await import("../src/lib/ai-input-caps");
  const { prisma } = await import("../src/lib/prisma");
  const { FREE_LIMITS, PRO_LIMITS, BUSINESS_LIMITS } = await import("../src/lib/plan-limits");
  const { encryptKey } = await import("../src/lib/key-crypto");
  const { isHeroScriptAllowedEmail } = await import("../src/lib/hero-script-access");

  // ── Post-review amendment (2026-07-31): Hero Script internal-beta allowlist
  // matcher — exact match, ANCHORED @-domain match (not a raw string suffix —
  // that was a confirmed security bypass, fixed same day), case-insensitivity
  // on both sides, empty env = deny (fail-closed), malformed entries ignored.
  {
    const env = "duckyhero@gmail.com,@aoacademy";
    ok(isHeroScriptAllowedEmail("duckyhero@gmail.com", env) === true,
      "isHeroScriptAllowedEmail: exact match allowed");
    ok(isHeroScriptAllowedEmail("DuckyHero@Gmail.com", env) === true,
      "isHeroScriptAllowedEmail: exact match is case-insensitive");
    ok(isHeroScriptAllowedEmail("y@aoacademy", env) === true,
      "isHeroScriptAllowedEmail: @-domain match allowed against the bare domain itself (exact)");
    ok(isHeroScriptAllowedEmail("Y@AOACADEMY", env) === true,
      "isHeroScriptAllowedEmail: @-domain match is case-insensitive on the email side");
    ok(isHeroScriptAllowedEmail("team@aoacademy", "duckyhero@gmail.com,@AOACADEMY") === true,
      "isHeroScriptAllowedEmail: @-domain match is case-insensitive on the entry side");
    ok(isHeroScriptAllowedEmail("random@gmail.com", env) === false,
      "isHeroScriptAllowedEmail: non-matching email denied");
    ok(isHeroScriptAllowedEmail("notduckyhero@gmail.com", env) === false,
      "isHeroScriptAllowedEmail: exact-match entry does not do substring/suffix matching");
    ok(isHeroScriptAllowedEmail(null, env) === false,
      "isHeroScriptAllowedEmail: null email denied");
    ok(isHeroScriptAllowedEmail(undefined, env) === false,
      "isHeroScriptAllowedEmail: undefined email denied");
    ok(isHeroScriptAllowedEmail("  ", env) === false,
      "isHeroScriptAllowedEmail: blank/whitespace email denied");
    // Security fix (2026-07-31, round 2): a "starts-with" / TLD-agnostic
    // fallback for TLD-less entries ("@aoacademy" reaching "aoacademy.com")
    // was ITSELF an unanchored bypass — anyone who owns ANY domain can prefix
    // it with "aoacademy." (e.g. "attacker@aoacademy.evilhacker.io") and pass
    // a naive startsWith("aoacademy.") check. That branch is REMOVED. Final
    // rule for "@X" entries: emailDomain === X || emailDomain.endsWith("."+X)
    // only. Consequence (deliberate): entries must be exact emails or FULL
    // domains including the TLD — a TLD-less entry like "@aoacademy" matches
    // ONLY the literal domain "aoacademy" (and real subdomains of it), never
    // "aoacademy.com" / "aoacademy.co.th".
    ok(isHeroScriptAllowedEmail("attacker@evilaoacademy", env) === false,
      "isHeroScriptAllowedEmail: crafted 'evilaoacademy' domain denied (anchored, not raw suffix)");
    ok(isHeroScriptAllowedEmail("attacker@evilaoacademy.com", env) === false,
      "isHeroScriptAllowedEmail: crafted 'evilaoacademy.com' domain denied");
    ok(isHeroScriptAllowedEmail("attacker@aoacademy.evilhacker.io", env) === false,
      "isHeroScriptAllowedEmail: TLD-less entry does NOT let attacker-owned 'aoacademy.evilhacker.io' pass (starts-with bypass removed)");
    ok(isHeroScriptAllowedEmail("attacker@aoacademy.attacker-domain.com", env) === false,
      "isHeroScriptAllowedEmail: TLD-less entry does NOT let attacker-owned 'aoacademy.attacker-domain.com' pass");
    ok(isHeroScriptAllowedEmail("team@aoacademy.com", env) === false,
      "isHeroScriptAllowedEmail: TLD-less entry no longer matches 'aoacademy.com' (must be the literal domain now)");
    ok(isHeroScriptAllowedEmail("x@aoacademy.co.th", env) === false,
      "isHeroScriptAllowedEmail: TLD-less entry no longer matches 'aoacademy.co.th' either");
    ok(isHeroScriptAllowedEmail("a@sub.aoacademy.com", "@aoacademy.com") === true,
      "isHeroScriptAllowedEmail: a FULL-domain entry (with TLD) still matches a real subdomain (sub.aoacademy.com)");
    ok(isHeroScriptAllowedEmail("a@evilaoacademy.com", "@aoacademy.com") === false,
      "isHeroScriptAllowedEmail: a full-domain entry denies a crafted lookalike domain");
    ok(isHeroScriptAllowedEmail("attacker@aoacademy.com.evilhacker.io", "@aoacademy.com") === false,
      "isHeroScriptAllowedEmail: a full-domain entry does NOT let attacker-owned 'aoacademy.com.evilhacker.io' pass");
    ok(isHeroScriptAllowedEmail("a@aoacademy.com", "@aoacademy.com") === true,
      "isHeroScriptAllowedEmail: a full-domain entry matches its exact domain");
    // Fail-closed: empty/unset env locks EVERYONE out, including the product owner.
    ok(isHeroScriptAllowedEmail("duckyhero@gmail.com", undefined) === false,
      "isHeroScriptAllowedEmail: unset env denies even the default product-owner email (fail-closed)");
    ok(isHeroScriptAllowedEmail("duckyhero@gmail.com", "") === false,
      "isHeroScriptAllowedEmail: empty-string env denies everyone (fail-closed)");
    ok(isHeroScriptAllowedEmail("duckyhero@gmail.com", "   ") === false,
      "isHeroScriptAllowedEmail: whitespace-only env denies everyone (fail-closed)");
    // Malformed entries (blank segments, a bare "@") are ignored, not errors —
    // and never accidentally match everything.
    const malformed = "  , @ ,,duckyhero@gmail.com,  ";
    ok(isHeroScriptAllowedEmail("duckyhero@gmail.com", malformed) === true,
      "isHeroScriptAllowedEmail: malformed entries ignored, the valid entry still matches");
    ok(isHeroScriptAllowedEmail("anything@example.com", malformed) === false,
      "isHeroScriptAllowedEmail: a bare '@' entry matches nothing (not a wildcard)");
  }

  // ── plan-limits: brandProfiles caps ─────────────────────────────────────
  ok(FREE_LIMITS.brandProfiles === 1, "plan-limits: FREE brandProfiles cap = 1");
  ok(PRO_LIMITS.brandProfiles === 5, "plan-limits: PRO brandProfiles cap = 5");
  ok(BUSINESS_LIMITS.brandProfiles === Infinity, "plan-limits: BUSINESS brandProfiles cap = Infinity");

  // ── bannedWords (de)serialization round trip ────────────────────────────
  ok(parseBannedWords(undefined).length === 0, "parseBannedWords(undefined) → []");
  ok(parseBannedWords(null).length === 0, "parseBannedWords(null) → []");
  ok(parseBannedWords("not json").length === 0, "parseBannedWords(malformed) → [] (never throws)");
  ok(parseBannedWords("[]").length === 0, "parseBannedWords('[]') → []");
  {
    const words = ["คำต้องห้าม1", "คำต้องห้าม2", "  ", "", 42 as unknown as string];
    const serialized = serializeBannedWords(words);
    const roundTripped = parseBannedWords(serialized);
    ok(JSON.stringify(roundTripped) === JSON.stringify(["คำต้องห้าม1", "คำต้องห้าม2"]),
      "serializeBannedWords → parseBannedWords round trip drops blanks/non-strings");
  }
  ok(serializeBannedWords(null) === "[]", "serializeBannedWords(null) → '[]'");
  ok(serializeBannedWords(undefined) === "[]", "serializeBannedWords(undefined) → '[]'");

  // ── canCreateBrandProfile: FREE 1 / PRO 5 / BUSINESS Infinity ───────────
  {
    const free0 = canCreateBrandProfile("FREE", 0);
    ok(free0.allowed === true && free0.cap === 1, "FREE with 0 profiles → allowed (cap 1)");
    const free1 = canCreateBrandProfile("FREE", 1);
    ok(free1.allowed === false, "FREE at cap (1 profile) → blocked (2nd profile)");
    ok(typeof free1.message === "string" && free1.message.includes("Free") && free1.message.includes("1"),
      "FREE block message mentions plan label and cap");
    ok(free1.message === "แผน Free เซฟนิชได้ 1 โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช",
      "FREE block message matches the API contracts table verbatim");
  }
  {
    for (let n = 0; n < 5; n++) {
      const r = canCreateBrandProfile("PRO", n);
      ok(r.allowed === true, `PRO with ${n} profiles → allowed (cap 5)`);
    }
    const pro5 = canCreateBrandProfile("PRO", 5);
    ok(pro5.allowed === false, "PRO at cap (5 profiles) → blocked (6th profile)");
    ok(pro5.message === "แผน Pro เซฟนิชได้ 5 โปรไฟล์ — อัปเกรดเพื่อเพิ่มนิช",
      "PRO block message matches the API contracts table verbatim");
  }
  {
    const biz = canCreateBrandProfile("BUSINESS", 9999);
    ok(biz.allowed === true, "BUSINESS with 9999 profiles → still allowed (Infinity cap)");
  }

  // ── BrandProfile CRUD roundtrip (throwaway SQLite) ──────────────────────
  await prisma.user.deleteMany({ where: { id: { in: ["hs-free", "hs-pro", "hs-business"] } } });
  await prisma.user.createMany({
    data: [
      { id: "hs-free", name: "Free User", email: "hs-free@example.test", plan: "FREE" },
      { id: "hs-pro", name: "Pro User", email: "hs-pro@example.test", plan: "PRO" },
      { id: "hs-business", name: "Business User", email: "hs-business@example.test", plan: "BUSINESS" },
    ],
  });

  const created = await prisma.brandProfile.create({
    data: {
      userId: "hs-free",
      name: "ช่องการเงิน",
      niche: "การเงินสาย dark เล่ากลโกงและคดีดัง",
      audience: "มนุษย์เงินเดือน 25-35",
      tone: "เป็นกันเอง ขี้เล่น มีสาระ",
      bannedWords: serializeBannedWords(["โกหก", "หลอกลวง"]),
      ctaStyle: "follow",
    },
  });
  ok(!!created.id, "BrandProfile.create → row created");
  ok(created.bannedWords === '["โกหก","หลอกลวง"]', "BrandProfile.create stores bannedWords as a JSON string");

  const dto = toBrandProfileDTO(created);
  ok(Array.isArray(dto.bannedWords) && dto.bannedWords.length === 2,
    "toBrandProfileDTO parses bannedWords back into an array");
  ok(dto.bannedWords[0] === "โกหก" && dto.bannedWords[1] === "หลอกลวง",
    "toBrandProfileDTO preserves bannedWords order/content");

  const fetched = await prisma.brandProfile.findUnique({ where: { id: created.id } });
  ok(fetched?.name === "ช่องการเงิน", "BrandProfile read-back matches what was created");

  const updated = await prisma.brandProfile.update({
    where: { id: created.id },
    data: { tone: "จริงจังขึ้น", bannedWords: serializeBannedWords(["โกหก"]) },
  });
  ok(updated.tone === "จริงจังขึ้น", "BrandProfile.update persists a changed field");
  ok(parseBannedWords(updated.bannedWords).length === 1, "BrandProfile.update persists a changed bannedWords list");

  await prisma.brandProfile.delete({ where: { id: created.id } });
  const afterDelete = await prisma.brandProfile.findUnique({ where: { id: created.id } });
  ok(afterDelete === null, "BrandProfile.delete removes the row");

  // Cascade: deleting the User cascades to BrandProfile (schema onDelete: Cascade).
  const cascadeProfile = await prisma.brandProfile.create({
    data: { userId: "hs-business", name: "Cascade check", niche: "x", audience: "x", tone: "x" },
  });
  await prisma.user.delete({ where: { id: "hs-business" } });
  const afterUserDelete = await prisma.brandProfile.findUnique({ where: { id: cascadeProfile.id } });
  ok(afterUserDelete === null, "deleting a User cascades to delete their BrandProfile rows");

  // ── canCreateBrandProfile against real DB counts (FREE 2nd, PRO 6th) ────
  await prisma.brandProfile.create({
    data: { userId: "hs-free", name: "Only slot", niche: "x", audience: "x", tone: "x" },
  });
  const freeCount = await prisma.brandProfile.count({ where: { userId: "hs-free" } });
  ok(freeCount === 1, "FREE user has 1 saved profile");
  const freeCap = canCreateBrandProfile("FREE", freeCount);
  ok(freeCap.allowed === false, "FREE user with 1 saved profile → 2nd create blocked (PROFILE_LIMIT)");

  for (let i = 0; i < 5; i++) {
    await prisma.brandProfile.create({
      data: { userId: "hs-pro", name: `Pro slot ${i}`, niche: "x", audience: "x", tone: "x" },
    });
  }
  const proCount = await prisma.brandProfile.count({ where: { userId: "hs-pro" } });
  ok(proCount === 5, "PRO user has 5 saved profiles");
  const proCap = canCreateBrandProfile("PRO", proCount);
  ok(proCap.allowed === false, "PRO user with 5 saved profiles → 6th create blocked (PROFILE_LIMIT)");

  // ── NICHE prompt builder: contains seed + JSON contract ─────────────────
  {
    const seed = "การเงินส่วนบุคคล";
    const prompt = buildNicheDrilldownPrompt(seed);
    ok(prompt.includes(seed), "buildNicheDrilldownPrompt embeds the seed verbatim");
    ok(prompt.includes('{"niches":[{"niche":"...","why":"...","audience":"...","sampleTopics":["...","..."]}]}'),
      "buildNicheDrilldownPrompt includes the exact JSON contract from the spec");
    ok(prompt.includes("นิชเจาะลึก 7 นิช"), "buildNicheDrilldownPrompt asks for 7 niches (spec copy present)");
    ok(prompt.includes("อย่างน้อย 2 ระดับ"), "buildNicheDrilldownPrompt includes the 2-level depth rule (spec copy present)");
  }

  // ── ANALYZE prompt builder: contains sample + JSON contract ─────────────
  {
    const sample = "ตัวอย่างข้อความทดสอบ";
    const prompt = buildAnalyzePrompt(sample);
    ok(prompt.includes(sample), "buildAnalyzePrompt embeds the sample text");
    ok(prompt.includes('{"niche":"...","audience":"...","tone":"...","analysisNotes":"จุดเด่นสำนวน/เทคนิค hook/โครงที่ใช้ประจำ (3-5 bullet)"}'),
      "buildAnalyzePrompt includes the exact JSON contract from the spec");
    ok(prompt.includes("วิเคราะห์ตัวอย่างคอนเทนต์นี้ แล้วสกัดโปรไฟล์แบรนด์"),
      "buildAnalyzePrompt includes the exact instruction line from the spec");
  }

  // ── validateNicheSeed: required + ≤300 chars ─────────────────────────────
  ok(NICHE_SEED_MAX_CHARS === 300, "NICHE_SEED_MAX_CHARS = 300 per spec");
  ok(validateNicheSeed(undefined).ok === false, "validateNicheSeed(undefined) → rejected");
  ok(validateNicheSeed("").ok === false, "validateNicheSeed('') → rejected");
  ok(validateNicheSeed("   ").ok === false, "validateNicheSeed(whitespace) → rejected");
  ok(validateNicheSeed("x".repeat(300)).ok === true, "validateNicheSeed(300 chars) → accepted (boundary inclusive)");
  ok(validateNicheSeed("x".repeat(301)).ok === false, "validateNicheSeed(301 chars) → rejected");
  {
    const trimmed = validateNicheSeed("  หัวข้อ  ");
    ok(trimmed.ok === true && trimmed.seed === "หัวข้อ", "validateNicheSeed trims surrounding whitespace");
  }

  // ── parseJsonResponse: strips ```json fences, never throws ──────────────
  ok(parseJsonResponse(null) === null, "parseJsonResponse(null) → null");
  ok(parseJsonResponse("not json") === null, "parseJsonResponse(malformed) → null (never throws)");
  {
    const fenced = '```json\n{"a":1}\n```';
    const parsed = parseJsonResponse(fenced) as { a: number } | null;
    ok(parsed?.a === 1, "parseJsonResponse strips ```json fences");
  }

  // ── validateAnalyzeResponse ───────────────────────────────────────────
  ok(validateAnalyzeResponse(null) === null, "validateAnalyzeResponse(null) → null");
  ok(validateAnalyzeResponse({ niche: "x" }) === null, "validateAnalyzeResponse(missing fields) → null");
  ok(validateAnalyzeResponse({ niche: "", audience: "a", tone: "t", analysisNotes: "n" }) === null,
    "validateAnalyzeResponse(blank niche) → null");
  {
    const good = validateAnalyzeResponse({
      niche: " การเงิน ", audience: "a", tone: "t", analysisNotes: "n",
    });
    ok(good?.niche === "การเงิน", "validateAnalyzeResponse trims fields and accepts a full payload");
  }

  // ── validateNicheIdeasResponse: exactly 7 items, sampleTopics length 2 ──
  const goodNiche = { niche: "n", why: "w", audience: "a", sampleTopics: ["t1", "t2"] };
  ok(validateNicheIdeasResponse(null) === null, "validateNicheIdeasResponse(null) → null");
  ok(validateNicheIdeasResponse({ niches: Array(6).fill(goodNiche) }) === null,
    "validateNicheIdeasResponse(6 items) → null (must be exactly 7)");
  ok(validateNicheIdeasResponse({ niches: Array(8).fill(goodNiche) }) === null,
    "validateNicheIdeasResponse(8 items) → null (must be exactly 7)");
  ok(validateNicheIdeasResponse({ niches: [...Array(6).fill(goodNiche), { ...goodNiche, sampleTopics: ["only-one"] }] }) === null,
    "validateNicheIdeasResponse(sampleTopics length 1) → null");
  {
    const good = validateNicheIdeasResponse({ niches: Array(7).fill(goodNiche) });
    ok(good?.niches.length === 7, "validateNicheIdeasResponse(7 valid items) → accepted");
    ok(good?.niches[0].sampleTopics[0] === "t1" && good?.niches[0].sampleTopics[1] === "t2",
      "validateNicheIdeasResponse preserves sampleTopics content");
  }

  // ══════════════════════════════════════════════════════════════════════
  // Task 2: viral framework library + ideas/hooks generation
  // ══════════════════════════════════════════════════════════════════════

  // ── PUT /api/brand-profiles/[id] ctaStyle skip-if-absent (bug fix) ──────
  {
    const profileForCtaTest = await prisma.brandProfile.create({
      data: { userId: "hs-free", name: "CTA test", niche: "x", audience: "x", tone: "x", ctaStyle: "comment" },
    });
    // Mirrors exactly what the route now does: `ctaStyle` stays `undefined`
    // when absent from the PUT body (was hard-coded to "follow" before the fix).
    const ctaStyle = undefined;
    await prisma.brandProfile.updateMany({
      where: { id: profileForCtaTest.id },
      data: { name: "CTA test updated", ctaStyle },
    });
    const after = await prisma.brandProfile.findUnique({ where: { id: profileForCtaTest.id } });
    ok(after?.ctaStyle === "comment",
      "PUT with ctaStyle omitted from the body does NOT reset ctaStyle back to 'follow' (Task 2 bug fix)");
  }

  // ── PUT skip-if-absent, part 2: bannedWords + the analyze columns ───────
  //
  // Same class of bug as ctaStyle above: an omitted `bannedWords` key used to
  // serialize [] and wipe the stored list, and analysisNotes/sampleText/
  // sampleUrl were POST-only (an edit could never set them). These blocks
  // mirror the exact expressions the route computes.
  {
    const row = await prisma.brandProfile.create({
      data: {
        userId: "hs-free", name: "Skip-if-absent", niche: "x", audience: "x", tone: "x",
        bannedWords: serializeBannedWords(["โกหก", "หลอกลวง"]),
        analysisNotes: "โน้ตเดิม", sampleText: "ตัวอย่างเดิม", sampleUrl: "https://old.example.test",
      },
    });

    // A PUT body carrying ONLY the four required fields.
    const bodyWithoutOptionals: Record<string, unknown> = { name: "ชื่อใหม่", niche: "x", audience: "x", tone: "x" };
    const patchFor = (body: Record<string, unknown>) => ({
      bannedWords: Array.isArray(body.bannedWords) ? body.bannedWords : undefined,
      analysisNotes: typeof body.analysisNotes === "string" ? body.analysisNotes.trim() || null : undefined,
      sampleText: typeof body.sampleText === "string" ? body.sampleText.trim() || null : undefined,
      sampleUrl: typeof body.sampleUrl === "string" ? body.sampleUrl.trim() || null : undefined,
    });

    {
      const p = patchFor(bodyWithoutOptionals);
      await prisma.brandProfile.updateMany({
        where: { id: row.id },
        data: {
          name: String(bodyWithoutOptionals.name),
          bannedWords: p.bannedWords ? serializeBannedWords(p.bannedWords) : undefined,
          analysisNotes: p.analysisNotes,
          sampleText: p.sampleText,
          sampleUrl: p.sampleUrl,
        },
      });
      const after = await prisma.brandProfile.findUnique({ where: { id: row.id } });
      ok(after?.name === "ชื่อใหม่", "PUT without optional keys still applies the required fields");
      ok(parseBannedWords(after?.bannedWords).length === 2,
        "PUT with bannedWords omitted does NOT reset the list to [] (bug fix)");
      ok(after?.analysisNotes === "โน้ตเดิม" && after?.sampleText === "ตัวอย่างเดิม"
        && after?.sampleUrl === "https://old.example.test",
        "PUT with the analyze columns omitted leaves them untouched");
    }

    // Explicitly patching them DOES write (analysisNotes is now patchable).
    {
      const body = {
        analysisNotes: "  โน้ตใหม่จาก analyze  ",
        sampleText: "ตัวอย่างใหม่",
        sampleUrl: "https://new.example.test",
        bannedWords: ["เฉพาะคำเดียว"],
      };
      const p = patchFor(body);
      await prisma.brandProfile.updateMany({
        where: { id: row.id },
        data: {
          bannedWords: p.bannedWords ? serializeBannedWords(p.bannedWords) : undefined,
          analysisNotes: p.analysisNotes,
          sampleText: p.sampleText,
          sampleUrl: p.sampleUrl,
        },
      });
      const after = await prisma.brandProfile.findUnique({ where: { id: row.id } });
      ok(after?.analysisNotes === "โน้ตใหม่จาก analyze",
        "PUT with analysisNotes present persists it (trimmed) — the column is patchable now");
      ok(after?.sampleText === "ตัวอย่างใหม่" && after?.sampleUrl === "https://new.example.test",
        "PUT persists sampleText/sampleUrl when they are present");
      ok(parseBannedWords(after?.bannedWords).length === 1,
        "PUT with bannedWords present replaces the stored list");
    }

    // An EXPLICIT empty array still clears the list; a blank string clears the column.
    {
      const p = patchFor({ bannedWords: [], analysisNotes: "   " });
      await prisma.brandProfile.updateMany({
        where: { id: row.id },
        data: {
          bannedWords: p.bannedWords ? serializeBannedWords(p.bannedWords) : undefined,
          analysisNotes: p.analysisNotes,
        },
      });
      const after = await prisma.brandProfile.findUnique({ where: { id: row.id } });
      ok(parseBannedWords(after?.bannedWords).length === 0,
        "PUT with an explicit bannedWords: [] DOES clear the list (absent ≠ empty)");
      ok(after?.analysisNotes === null, "PUT with a blank analysisNotes clears the column to NULL");
    }

    await prisma.brandProfile.delete({ where: { id: row.id } });
  }

  // ── BrandProfile length caps (brand-profile-limits.ts) ──────────────────
  //
  // Every one of these fields is rendered into buildBrandBlock on EVERY later
  // LLM call but never passes through checkAiInputCaps — unbounded, one saved
  // profile is a permanent per-call token-spend amplifier on the managed key.
  {
    const base = { name: "n", niche: "n", audience: "a", tone: "t" };
    ok(checkBrandProfileFieldLimits(base).ok === true, "checkBrandProfileFieldLimits: a normal profile passes");
    ok(checkBrandProfileFieldLimits({}).ok === true,
      "checkBrandProfileFieldLimits: absent fields are skipped (presence is the route's own check)");

    ok(BRAND_PROFILE_CAPS.shortFieldChars === 300, "BRAND_PROFILE_CAPS.shortFieldChars = 300");
    ok(BRAND_PROFILE_CAPS.longFieldChars === 4000, "BRAND_PROFILE_CAPS.longFieldChars = 4,000");
    ok(BRAND_PROFILE_CAPS.urlChars === 2048, "BRAND_PROFILE_CAPS.urlChars = 2,048");
    ok(BRAND_PROFILE_CAPS.bannedWords === 20, "BRAND_PROFILE_CAPS.bannedWords = 20 items");
    ok(BRAND_PROFILE_CAPS.bannedWordChars === 50, "BRAND_PROFILE_CAPS.bannedWordChars = 50");

    for (const key of ["name", "niche", "audience", "tone"] as const) {
      ok(checkBrandProfileFieldLimits({ ...base, [key]: "x".repeat(300) }).ok === true,
        `checkBrandProfileFieldLimits: ${key} at 300 chars → accepted (boundary inclusive)`);
      const over = checkBrandProfileFieldLimits({ ...base, [key]: "x".repeat(301) });
      ok(over.ok === false, `checkBrandProfileFieldLimits: ${key} at 301 chars → rejected`);
      ok(!over.ok && over.message.startsWith("กรุณาระบุ") && over.message.includes("300"),
        `checkBrandProfileFieldLimits: ${key} over-cap message is Thai and names the cap`);
    }

    for (const key of ["analysisNotes", "sampleText"] as const) {
      ok(checkBrandProfileFieldLimits({ ...base, [key]: "x".repeat(4000) }).ok === true,
        `checkBrandProfileFieldLimits: ${key} at 4,000 chars → accepted (boundary inclusive)`);
      ok(checkBrandProfileFieldLimits({ ...base, [key]: "x".repeat(4001) }).ok === false,
        `checkBrandProfileFieldLimits: ${key} at 4,001 chars → rejected`);
    }

    ok(checkBrandProfileFieldLimits({ ...base, sampleUrl: "https://x.test/" + "a".repeat(2033) }).ok === true,
      "checkBrandProfileFieldLimits: sampleUrl at 2,048 chars → accepted (boundary inclusive)");
    ok(checkBrandProfileFieldLimits({ ...base, sampleUrl: "x".repeat(2049) }).ok === false,
      "checkBrandProfileFieldLimits: sampleUrl at 2,049 chars → rejected");

    ok(checkBrandProfileFieldLimits({ ...base, bannedWords: Array(20).fill("คำ") }).ok === true,
      "checkBrandProfileFieldLimits: 20 banned words → accepted (boundary inclusive)");
    const tooMany = checkBrandProfileFieldLimits({ ...base, bannedWords: Array(21).fill("คำ") });
    ok(tooMany.ok === false, "checkBrandProfileFieldLimits: 21 banned words → rejected");
    ok(!tooMany.ok && tooMany.message.includes("20"), "banned-words count message names the 20-item cap");
    ok(checkBrandProfileFieldLimits({ ...base, bannedWords: ["x".repeat(50)] }).ok === true,
      "checkBrandProfileFieldLimits: a 50-char banned word → accepted (boundary inclusive)");
    const longWord = checkBrandProfileFieldLimits({ ...base, bannedWords: ["x".repeat(51)] });
    ok(longWord.ok === false, "checkBrandProfileFieldLimits: a 51-char banned word → rejected");
    ok(!longWord.ok && longWord.message.includes("50"), "banned-word length message names the 50-char cap");
    ok(checkBrandProfileFieldLimits({ ...base, bannedWords: "not-an-array" }).ok === true,
      "checkBrandProfileFieldLimits: a non-array bannedWords is skipped, not crashed on");

    // The abuse case the cap exists for: a megabyte 'tone' would otherwise be
    // replayed into every ideas/hooks/generate/regen prompt, forever.
    const huge = checkBrandProfileFieldLimits({ ...base, tone: "ก".repeat(1_000_000) });
    ok(huge.ok === false, "checkBrandProfileFieldLimits: a 1MB tone is rejected (token-spend amplifier)");
  }

  // ── ctaStyle is validated on write (POST + PUT) ─────────────────────────
  {
    // The exact expressions the two routes compute.
    const postCtaStyle = (body: Record<string, unknown>) =>
      typeof body.ctaStyle === "string" && body.ctaStyle.trim() ? body.ctaStyle.trim() : "follow";
    const putCtaStyle = (body: Record<string, unknown>) =>
      typeof body.ctaStyle === "string" && body.ctaStyle.trim() ? body.ctaStyle.trim() : undefined;

    ok(isValidCtaStyleKey(postCtaStyle({})) === true, "POST default ctaStyle ('follow') is a valid key");
    ok(isValidCtaStyleKey(postCtaStyle({ ctaStyle: "sell" })) === true, "POST accepts a real ctaStyle key");
    ok(isValidCtaStyleKey(postCtaStyle({ ctaStyle: "ignore-all-rules" })) === false,
      "POST rejects an invalid ctaStyle key (400)");
    for (const style of CTA_STYLES) {
      ok(isValidCtaStyleKey(style.key) === true, `ctaStyle '${style.key}' from the library is accepted`);
    }
    ok(putCtaStyle({}) === undefined, "PUT with ctaStyle absent skips validation AND the write");
    const putInvalid = putCtaStyle({ ctaStyle: "drop-table" });
    ok(putInvalid !== undefined && isValidCtaStyleKey(putInvalid) === false,
      "PUT rejects an invalid ctaStyle key (400)");
  }

  // ── isModelUnavailableError: the 404 'model is gone' class only ─────────
  {
    ok(MODEL_UNAVAILABLE_CODE === "MODEL_UNAVAILABLE", "MODEL_UNAVAILABLE_CODE is the documented code");
    ok(MODEL_UNAVAILABLE_MESSAGE === "โมเดล AI สำหรับเขียนสคริปต์ไม่พร้อมใช้งานชั่วคราว โปรดลองใหม่อีกครั้งหรือแจ้งทีมงาน",
      "MODEL_UNAVAILABLE_MESSAGE matches the agreed Thai copy verbatim");

    const notFound = providerError(
      "fatal", "gemini",
      '{"error":{"code":404,"message":"models/gemini-2.5-pro is not found for API version v1beta, or is not supported for generateContent"}}',
      { status: 404 }
    );
    ok(isModelUnavailableError(notFound) === true, "isModelUnavailableError: 404 model-not-found → true");

    const retired = providerError(
      "fatal", "gemini",
      '{"error":{"code":404,"message":"Gemini 2.5 Pro is no longer available to new users"}}',
      { status: 404 }
    );
    ok(isModelUnavailableError(retired) === true, "isModelUnavailableError: 404 'no longer available' → true");

    // Everything else keeps its own handling — no hijacking quota/rate/timeout.
    ok(isModelUnavailableError(providerError("rate_limit", "gemini", "429 RESOURCE_EXHAUSTED quota", { status: 429 })) === false,
      "isModelUnavailableError: a 429 quota error → false");
    ok(isModelUnavailableError(providerError("transient", "gemini", "503 model is overloaded", { status: 503 })) === false,
      "isModelUnavailableError: a 503 overloaded error → false (retryable, different bucket)");
    ok(isModelUnavailableError(providerError("invalid_key", "gemini", "401 API_KEY_INVALID", { status: 401 })) === false,
      "isModelUnavailableError: an invalid-key error → false");
    ok(isModelUnavailableError(new Error("script not found")) === false,
      "isModelUnavailableError: an unrelated 'not found' (no model mention) → false");
    ok(isModelUnavailableError(null) === false && isModelUnavailableError(undefined) === false,
      "isModelUnavailableError: null/undefined → false");
  }

  // ── Pro-tier quota weighting (reserveAiTextCall count) ──────────────────
  {
    ok(PRO_TIER_TEXT_CALL_COST === 2, "PRO_TIER_TEXT_CALL_COST = 2 (a pro request = up to 4 model round-trips)");

    await prisma.user.create({
      data: { id: "hs-count", name: "Count", email: "hs-count@example.test", plan: "PRO" },
    });
    // First sync opens the 30-day window (and writes the plan's minutesLimit),
    // so the ceiling below is the one the reserve will actually compare against.
    const synced = await syncMinuteWindow("hs-count");
    const ceiling = aiTextCallCeilingFor(synced!.minutesLimit);
    ok(ceiling > 3, `text-call ceiling for a PRO user is ${ceiling} (sanity)`);

    // enforce:true is the managed path (BYOK never reaches the counter).
    const one = await reserveAiTextCall("hs-count", { enforce: true });
    ok(one.allowed === true && one.used === 1, "reserveAiTextCall default count = 1 (flash routes unchanged)");
    const two = await reserveAiTextCall("hs-count", { enforce: true, count: PRO_TIER_TEXT_CALL_COST });
    ok(two.allowed === true && two.used === 3, "reserveAiTextCall({count: 2}) reserves 2 calls (pro routes)");
    const off = await reserveAiTextCall("hs-count", { enforce: false, count: PRO_TIER_TEXT_CALL_COST });
    ok(off.allowed === true && off.used === 0,
      "reserveAiTextCall(enforce:false) is still a no-op with a count (BYOK unchanged)");

    // The ceiling is respected in units of `count`, not requests.
    await prisma.user.update({ where: { id: "hs-count" }, data: { aiTextCallsUsed: ceiling - 1 } });
    const overshoot = await reserveAiTextCall("hs-count", { enforce: true, count: PRO_TIER_TEXT_CALL_COST });
    ok(overshoot.allowed === false,
      "reserveAiTextCall({count: 2}) is refused when only 1 call is left under the ceiling");
    ok((await prisma.user.findUnique({ where: { id: "hs-count" } }))?.aiTextCallsUsed === ceiling - 1,
      "a refused count-2 reserve consumes nothing");
    const lastOne = await reserveAiTextCall("hs-count", { enforce: true });
    ok(lastOne.allowed === true && lastOne.used === ceiling,
      "the single remaining call is still reservable at count 1");
  }

  // ── viral-frameworks.ts: HOOK_FORMULAS / STORY_STRUCTURES / RETENTION_RULES / CTA_STYLES ──
  ok(HOOK_FORMULAS.length === 10, "HOOK_FORMULAS has all 10 formulas");
  ok(HOOK_FORMULA_KEYS.size === 10, "HOOK_FORMULA_KEYS has 10 distinct keys");
  ok(isValidHookFormulaKey("curiosity-gap") === true, "isValidHookFormulaKey accepts a real key");
  ok(isValidHookFormulaKey("not-a-key") === false, "isValidHookFormulaKey rejects an unknown key");
  ok(STORY_STRUCTURES.length === 5, "STORY_STRUCTURES has all 5 structures");
  ok(isValidStoryStructureKey("pas") === true && isValidStoryStructureKey("bogus") === false,
    "isValidStoryStructureKey validates structure keys");
  ok(RETENTION_RULES.length === 5, "RETENTION_RULES has all 5 rules");
  ok(CTA_STYLES.length === 4, "CTA_STYLES has all 4 styles");
  ok(isValidCtaStyleKey("follow") === true && isValidCtaStyleKey("bogus") === false,
    "isValidCtaStyleKey validates CTA style keys");
  {
    const curiosity = HOOK_FORMULAS.find((f) => f.key === "curiosity-gap");
    ok(curiosity?.example === "รู้ไหมทำไมร้านนี้ขายแพงกว่าคู่แข่ง 3 เท่า แต่คิวยาวกว่า",
      "curiosity-gap example matches the spec verbatim");
  }

  // ── buildBrandBlock: shared brand block builder ─────────────────────────
  ok(buildBrandBlock(null) === "", "buildBrandBlock(null) → ''");
  ok(buildBrandBlock(undefined) === "", "buildBrandBlock(undefined) → ''");
  {
    const block = buildBrandBlock({
      niche: "การเงินสาย dark", audience: "มนุษย์เงินเดือน", tone: "จริงจัง",
      bannedWords: ["โกหก", "หลอกลวง"], analysisNotes: "ชอบใช้คำถามเปิด",
    });
    ok(block.includes("นิช=การเงินสาย dark"), "buildBrandBlock embeds niche");
    ok(block.includes("กลุ่มเป้าหมาย=มนุษย์เงินเดือน"), "buildBrandBlock embeds audience");
    ok(block.includes("โทนเสียง=จริงจัง"), "buildBrandBlock embeds tone");
    ok(block.includes("โกหก, หลอกลวง"), "buildBrandBlock embeds bannedWords joined");
    ok(block.includes("ชอบใช้คำถามเปิด"), "buildBrandBlock embeds analysisNotes");
  }
  {
    const block = buildBrandBlock({ niche: "n", audience: "a", tone: "t", bannedWords: [], analysisNotes: null });
    ok(block.includes("คำต้องห้าม (ห้ามปรากฏในผลลัพธ์เด็ดขาด): ไม่มี"),
      "buildBrandBlock falls back to 'ไม่มี' for empty bannedWords/analysisNotes");
  }

  // ── buildIdeasPrompt: brand block + CONTINUITY_BLOCK ────────────────────
  {
    const prompt = buildIdeasPrompt({});
    ok(!prompt.includes("หัวข้อที่ช่องนี้ทำไปแล้วล่าสุด"),
      "buildIdeasPrompt omits the continuity block when recentTopics is empty");
    ok(prompt.includes('{"ideas":[{"topic":"...","angle":"ทำไมหัวข้อนี้น่าจะไวรัล (สั้น ๆ)"}]}'),
      "buildIdeasPrompt includes the exact JSON contract from the spec");
    ok(prompt.includes("คิดหัวข้อคลิปสั้น 8 หัวข้อ"), "buildIdeasPrompt includes the 8-ideas instruction line");
  }
  {
    const prompt = buildIdeasPrompt({ recentTopics: ["หัวข้อเก่า 1", "หัวข้อเก่า 2"] });
    ok(prompt.includes("หัวข้อที่ช่องนี้ทำไปแล้วล่าสุด: หัวข้อเก่า 1, หัวข้อเก่า 2"),
      "buildIdeasPrompt includes the continuity block's topics list when recentTopics is non-empty");
    ok(prompt.includes("ห้ามเสนอหัวข้อซ้ำหรือใกล้เคียงกับที่ทำไปแล้ว"), "buildIdeasPrompt includes the no-repeat rule");
    ok(prompt.includes("ต่อยอดจากหัวข้อที่ทำไปแล้ว"), "buildIdeasPrompt includes the ต่อยอด (continuation) rule");
  }
  {
    const prompt = buildIdeasPrompt({
      profile: { niche: "n", audience: "a", tone: "t", bannedWords: ["ห้าม1"], analysisNotes: "note" },
    });
    ok(prompt.includes("นิช=n") && prompt.includes("ห้าม1"),
      "buildIdeasPrompt embeds the brand block + banned words when a profile is given");
  }

  // ── buildHooksPrompt: formula keys + brand block + banned words ─────────
  {
    const prompt = buildHooksPrompt({ topic: "หัวข้อทดสอบ", durationSec: 60 });
    for (const f of HOOK_FORMULAS) {
      ok(prompt.includes(f.key), `buildHooksPrompt includes the formula key '${f.key}'`);
    }
    ok(prompt.includes("หัวข้อทดสอบ"), "buildHooksPrompt embeds the topic");
    ok(prompt.includes("60 วินาที"), "buildHooksPrompt embeds durationSec");
    ok(prompt.includes('{"hooks":[{"formula":"<key>","text":"..."}]}'),
      "buildHooksPrompt includes the exact JSON contract from the spec");
  }
  {
    const prompt = buildHooksPrompt({
      topic: "t", durationSec: 30,
      profile: { niche: "n", audience: "a", tone: "t", bannedWords: ["ห้ามคำนี้"], analysisNotes: null },
    });
    ok(prompt.includes("นิช=n") && prompt.includes("ห้ามคำนี้"),
      "buildHooksPrompt embeds the brand block + banned words when a profile is given");
  }

  // ── wordBudgetForDuration: reuses content-generator.ts's TTS pacing ─────
  ok(wordBudgetForDuration(60) === 240, "wordBudgetForDuration(60) ≈ 240 (durationSec × 4 คำ/วินาที)");
  ok(wordBudgetForDuration(30) === 120, "wordBudgetForDuration(30) = 120");
  ok(wordBudgetForDuration(90) === 360, "wordBudgetForDuration(90) = 360");

  // ── validateTopic / isValidDurationSec ───────────────────────────────────
  ok(TOPIC_MAX_CHARS === 300, "TOPIC_MAX_CHARS = 300");
  ok(validateTopic(undefined).ok === false, "validateTopic(undefined) → rejected");
  ok(validateTopic("").ok === false, "validateTopic('') → rejected");
  ok(validateTopic("x".repeat(300)).ok === true, "validateTopic(300 chars) → accepted (boundary inclusive)");
  ok(validateTopic("x".repeat(301)).ok === false, "validateTopic(301 chars) → rejected");
  ok(isValidDurationSec(30) === true && isValidDurationSec(60) === true && isValidDurationSec(90) === true,
    "isValidDurationSec accepts 30/60/90");
  ok(isValidDurationSec(45) === false && isValidDurationSec("60" as unknown as number) === false,
    "isValidDurationSec rejects other values / non-numbers");

  // ── validateIdeasResponse: exactly 8 items ───────────────────────────────
  {
    const goodIdea = { topic: "t", angle: "a" };
    ok(validateIdeasResponse(null) === null, "validateIdeasResponse(null) → null");
    ok(validateIdeasResponse({ ideas: Array(7).fill(goodIdea) }) === null,
      "validateIdeasResponse(7 items) → null (must be exactly 8)");
    ok(validateIdeasResponse({ ideas: Array(9).fill(goodIdea) }) === null,
      "validateIdeasResponse(9 items) → null (must be exactly 8)");
    ok(validateIdeasResponse({ ideas: [...Array(7).fill(goodIdea), { topic: "", angle: "a" }] }) === null,
      "validateIdeasResponse(blank topic) → null");
    const good = validateIdeasResponse({ ideas: Array(8).fill(goodIdea) });
    ok(good?.ideas.length === 8, "validateIdeasResponse(8 valid items) → accepted");
  }

  // ── validateHooksResponse: exactly 5 DISTINCT valid formula keys, ≤20 คำ ─
  {
    const fiveKeys = HOOK_FORMULAS.slice(0, 5).map((f: { key: string }) => f.key);
    const goodHooks = fiveKeys.map((key: string) => ({ formula: key, text: "ประโยค hook ตัวอย่าง" }));
    ok(validateHooksResponse(null) === null, "validateHooksResponse(null) → null");
    ok(validateHooksResponse({ hooks: goodHooks.slice(0, 4) }) === null,
      "validateHooksResponse(4 items) → null (must be exactly 5)");
    ok(validateHooksResponse({ hooks: [...goodHooks, goodHooks[0]] }) === null,
      "validateHooksResponse(6 items) → null (must be exactly 5)");
    ok(validateHooksResponse({ hooks: [...goodHooks.slice(0, 4), { ...goodHooks[0] }] }) === null,
      "validateHooksResponse(duplicate formula key) → null");
    ok(validateHooksResponse({ hooks: [...goodHooks.slice(0, 4), { formula: "not-a-real-formula", text: "x" }] }) === null,
      "validateHooksResponse(invalid formula key) → null");

    const twentyWords = Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(" ");
    const twentyOneWords = Array.from({ length: 21 }, (_, i) => `word${i + 1}`).join(" ");
    ok(countWords(twentyWords) === 20, "countWords: 20 space-separated tokens → 20");
    ok(countWords(twentyOneWords) === 21, "countWords: 21 space-separated tokens → 21");
    const atBoundary = [...goodHooks.slice(0, 4), { formula: fiveKeys[4], text: twentyWords }];
    const overBoundary = [...goodHooks.slice(0, 4), { formula: fiveKeys[4], text: twentyOneWords }];
    ok(validateHooksResponse({ hooks: atBoundary })?.hooks.length === 5,
      "validateHooksResponse(hook text = 20 คำ) → accepted (boundary inclusive)");
    ok(validateHooksResponse({ hooks: overBoundary }) === null,
      "validateHooksResponse(hook text = 21 คำ) → null (exceeds ≤20 คำ)");

    const good = validateHooksResponse({ hooks: goodHooks });
    ok(good?.hooks.length === 5, "validateHooksResponse(5 valid distinct-formula items) → accepted");
  }

  // ── getRecentScriptTopics: last 20 Script topics, newest first ──────────
  {
    const topicProfile = await prisma.brandProfile.create({
      data: { userId: "hs-free", name: "Topic profile", niche: "x", audience: "x", tone: "x" },
    });
    const baseTime = Date.now();
    for (let i = 0; i < 25; i++) {
      await prisma.script.create({
        data: {
          userId: "hs-free",
          brandProfileId: topicProfile.id,
          topic: `topic-${i}`,
          hookText: "h", bodyText: "b", ctaText: "c",
          createdAt: new Date(baseTime + i * 1000),
        },
      });
    }
    const recent = await getRecentScriptTopics("hs-free", topicProfile.id);
    ok(recent.length === 20, "getRecentScriptTopics defaults to a limit of 20");
    ok(recent[0] === "topic-24", "getRecentScriptTopics orders newest first");
    ok(recent[19] === "topic-5", "getRecentScriptTopics returns the most recent 20 (oldest 5 excluded)");

    const customLimit = await getRecentScriptTopics("hs-free", topicProfile.id, 3);
    ok(customLimit.length === 3 && customLimit[0] === "topic-24", "getRecentScriptTopics respects a custom limit");

    const emptyProfile = await prisma.brandProfile.create({
      data: { userId: "hs-free", name: "No scripts", niche: "x", audience: "x", tone: "x" },
    });
    const none = await getRecentScriptTopics("hs-free", emptyProfile.id);
    ok(none.length === 0, "getRecentScriptTopics returns [] for a profile with no saved scripts");
  }

  // ── resolveLlmTriad: shared checkAiInputCaps→resolveGeminiKey→reserveAiTextCall preamble ──
  // NOTE: prisma.config.ts pulls in `dotenv/config`, so the developer's REAL
  // .env is visible here — every env this block depends on must be cleared
  // explicitly (that is why MANAGED_GEMINI/GEMINI_SERVER_KEY are deleted, and
  // why HERO_SCRIPT_PROVIDER joined them when the provider switch landed).
  delete process.env.MANAGED_GEMINI;
  delete process.env.GEMINI_SERVER_KEY;
  delete process.env.HERO_SCRIPT_PROVIDER;
  {
    const missing = await resolveLlmTriad("hs-does-not-exist", {});
    ok(missing.ok === false && !missing.ok && missing.status === 404, "resolveLlmTriad: unknown user → 404");
  }
  {
    const overCap = await resolveLlmTriad("hs-free", { script: "x".repeat(20000) });
    ok(overCap.ok === false && !overCap.ok && overCap.status === 400,
      "resolveLlmTriad: over AI_INPUT_CAPS.scriptChars → 400 (checkAiInputCaps runs first)");
  }
  {
    const noKey = await resolveLlmTriad("hs-free", {});
    if (!noKey.ok) {
      ok(noKey.status === 409 && noKey.body?.code === "KEY_REQUIRED",
        "resolveLlmTriad: BYOK user with no geminiKey (managed off) → 409 KEY_REQUIRED");
    } else {
      ok(false, "resolveLlmTriad: expected KEY_REQUIRED for a user with no geminiKey");
    }
  }
  await prisma.user.update({ where: { id: "hs-free" }, data: { geminiKey: encryptKey("test-gemini-key-1234") } });
  {
    const withKey = await resolveLlmTriad("hs-free", {});
    ok(withKey.ok === true, "resolveLlmTriad: user with a stored geminiKey → ok");
    if (withKey.ok) {
      ok(withKey.apiKey === "test-gemini-key-1234", "resolveLlmTriad decrypts the stored BYOK key");
      ok(withKey.geminiMode === "byok", "resolveLlmTriad reports byok mode when MANAGED_GEMINI is off");
      ok(withKey.provider === "gemini", "resolveLlmTriad reports the gemini provider when the switch is unset");
    }
  }

  // ── Task 7 metering matrix: who pays decides who is metered ─────────────
  //
  // Under HERO_SCRIPT_PROVIDER=openrouter every Hero Script call runs on the
  // SERVER's OpenRouter key — including calls from users who are BYOK for
  // Gemini — so (a) resolveGeminiKey is skipped entirely (no 409 KEY_REQUIRED
  // can lock a BYOK-less user out) and (b) reserveAiTextCall is enforced for
  // EVERYONE. Under gemini the old rule stands: managed → enforce, BYOK → no-op.
  {
    await prisma.user.create({
      data: { id: "hs-or", name: "OpenRouter user", email: "hs-or@example.test", plan: "PRO" },
    });
    const usedFor = async (id: string) =>
      (await prisma.user.findUnique({ where: { id }, select: { aiTextCallsUsed: true } }))?.aiTextCallsUsed ?? -1;

    // Baseline (gemini, managed off): a user with NO stored key is locked out.
    delete process.env.HERO_SCRIPT_PROVIDER;
    const geminiNoKey = await resolveLlmTriad("hs-or", {});
    ok(geminiNoKey.ok === false && !geminiNoKey.ok && geminiNoKey.status === 409,
      "provider=gemini: a user with no geminiKey still gets 409 KEY_REQUIRED (unchanged)");
    ok((await usedFor("hs-or")) === 0,
      "provider=gemini: the 409 path reserves nothing");

    // Same user, provider=openrouter → served by the server key, and metered.
    process.env.HERO_SCRIPT_PROVIDER = "openrouter";
    const orNoKey = await resolveLlmTriad("hs-or", {});
    ok(orNoKey.ok === true, "provider=openrouter: a user with NO gemini key is served (no 409 KEY_REQUIRED)");
    if (orNoKey.ok) {
      ok(orNoKey.provider === "openrouter", "provider=openrouter: the triad reports the openrouter provider");
      ok(orNoKey.apiKey === "" && orNoKey.geminiMode === null,
        "provider=openrouter: no Gemini key is resolved at all (server key lives in the client)");
    }
    ok((await usedFor("hs-or")) === 1,
      "provider=openrouter: the call is METERED for a user who is not managed-Gemini (server is the cost bearer)");

    // A BYOK-for-Gemini user is metered too under openrouter — their Gemini key
    // pays for nothing here.
    const beforeByok = await usedFor("hs-free");
    const orByok = await resolveLlmTriad("hs-free", {});
    ok(orByok.ok === true, "provider=openrouter: a Gemini-BYOK user is served as well");
    ok((await usedFor("hs-free")) === beforeByok + 1,
      "provider=openrouter: a Gemini-BYOK user is METERED (BYOK no longer means unmetered)");

    // Pro-tier weighting still applies on top of the always-enforce rule.
    const beforePro = await usedFor("hs-or");
    const orPro = await resolveLlmTriad("hs-or", {}, { count: PRO_TIER_TEXT_CALL_COST });
    ok(orPro.ok === true, "provider=openrouter: a pro-tier reserve is allowed under the ceiling");
    ok((await usedFor("hs-or")) === beforePro + PRO_TIER_TEXT_CALL_COST,
      "provider=openrouter: the pro tier still reserves count=2");

    // The ceiling is a real gate on this path, not just bookkeeping.
    const synced = await syncMinuteWindow("hs-or");
    const ceiling = aiTextCallCeilingFor(synced!.minutesLimit);
    await prisma.user.update({ where: { id: "hs-or" }, data: { aiTextCallsUsed: ceiling } });
    const exhausted = await resolveLlmTriad("hs-or", {});
    ok(exhausted.ok === false && !exhausted.ok && exhausted.status === 429 && exhausted.body?.code === "QUOTA_AI_TEXT",
      "provider=openrouter: a user at the ceiling gets 429 QUOTA_AI_TEXT");

    // Back to gemini + BYOK: metering is a no-op again (byte-identical).
    delete process.env.HERO_SCRIPT_PROVIDER;
    const geminiByokAfter = await usedFor("hs-free");
    const backToGemini = await resolveLlmTriad("hs-free", {});
    ok(backToGemini.ok === true && backToGemini.ok && backToGemini.geminiMode === "byok",
      "rollback to provider=gemini: the BYOK user resolves their own key again");
    ok((await usedFor("hs-free")) === geminiByokAfter,
      "rollback to provider=gemini: a BYOK call reserves nothing (enforce:false, unchanged)");
  }

  // ══════════════════════════════════════════════════════════════════════
  // Task 3: full-script engine (generate / regen-section) + Script CRUD
  // ══════════════════════════════════════════════════════════════════════

  // ── assembleScript: hookText + "\n" + bodyText + "\n" + ctaText ─────────
  {
    const assembled = assembleScript({ hookText: "H", bodyText: "B1\nB2", ctaText: "C" });
    ok(assembled === "H\nB1\nB2\nC", "assembleScript joins hook/body/cta with single newlines");
    ok(assembled.split("\n").length === 4, "assembleScript newline layout: 1 line = 1 spoken sentence");
    ok(assembleScript({ hookText: "H", bodyText: "", ctaText: "C" }) === "H\n\nC",
      "assembleScript keeps the layout literal (no trimming of an empty body)");
  }

  // ── containsBannedWord / findBannedWord / bannedWordWarning ─────────────
  ok(containsBannedWord("อย่าลืมกดไลก์", ["กดไลก์"]) === true,
    'containsBannedWord("อย่าลืมกดไลก์", ["กดไลก์"]) === true');
  ok(containsBannedWord("อย่าลืมกดไลก์", []) === false, "containsBannedWord with no banned words → false");
  ok(containsBannedWord("ข้อความสะอาด", ["กดไลก์"]) === false, "containsBannedWord: clean text → false");
  ok(containsBannedWord("Please SUBSCRIBE now", ["subscribe"]) === true,
    "containsBannedWord is case-insensitive (latin)");
  ok(findBannedWord("อย่าลืมกดไลก์ แล้วกดแชร์", ["กดแชร์", "กดไลก์"]) === "กดแชร์",
    "findBannedWord returns the first matching banned word (list order)");
  ok(findBannedWord("สะอาด", ["กดไลก์"]) === null, "findBannedWord: clean text → null");
  ok(bannedWordWarning("กดไลก์") === "มีคำต้องห้ามหลุดมา: กดไลก์",
    "bannedWordWarning matches the spec's warning copy verbatim");

  // ── heroScriptModel: env-configurable fast/pro model ids ────────────────
  {
    delete process.env.HERO_SCRIPT_PROVIDER; // gemini is the code default
    delete process.env.HERO_SCRIPT_MODEL_FAST;
    delete process.env.HERO_SCRIPT_MODEL_PRO;
    ok(heroScriptModel("fast") === "gemini-2.5-flash", "heroScriptModel('fast') defaults to gemini-2.5-flash");
    // Amended 2026-07-31 (plan doc + controller): gemini-2.5-pro returns 404
    // "no longer available to new users" on the project server key.
    ok(heroScriptModel("pro") === "gemini-pro-latest", "heroScriptModel('pro') defaults to gemini-pro-latest");
    process.env.HERO_SCRIPT_MODEL_PRO = "gemini-3.1-pro-preview";
    ok(heroScriptModel("pro") === "gemini-3.1-pro-preview", "HERO_SCRIPT_MODEL_PRO overrides the pro model id");
    process.env.HERO_SCRIPT_MODEL_FAST = "gemini-flash-latest";
    ok(heroScriptModel("fast") === "gemini-flash-latest", "HERO_SCRIPT_MODEL_FAST overrides the fast model id");
    delete process.env.HERO_SCRIPT_MODEL_FAST;
    delete process.env.HERO_SCRIPT_MODEL_PRO;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Task 7 (2026-07-31): the Hero Script LLM provider switch
  // ══════════════════════════════════════════════════════════════════════

  // ── Provider resolution matrix: unset → gemini (fail-safe), known value →
  //    itself, anything else → gemini + a warning. ─────────────────────────
  {
    ok(HERO_SCRIPT_PROVIDER_DEFAULT === "gemini",
      "HERO_SCRIPT_PROVIDER_DEFAULT is gemini (the fail-safe / instant-rollback provider)");
    ok(resolveHeroScriptProvider(undefined).provider === "gemini",
      "resolveHeroScriptProvider(unset) → gemini");
    ok(resolveHeroScriptProvider(undefined).warning === undefined,
      "resolveHeroScriptProvider(unset) does NOT warn (unset is the supported default)");
    ok(resolveHeroScriptProvider(null).provider === "gemini", "resolveHeroScriptProvider(null) → gemini");
    ok(resolveHeroScriptProvider("").provider === "gemini", "resolveHeroScriptProvider('') → gemini");
    ok(resolveHeroScriptProvider("   ").provider === "gemini",
      "resolveHeroScriptProvider(whitespace) → gemini");
    ok(resolveHeroScriptProvider("gemini").provider === "gemini", "resolveHeroScriptProvider('gemini') → gemini");
    ok(resolveHeroScriptProvider("openrouter").provider === "openrouter",
      "resolveHeroScriptProvider('openrouter') → openrouter");
    ok(resolveHeroScriptProvider("  OpenRouter  ").provider === "openrouter",
      "resolveHeroScriptProvider is case- and whitespace-insensitive");
    const bogus = resolveHeroScriptProvider("claude");
    ok(bogus.provider === "gemini",
      "resolveHeroScriptProvider(unknown value) falls back to gemini (never leaves the feature dark)");
    ok(typeof bogus.warning === "string" && bogus.warning.includes("claude"),
      "resolveHeroScriptProvider(unknown value) returns a warning naming the bad value");

    // …and the env-reading wrapper agrees.
    delete process.env.HERO_SCRIPT_PROVIDER;
    ok(heroScriptProvider() === "gemini", "heroScriptProvider(): unset env → gemini");
    process.env.HERO_SCRIPT_PROVIDER = "openrouter";
    ok(heroScriptProvider() === "openrouter", "heroScriptProvider(): HERO_SCRIPT_PROVIDER=openrouter → openrouter");
    process.env.HERO_SCRIPT_PROVIDER = "not-a-provider";
    ok(heroScriptProvider() === "gemini", "heroScriptProvider(): invalid env value → gemini (fail-safe)");
    delete process.env.HERO_SCRIPT_PROVIDER;
  }

  // ── Model resolution per provider (each provider has its OWN env pair) ──
  {
    delete process.env.HERO_SCRIPT_MODEL_FAST;
    delete process.env.HERO_SCRIPT_MODEL_PRO;
    delete process.env.HERO_SCRIPT_OR_MODEL_FAST;
    delete process.env.HERO_SCRIPT_OR_MODEL_PRO;

    process.env.HERO_SCRIPT_PROVIDER = "openrouter";
    ok(heroScriptModel("fast") === OPENROUTER_MODEL_FAST_DEFAULT && OPENROUTER_MODEL_FAST_DEFAULT === "openai/gpt-5.6-luna",
      "provider=openrouter: fast tier → openai/gpt-5.6-luna");
    ok(heroScriptModel("pro") === OPENROUTER_MODEL_PRO_DEFAULT && OPENROUTER_MODEL_PRO_DEFAULT === "openai/gpt-5.6-terra",
      "provider=openrouter: pro tier → openai/gpt-5.6-terra");

    // The Gemini overrides must NOT leak into the OpenRouter path (a Gemini
    // model id is not a routable OpenRouter slug) — and vice versa.
    process.env.HERO_SCRIPT_MODEL_FAST = "gemini-flash-latest";
    process.env.HERO_SCRIPT_MODEL_PRO = "gemini-pro-latest";
    ok(heroScriptModel("fast") === OPENROUTER_MODEL_FAST_DEFAULT,
      "provider=openrouter ignores HERO_SCRIPT_MODEL_FAST (gemini-only override)");
    process.env.HERO_SCRIPT_OR_MODEL_FAST = "openai/gpt-5.6-sol";
    process.env.HERO_SCRIPT_OR_MODEL_PRO = "openai/gpt-5.6-terra-pro";
    ok(heroScriptModel("fast") === "openai/gpt-5.6-sol", "HERO_SCRIPT_OR_MODEL_FAST overrides the OpenRouter fast slug");
    ok(heroScriptModel("pro") === "openai/gpt-5.6-terra-pro", "HERO_SCRIPT_OR_MODEL_PRO overrides the OpenRouter pro slug");

    process.env.HERO_SCRIPT_PROVIDER = "gemini";
    ok(heroScriptModel("fast") === "gemini-flash-latest" && heroScriptModel("pro") === "gemini-pro-latest",
      "provider=gemini ignores the HERO_SCRIPT_OR_MODEL_* overrides (gemini path unchanged)");

    // The explicit-provider argument wins over the env (used by the error helper).
    ok(heroScriptModel("pro", "openrouter") === "openai/gpt-5.6-terra-pro",
      "heroScriptModel(tier, provider) honours an explicit provider argument");

    delete process.env.HERO_SCRIPT_PROVIDER;
    delete process.env.HERO_SCRIPT_MODEL_FAST;
    delete process.env.HERO_SCRIPT_MODEL_PRO;
    delete process.env.HERO_SCRIPT_OR_MODEL_FAST;
    delete process.env.HERO_SCRIPT_OR_MODEL_PRO;
  }

  // ── OpenRouter error classification (the classifier, not live HTTP) ─────
  {
    ok(classifyOpenRouterFailure(404, "") === "model_unavailable",
      "classifyOpenRouterFailure(404) → model_unavailable");
    ok(classifyOpenRouterFailure(404, '{"error":{"message":"No endpoints found for openai/gpt-5.6-luna"}}') === "model_unavailable",
      "classifyOpenRouterFailure(404 + 'No endpoints found') → model_unavailable");
    ok(classifyOpenRouterFailure(400, '{"error":{"message":"openai/gpt-9 is not a valid model ID"}}') === "model_unavailable",
      "classifyOpenRouterFailure(400 + 'not a valid model ID') → model_unavailable (OpenRouter's other bad-model shape)");
    ok(classifyOpenRouterFailure(402, '{"error":{"message":"Insufficient credits"}}') === "provider_credit",
      "classifyOpenRouterFailure(402) → provider_credit");
    ok(classifyOpenRouterFailure(429, "Rate limit exceeded") === "provider_credit",
      "classifyOpenRouterFailure(429) → provider_credit");
    ok(classifyOpenRouterFailure(401, "no auth") === "provider_auth" && classifyOpenRouterFailure(403, "") === "provider_auth",
      "classifyOpenRouterFailure(401/403) → provider_auth (server credential, never the user's key)");
    ok(classifyOpenRouterFailure(500, "") === "transient" && classifyOpenRouterFailure(503, "") === "transient",
      "classifyOpenRouterFailure(5xx) → transient");
    ok(classifyOpenRouterFailure(undefined, "fetch failed") === "transient",
      "classifyOpenRouterFailure(network/no status) → transient");
    ok(classifyOpenRouterFailure(400, '{"error":{"message":"messages: field required"}}') === "fatal",
      "classifyOpenRouterFailure(other 4xx) → fatal (never retried)");

    // …and the errors those classes build behave the way the routes expect.
    const gone = openRouterError("model_unavailable", "openrouter returned HTTP 404 for model=openai/gpt-9", 404);
    ok(isModelUnavailableError(gone) === true,
      "a model_unavailable OpenRouter error trips isModelUnavailableError (→ the existing MODEL_UNAVAILABLE 503 path)");
    ok(isOpenRouterCreditError(gone) === false, "a model_unavailable error is NOT the provider-credit class");

    const broke = openRouterError("provider_credit", "openrouter returned HTTP 402: Insufficient credits", 402);
    ok(isOpenRouterCreditError(broke) === true, "a 402-built error is the provider-credit class");
    ok(isModelUnavailableError(broke) === false,
      "a provider-credit error is NOT mistaken for a dead model (no cross-class leakage)");
    ok(broke.userAction === OPENROUTER_CREDIT_MESSAGE &&
      OPENROUTER_CREDIT_MESSAGE === "ระบบ AI ไม่พร้อมใช้งานชั่วคราว (เครดิตผู้ให้บริการ)",
      "provider-credit carries the spec's Thai copy");
    ok(toErrorResponse(broke).status === 503, "provider-credit maps to a 503 (never a 402 'top up your key' answer)");
    ok(broke.provider === "openrouter" && broke.code !== "invalid_key",
      "provider-credit is never classified invalid_key (the user has no OpenRouter key to fix)");

    const throttled = openRouterError("provider_credit", "openrouter returned HTTP 429: rate limited on model x", 429);
    ok(isOpenRouterCreditError(throttled) === true && isModelUnavailableError(throttled) === false,
      "a 429-built error is provider-credit, not model_unavailable (429 bodies can name a model)");

    const noKey = openRouterError("provider_auth", "OPENROUTER_API_KEY is not configured");
    ok(isOpenRouterAuthError(noKey) === true && toErrorResponse(noKey).status === 503,
      "a missing/rejected server credential is a 503, not a user-facing key error");

    // A Gemini ProviderError must never be picked up by the OpenRouter classes.
    const geminiQuota = providerError("quota", "gemini", "429 RESOURCE_EXHAUSTED", { status: 429 });
    ok(isOpenRouterCreditError(geminiQuota) === false && isOpenRouterAuthError(geminiQuota) === false,
      "a Gemini error is never treated as an OpenRouter class (gemini path byte-identical)");

    // Secrets never travel in a provider message.
    ok(!scrubOpenRouterSecrets("Authorization: Bearer sk-or-v1-abcdef0123456789abcdef").includes("abcdef0123456789"),
      "scrubOpenRouterSecrets redacts an sk-or- key / Bearer token");
    ok(!openRouterError("fatal", "boom sk-or-v1-abcdef0123456789abcdef").message.includes("abcdef0123456789"),
      "openRouterError scrubs the technical message before it can reach a log");

    // …including on the TRANSPORT path. fetchWithBudget is provider-agnostic and
    // builds its own plain ProviderError straight from the raw network message,
    // so that construction site is re-wrapped by the OpenRouter caller — without
    // the wrap, a cause chain / request echo carrying the Authorization header
    // would reach a log unscrubbed.
    const rawTransport = providerError(
      "transient",
      "openrouter",
      "openrouter fetch failed (attempt 3/3): connect ECONNREFUSED — sent Authorization: Bearer sk-or-v1-abcdef0123456789abcdef",
    );
    ok(rawTransport.message.includes("abcdef0123456789"),
      "regression guard: fetchWithBudget's own transport error DOES carry the raw message (hence the re-wrap)");
    const wrapped = wrapOpenRouterTransportError(rawTransport);
    ok(!wrapped.message.includes("abcdef0123456789") && !wrapped.message.includes("sk-or-v1-abcdef"),
      "wrapOpenRouterTransportError scrubs an sk-or- key out of a network/timeout error message");
    ok(wrapped.openRouterClass === "transient" && wrapped.provider === "openrouter",
      "wrapOpenRouterTransportError classifies a transport failure as transient");
    ok(toErrorResponse(wrapped).status === 503,
      "a wrapped transport failure answers 503, not a credit/model error");
    ok(isOpenRouterCreditError(wrapped) === false && isModelUnavailableError(wrapped) === false,
      "a transport failure is neither the credit nor the dead-model class");
    ok(!wrapOpenRouterTransportError(new Error("fetch failed: Bearer sk-or-v1-abcdef0123456789abcdef")).message.includes("abcdef0123456789"),
      "wrapOpenRouterTransportError scrubs a plain Error too (Node folds the cause chain into .message)");
    const alreadyClassified = openRouterError("provider_credit", "HTTP 402", 402);
    ok(wrapOpenRouterTransportError(alreadyClassified) === alreadyClassified,
      "wrapOpenRouterTransportError passes an already-classified OpenRouter error through unchanged");

    // Defense in depth: the generic api-error scrubber knows the sk-or- shape
    // too, so an OpenRouter token cannot reach an admin notification through any
    // other route's error path either.
    ok(!scrubApiErrorSecrets("boom sk-or-v1-abcdef0123456789abcdef").includes("abcdef0123456789"),
      "api-error's scrubSecrets redacts a BARE sk-or- key (no Bearer prefix to catch it)");
    ok(scrubApiErrorSecrets("AIzaSyA1234567890abcdefghijklmnop").includes("<redacted>"),
      "api-error's scrubSecrets still redacts the pre-existing key shapes (AIza…)");

    // Response extraction (the shape the JSON validators are fed).
    ok(extractOpenRouterContent({ choices: [{ message: { content: '{"ok":true}' } }] }) === '{"ok":true}',
      "extractOpenRouterContent reads choices[0].message.content");
    ok(extractOpenRouterContent({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }) === "ab",
      "extractOpenRouterContent joins an array-of-parts content");
    ok(extractOpenRouterContent({ choices: [] }) === "" && extractOpenRouterContent(null) === "" &&
      extractOpenRouterContent({ choices: [{ message: {} }] }) === "",
      "extractOpenRouterContent returns '' for an empty/odd payload (→ the caller's parse-retry, never a throw)");
  }

  // ── heroScriptLlmErrorResponse: one 503 mapping shared by all 6 routes ──
  {
    const modelGone = heroScriptLlmErrorResponse(
      openRouterError("model_unavailable", "HTTP 404", 404),
      { route: "test", tier: "pro" }
    );
    ok(modelGone?.status === 503, "heroScriptLlmErrorResponse: dead model → 503");
    ok((await modelGone!.json()).code === MODEL_UNAVAILABLE_CODE,
      "heroScriptLlmErrorResponse: dead model keeps the existing MODEL_UNAVAILABLE code");
    ok((await heroScriptLlmErrorResponse(providerError("fatal", "gemini", "404 model not found", { status: 404 }), { route: "test", tier: "pro" })!.json()).error === MODEL_UNAVAILABLE_MESSAGE,
      "heroScriptLlmErrorResponse: a Gemini 404 keeps the same Thai MODEL_UNAVAILABLE copy");

    const credit = heroScriptLlmErrorResponse(
      openRouterError("provider_credit", "HTTP 402", 402),
      { route: "test", tier: "fast" }
    );
    ok(credit?.status === 503, "heroScriptLlmErrorResponse: provider credit spent → 503");
    const creditBody = await credit!.json();
    ok(creditBody.code === PROVIDER_CREDIT_CODE && creditBody.error === OPENROUTER_CREDIT_MESSAGE,
      "heroScriptLlmErrorResponse: provider credit → PROVIDER_CREDIT + the Thai credit copy");

    // A missing/rejected SERVER credential is its own code — the user has no
    // OpenRouter key, so this must never read as "check your API key" (and must
    // not be mislabelled as a credit problem in a log/HAR either).
    const badCredential = heroScriptLlmErrorResponse(
      openRouterError("provider_auth", "OPENROUTER_API_KEY is not configured"),
      { route: "test", tier: "fast" }
    );
    ok(badCredential?.status === 503, "heroScriptLlmErrorResponse: rejected server credential → 503");
    const credentialBody = await badCredential!.json();
    ok(credentialBody.code === PROVIDER_UNAVAILABLE_CODE && !credentialBody.error.includes("Key"),
      "heroScriptLlmErrorResponse: server-credential failure → PROVIDER_UNAVAILABLE, never a 'fix your key' message");

    ok(heroScriptLlmErrorResponse(new Error("something else"), { route: "test", tier: "fast" }) === null,
      "heroScriptLlmErrorResponse returns null for unrelated errors (they keep going to apiError)");
    ok(heroScriptLlmErrorResponse(providerError("rate_limit", "gemini", "429 quota", { status: 429 }), { route: "test", tier: "fast" }) === null,
      "heroScriptLlmErrorResponse leaves a Gemini 429 alone (gemini path byte-identical)");
  }

  // ── GENERATE prompt builder ─────────────────────────────────────────────
  {
    const hookText = "ใครที่ลงคลิปทุกวันแต่ยอดวิวไม่ขยับ ฟังทางนี้";
    const prompt = buildGeneratePrompt({
      topic: "ทำไมคลิปไม่ปัง",
      durationSec: 60,
      wordBudget: wordBudgetForDuration(60),
      hookText,
      ctaStyle: "follow",
      profile: { niche: "n", audience: "a", tone: "t", bannedWords: ["ห้ามคำนี้"], analysisNotes: null },
    });
    ok(prompt.includes(`"${hookText}"`), "buildGeneratePrompt embeds the chosen hook VERBATIM (quoted)");
    ok(prompt.includes("Hook ที่ผู้ใช้เลือก (ห้ามแก้แม้แต่คำเดียว จะถูกใช้เป็นบรรทัดแรกเสมอ)"),
      "buildGeneratePrompt includes the do-not-touch-the-hook line from the spec");
    ok(prompt.includes("งบคำทั้งคลิป ~240 คำ (±15%)"), "buildGeneratePrompt states the word budget with ±15%");
    ok(prompt.includes("ความยาว 60 วินาที"), "buildGeneratePrompt states the duration");
    ok(prompt.includes("ทำไมคลิปไม่ปัง"), "buildGeneratePrompt embeds the topic");
    for (const s of STORY_STRUCTURES) {
      ok(prompt.includes(s.key), `buildGeneratePrompt includes the story-structure key '${s.key}'`);
    }
    for (const r of RETENTION_RULES) {
      ok(prompt.includes(r), "buildGeneratePrompt includes every RETENTION_RULES line verbatim");
    }
    ok(prompt.includes("ฝากติดตาม"), "buildGeneratePrompt includes the selected CTA style (label)");
    ok(prompt.includes('{"structure":"<key>","bodyText":"บรรทัดละประโยค\\nคั่นด้วย \\\\n","ctaText":"..."}'),
      "buildGeneratePrompt includes the exact JSON contract from the spec");
    ok(prompt.includes("นิช=n") && prompt.includes("ห้ามคำนี้"),
      "buildGeneratePrompt embeds the brand block + banned words when a profile is given");
  }

  // ── REGEN prompt builder (per-target instruction) ────────────────────────
  {
    const current = { hookText: "hook เดิม", bodyText: "บรรทัด 1\nบรรทัด 2", ctaText: "cta เดิม" };
    const bodyPrompt = buildRegenPrompt({
      target: "body", topic: "หัวข้อ", durationSec: 60, wordBudget: 240, current, ctaStyle: "follow",
    });
    ok(bodyPrompt.includes("เขียน body ใหม่ให้ต่างจากเดิมชัดเจน โดยคง hook และ CTA เดิม"),
      "buildRegenPrompt(body) uses the spec's body instruction verbatim");
    ok(bodyPrompt.includes("hook เดิม") && bodyPrompt.includes("บรรทัด 1") && bodyPrompt.includes("cta เดิม"),
      "buildRegenPrompt(body) includes the current script as context");
    ok(bodyPrompt.includes('ตอบเป็น JSON เท่านั้น: {"text":"..."}'),
      "buildRegenPrompt(body) uses the {\"text\":\"...\"} contract");

    const ctaPrompt = buildRegenPrompt({
      target: "cta", topic: "หัวข้อ", durationSec: 60, wordBudget: 240, current, ctaStyle: "share",
    });
    ok(ctaPrompt.includes("เขียน CTA ใหม่สไตล์ ชวนแชร์/เซฟ ให้ต่างจากเดิม"),
      "buildRegenPrompt(cta) uses the spec's CTA instruction with the selected style");

    const hookPrompt = buildRegenPrompt({
      target: "hook", topic: "หัวข้อ", durationSec: 60, wordBudget: 240, current, ctaStyle: "follow",
      currentFormula: "curiosity-gap",
    });
    ok(hookPrompt.includes("เขียน hook ใหม่ 1 อันจากสูตรอื่นที่ไม่ใช่ curiosity-gap"),
      "buildRegenPrompt(hook) uses the spec's hook instruction naming the current formula");
    ok(hookPrompt.includes('ตอบเป็น JSON เท่านั้น: {"text":"...","formula":"<key>"}'),
      "buildRegenPrompt(hook) asks for the formula key alongside the text");
    for (const f of HOOK_FORMULAS) {
      ok(hookPrompt.includes(f.key), `buildRegenPrompt(hook) lists the formula key '${f.key}' to choose from`);
    }
  }

  // ── banned-word retry note (appended to the prompt on the 1 retry) ───────
  {
    const note = buildBannedWordRetryNote(["กดไลก์", "กดแชร์"]);
    ok(note.includes("กดไลก์") && note.includes("กดแชร์"), "buildBannedWordRetryNote lists the banned words");
    ok(buildBannedWordRetryNote([]) === "", "buildBannedWordRetryNote([]) → '' (nothing to warn about)");
  }

  // ── validateGenerateResponse ────────────────────────────────────────────
  {
    const good = { structure: "pas", bodyText: "บรรทัด 1\nบรรทัด 2", ctaText: "ตามไว้" };
    ok(validateGenerateResponse(null) === null, "validateGenerateResponse(null) → null");
    ok(validateGenerateResponse({ ...good, structure: "not-a-structure" }) === null,
      "validateGenerateResponse rejects an unknown structure key");
    ok(validateGenerateResponse({ ...good, structure: "" }) === null,
      "validateGenerateResponse rejects a blank structure");
    ok(validateGenerateResponse({ ...good, bodyText: "" }) === null,
      "validateGenerateResponse rejects an empty bodyText");
    ok(validateGenerateResponse({ ...good, ctaText: "" }) === null,
      "validateGenerateResponse rejects an empty ctaText");
    const parsed = validateGenerateResponse(good);
    ok(parsed?.structure === "pas" && parsed?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse accepts a valid payload");
    const crlf = validateGenerateResponse({ ...good, bodyText: "บรรทัด 1\r\nบรรทัด 2\r\n" });
    ok(crlf?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse normalizes CRLF and trims trailing blank lines");
  }

  // ── 1 บรรทัด = 1 ประโยค: NO blank line may survive into any section ──────
  {
    const good = { structure: "pas", bodyText: "บรรทัด 1\nบรรทัด 2", ctaText: "ตามไว้" };
    const internal = validateGenerateResponse({ ...good, bodyText: "บรรทัด 1\n\nบรรทัด 2" });
    ok(internal?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse strips an INTERNAL blank line from bodyText (1 บรรทัด = 1 ประโยค)");
    const multi = validateGenerateResponse({ ...good, bodyText: "\n\nบรรทัด 1\n\n\nบรรทัด 2\n\n" });
    ok(multi?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse strips multiple consecutive blank lines (leading/internal/trailing)");
    const whitespaceOnly = validateGenerateResponse({ ...good, bodyText: "บรรทัด 1\n   \n\t\nบรรทัด 2" });
    ok(whitespaceOnly?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse strips whitespace-only lines, not just empty ones");
    const crlfBlanks = validateGenerateResponse({ ...good, bodyText: "บรรทัด 1\r\n\r\nบรรทัด 2\r\n\r\n" });
    ok(crlfBlanks?.bodyText === "บรรทัด 1\nบรรทัด 2",
      "validateGenerateResponse strips CRLF blank lines too");
    const blankCta = validateGenerateResponse({ ...good, ctaText: "ตามไว้\n\nเดี๋ยวพาร์ทสองมา" });
    ok(blankCta?.ctaText === "ตามไว้\nเดี๋ยวพาร์ทสองมา",
      "validateGenerateResponse strips blank lines from ctaText as well");
    const parsed = validateGenerateResponse({ ...good, bodyText: "บรรทัด 1\n\nบรรทัด 2", ctaText: "\nตามไว้\n" })!;
    const assembled = assembleScript({ hookText: "hook", bodyText: parsed.bodyText, ctaText: parsed.ctaText });
    ok(!assembled.split("\n").some((line) => line.trim() === ""),
      "assembleScript over a validated GENERATE result can never contain a blank line");
    const regen = validateRegenResponse({ text: "บรรทัด 1\n \nบรรทัด 2\n\n" }, { target: "body" });
    ok(regen?.text === "บรรทัด 1\nบรรทัด 2",
      "validateRegenResponse strips blank lines from a regenerated section");
  }

  // ── validateRegenResponse ───────────────────────────────────────────────
  {
    ok(validateRegenResponse({ text: "ใหม่" }, { target: "body" })?.text === "ใหม่",
      "validateRegenResponse(body) accepts {text}");
    ok(validateRegenResponse({ text: "" }, { target: "body" }) === null,
      "validateRegenResponse rejects an empty text");
    ok(validateRegenResponse({ text: "ใหม่" }, { target: "hook" }) === null,
      "validateRegenResponse(hook) requires a formula");
    ok(validateRegenResponse({ text: "ใหม่", formula: "nope" }, { target: "hook" }) === null,
      "validateRegenResponse(hook) rejects an unknown formula key");
    ok(validateRegenResponse({ text: "ใหม่", formula: "curiosity-gap" }, { target: "hook", currentFormula: "curiosity-gap" }) === null,
      "validateRegenResponse(hook) rejects the SAME formula as the current one");
    const regenerated = validateRegenResponse(
      { text: "ใหม่", formula: "contrarian" },
      { target: "hook", currentFormula: "curiosity-gap" }
    );
    ok(regenerated?.formula === "contrarian", "validateRegenResponse(hook) accepts a DIFFERENT valid formula");
    const twentyOneWords = Array.from({ length: 21 }, (_, i) => `word${i + 1}`).join(" ");
    ok(validateRegenResponse({ text: twentyOneWords, formula: "contrarian" }, { target: "hook" }) === null,
      "validateRegenResponse(hook) enforces the ≤20 คำ hook rule");
  }

  // ── isValidRegenTarget ──────────────────────────────────────────────────
  ok(isValidRegenTarget("hook") && isValidRegenTarget("body") && isValidRegenTarget("cta"),
    "isValidRegenTarget accepts hook/body/cta");
  ok(!isValidRegenTarget("intro") && !isValidRegenTarget(42), "isValidRegenTarget rejects anything else");

  // ── stripEchoedHook: the server reattaches the hook, never the model ────
  {
    const hook = "ใครที่ลงคลิปทุกวันแต่ยอดวิวไม่ขยับ ฟังทางนี้";
    ok(stripEchoedHook(`${hook}\nบรรทัด 1\nบรรทัด 2`, hook) === "บรรทัด 1\nบรรทัด 2",
      "stripEchoedHook drops a body first line that echoes the hook");
    ok(stripEchoedHook(`  ${hook}  \nบรรทัด 1`, hook) === "บรรทัด 1",
      "stripEchoedHook ignores surrounding whitespace when comparing");
    ok(stripEchoedHook("บรรทัด 1\nบรรทัด 2", hook) === "บรรทัด 1\nบรรทัด 2",
      "stripEchoedHook leaves a body that does not echo the hook untouched");
    ok(stripEchoedHook("", hook) === "", "stripEchoedHook('') → ''");
  }

  // ── generateWithBannedWordGuard: retry once, then warn (never block) ────
  {
    const calls: string[] = [];
    const clean = await generateWithBannedWordGuard<{ text: string }>({
      bannedWords: ["กดไลก์"],
      extractText: (r) => r.text,
      generate: async (note) => { calls.push(note); return { text: "ข้อความสะอาด" }; },
    });
    ok(clean?.result.text === "ข้อความสะอาด" && clean?.warning === undefined,
      "generateWithBannedWordGuard: clean first attempt → no warning");
    ok(calls.length === 1, "generateWithBannedWordGuard: clean first attempt → exactly 1 LLM call");
  }
  {
    const calls: string[] = [];
    const retried = await generateWithBannedWordGuard<{ text: string }>({
      bannedWords: ["กดไลก์"],
      extractText: (r) => r.text,
      generate: async (note) => {
        calls.push(note);
        return { text: calls.length === 1 ? "อย่าลืมกดไลก์" : "ข้อความสะอาด" };
      },
    });
    ok(calls.length === 2, "generateWithBannedWordGuard: banned hit → exactly 1 retry");
    ok(calls[0] === "" && calls[1].includes("กดไลก์"),
      "generateWithBannedWordGuard: the retry appends the stern banned-words note");
    ok(retried?.result.text === "ข้อความสะอาด" && retried?.warning === undefined,
      "generateWithBannedWordGuard: clean retry → returns the retry result with no warning");
  }
  {
    const calls: string[] = [];
    const stillDirty = await generateWithBannedWordGuard<{ text: string }>({
      bannedWords: ["กดไลก์"],
      extractText: (r) => r.text,
      generate: async (note) => { calls.push(note); return { text: "อย่าลืมกดไลก์" }; },
    });
    ok(calls.length === 2, "generateWithBannedWordGuard: still dirty → stops after the 1 retry");
    ok(stillDirty?.result.text === "อย่าลืมกดไลก์", "generateWithBannedWordGuard never blocks the user");
    ok(stillDirty?.warning === "มีคำต้องห้ามหลุดมา: กดไลก์",
      "generateWithBannedWordGuard returns the spec's Thai warning when the word survives the retry");
  }
  {
    const nulled = await generateWithBannedWordGuard<{ text: string }>({
      bannedWords: [], extractText: (r) => r.text, generate: async () => null,
    });
    ok(nulled === null, "generateWithBannedWordGuard: unusable LLM output → null (route 502s)");
  }
  {
    // Retry itself fails to produce anything → keep the first result + warn.
    let n = 0;
    const firstOnly = await generateWithBannedWordGuard<{ text: string }>({
      bannedWords: ["กดไลก์"],
      extractText: (r) => r.text,
      generate: async () => (++n === 1 ? { text: "อย่าลืมกดไลก์" } : null),
    });
    ok(firstOnly?.result.text === "อย่าลืมกดไลก์" && firstOnly?.warning === "มีคำต้องห้ามหลุดมา: กดไลก์",
      "generateWithBannedWordGuard: failed retry → first result kept, warning attached");
  }

  // ── Script CRUD roundtrip (service layer, throwaway SQLite) ─────────────
  {
    await prisma.user.createMany({
      data: [
        { id: "hs-owner", name: "Owner", email: "hs-owner@example.test", plan: "PRO" },
        { id: "hs-other", name: "Other", email: "hs-other@example.test", plan: "PRO" },
      ],
    });
    const ownerProfile = await prisma.brandProfile.create({
      data: { userId: "hs-owner", name: "Owner profile", niche: "x", audience: "x", tone: "x" },
    });

    ok(SCRIPT_LIST_LIMIT === 50, "SCRIPT_LIST_LIMIT = 50 (list own, newest first, take 50)");

    const script = await createScript("hs-owner", {
      topic: "หัวข้อทดสอบ",
      durationSec: 60,
      hookFormula: "curiosity-gap",
      structure: "pas",
      hookText: "hook ทดสอบ",
      bodyText: "บรรทัด 1\nบรรทัด 2",
      ctaText: "cta ทดสอบ",
      brandProfileId: ownerProfile.id,
    });
    ok(!!script.id && script.userId === "hs-owner", "createScript persists a Script owned by the caller");
    ok(script.status === "draft", "createScript defaults status to 'draft'");
    ok(assembleScript(script) === "hook ทดสอบ\nบรรทัด 1\nบรรทัด 2\ncta ทดสอบ",
      "assembleScript works on a persisted Script row (the string Task 4 sends to the editor)");

    ok((await getScript("hs-owner", script.id))?.id === script.id, "getScript returns the owner's own script");
    ok((await getScript("hs-other", script.id)) === null, "getScript does NOT return another user's script (IDOR)");

    const updated = await updateScript("hs-owner", script.id, { bodyText: "บรรทัดใหม่" });
    ok(updated?.bodyText === "บรรทัดใหม่", "updateScript persists a changed section");
    ok(updated?.topic === "หัวข้อทดสอบ" && updated?.hookText === "hook ทดสอบ",
      "updateScript is a partial patch — omitted fields are left untouched");
    ok(updated?.structure === "pas" && updated?.hookFormula === "curiosity-gap",
      "updateScript does not reset hookFormula/structure when they are omitted");
    ok((await updateScript("hs-other", script.id, { bodyText: "แฮก" })) === null,
      "updateScript refuses to touch another user's script (IDOR)");
    ok((await updateScript("hs-owner", script.id, {}))?.id === script.id,
      "updateScript with an empty patch is a no-op read (never an empty UPDATE)");
    ok((await updateScript("hs-other", script.id, {})) === null,
      "updateScript with an empty patch is still ownership-scoped (IDOR)");
    ok((await getScript("hs-owner", script.id))?.bodyText === "บรรทัดใหม่",
      "the foreign updateScript attempt left the row unchanged");

    // listScripts: own only, newest first, capped at SCRIPT_LIST_LIMIT.
    const base = Date.now();
    for (let i = 0; i < 55; i++) {
      await prisma.script.create({
        data: {
          userId: "hs-owner", topic: `list-${i}`, hookText: "h", bodyText: "b", ctaText: "c",
          createdAt: new Date(base + i * 1000),
        },
      });
    }
    await prisma.script.create({
      data: { userId: "hs-other", topic: "ของคนอื่น", hookText: "h", bodyText: "b", ctaText: "c" },
    });
    const listed = await listScripts("hs-owner");
    ok(listed.length === SCRIPT_LIST_LIMIT, "listScripts takes at most 50 rows");
    ok(listed[0].topic === "list-54", "listScripts orders newest first");
    ok(listed.every((s) => s.userId === "hs-owner"), "listScripts only ever returns the caller's own scripts (IDOR)");

    ok((await deleteScript("hs-other", script.id)) === false,
      "deleteScript refuses to delete another user's script (IDOR)");
    ok((await getScript("hs-owner", script.id)) !== null, "the foreign deleteScript attempt did not delete the row");
    ok((await deleteScript("hs-owner", script.id)) === true, "deleteScript removes the owner's own script");
    ok((await getScript("hs-owner", script.id)) === null, "deleteScript actually removed the row");

    // PUT size guard: the cap applies to the MERGED row, not just the patched
    // fields — mirrors what src/app/api/scripts/[id]/route.ts now computes, so
    // repeated single-field PUTs can't grow a row past AI_INPUT_CAPS.scriptChars.
    {
      const big = "ก".repeat(3000);
      const row = await createScript("hs-owner", {
        topic: "ใหญ่", durationSec: 60, hookText: big, bodyText: big, ctaText: big,
      });
      const mergedWith = (patch: { hookText?: string; bodyText?: string; ctaText?: string }) =>
        checkAiInputCaps({
          script: assembleScript({
            hookText: patch.hookText ?? row.hookText,
            bodyText: patch.bodyText ?? row.bodyText,
            ctaText: patch.ctaText ?? row.ctaText,
          }),
        });
      ok(mergedWith({}).ok === true, "PUT size guard: a 3k+3k+3k row is inside the cap");
      ok(mergedWith({ bodyText: "ก".repeat(12000) }).ok === false,
        "PUT size guard: growing ONE field past the cap on top of the stored row is rejected (merged check)");
      ok(checkAiInputCaps({ script: "ก".repeat(12000) }).ok === true,
        "PUT size guard: that same patch alone would have passed a patch-only check (regression guard)");
      await deleteScript("hs-owner", row.id);
    }

    // brandProfile ownership guard used by the POST/PUT routes.
    ok((await ownsBrandProfile("hs-owner", ownerProfile.id)) === true, "ownsBrandProfile: own profile → true");
    ok((await ownsBrandProfile("hs-other", ownerProfile.id)) === false,
      "ownsBrandProfile: another user's profile → false (blocks cross-user attach)");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Task 4: handoff (send-to-editor) + the FREE scripts cap
  // ════════════════════════════════════════════════════════════════════════

  // ── plan-limits: scripts caps ───────────────────────────────────────────
  ok(FREE_LIMITS.scripts === 3, "plan-limits: FREE scripts cap = 3 / 30 days");
  ok(PRO_LIMITS.scripts === Infinity, "plan-limits: PRO scripts cap = Infinity");
  ok(BUSINESS_LIMITS.scripts === Infinity, "plan-limits: BUSINESS scripts cap = Infinity");
  ok(SCRIPT_WINDOW_DAYS === 30, "SCRIPT_WINDOW_DAYS = 30 (rolling window)");

  // ── canCreateScript: FREE 3 / 30 days, paid unlimited ───────────────────
  {
    for (let n = 0; n < 3; n++) {
      ok(canCreateScript("FREE", n).allowed === true, `canCreateScript(FREE, ${n} in window) → allowed (cap 3)`);
    }
    const blocked = canCreateScript("FREE", 3);
    ok(blocked.allowed === false, "canCreateScript(FREE, 3 in window) → blocked (4th script)");
    ok(blocked.message === "แผนฟรีเขียนได้ 3 สคริปต์/30 วัน — อัปเกรดเพื่อเขียนไม่จำกัด",
      "SCRIPT_LIMIT message matches the UI spec verbatim");
    ok(canCreateScript("FREE", 99).allowed === false, "canCreateScript(FREE, over cap) → still blocked");
    ok(canCreateScript("PRO", 500).allowed === true, "canCreateScript(PRO, 500) → allowed (Infinity cap)");
    ok(canCreateScript("BUSINESS", 5000).allowed === true, "canCreateScript(BUSINESS, 5000) → allowed (Infinity cap)");
  }

  // ── countScriptsInWindow + the route's cap decision, against real rows ──
  {
    await prisma.user.createMany({
      data: [
        { id: "hs4-free", name: "Free 4", email: "hs4-free@example.test", plan: "FREE" },
        { id: "hs4-pro", name: "Pro 4", email: "hs4-pro@example.test", plan: "PRO" },
      ],
    });
    const row = (userId: string, topic: string, createdAt: Date) => prisma.script.create({
      data: { userId, topic, hookText: "h", bodyText: "b", ctaText: "c", createdAt },
    });
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    ok((await countScriptsInWindow("hs4-free")) === 0, "countScriptsInWindow: no scripts → 0");

    await row("hs4-free", "ใหม่ 1", daysAgo(0));
    await row("hs4-free", "ใหม่ 2", daysAgo(10));
    await row("hs4-free", "ใหม่ 3", daysAgo(29));
    // Outside the rolling window — must NOT count against the cap.
    await row("hs4-free", "เก่า", daysAgo(31));
    // Another user's script — must NOT count either.
    await row("hs4-pro", "ของคนอื่น", daysAgo(1));

    const freeInWindow = await countScriptsInWindow("hs4-free");
    ok(freeInWindow === 3, "countScriptsInWindow counts only the caller's rows inside the 30-day window");
    ok(canCreateScript("FREE", freeInWindow).allowed === false,
      "FREE with 3 scripts in window → 4th create blocked (SCRIPT_LIMIT)");

    // 5 scripts on PRO are fine (the verify case named in the task brief).
    for (let i = 0; i < 5; i++) {
      const count = await countScriptsInWindow("hs4-pro");
      ok(canCreateScript("PRO", count).allowed === true, `PRO script #${i + 1} in window → allowed`);
      await row("hs4-pro", `pro-${i}`, daysAgo(0));
    }
    ok((await countScriptsInWindow("hs4-pro")) === 6, "PRO user ends with 6 scripts in window (1 seed + 5) — never capped");
  }

  // ── createScriptWithinCap: count + check + insert as ONE transaction ────
  {
    await prisma.user.createMany({
      data: [
        { id: "hs4-cap-free", name: "Cap Free", email: "hs4-cap-free@example.test", plan: "FREE" },
        { id: "hs4-cap-pro", name: "Cap Pro", email: "hs4-cap-pro@example.test", plan: "PRO" },
        { id: "hs4-race", name: "Race", email: "hs4-race@example.test", plan: "FREE" },
      ],
    });
    const input = (topic: string) => ({
      topic, durationSec: 60, hookText: "h", bodyText: "b", ctaText: "c",
    });

    for (let i = 1; i <= 3; i++) {
      const r = await createScriptWithinCap("hs4-cap-free", "FREE", input(`free-${i}`));
      ok(r.ok === true, `createScriptWithinCap: FREE script #${i} → created`);
    }
    const blocked = await createScriptWithinCap("hs4-cap-free", "FREE", input("free-4"));
    ok(blocked.ok === false, "createScriptWithinCap: FREE 4th script in window → blocked (SCRIPT_LIMIT)");
    ok(blocked.ok === false && blocked.capCheck.message === "แผนฟรีเขียนได้ 3 สคริปต์/30 วัน — อัปเกรดเพื่อเขียนไม่จำกัด",
      "createScriptWithinCap: blocked result carries the SCRIPT_LIMIT message");
    ok((await prisma.script.count({ where: { userId: "hs4-cap-free" } })) === 3,
      "createScriptWithinCap: the blocked create wrote NO row");

    for (let i = 1; i <= 5; i++) {
      const r = await createScriptWithinCap("hs4-cap-pro", "PRO", input(`pro-${i}`));
      ok(r.ok === true, `createScriptWithinCap: PRO script #${i} → created (Infinity cap)`);
    }
    ok((await prisma.script.count({ where: { userId: "hs4-cap-pro" } })) === 5,
      "createScriptWithinCap: PRO wrote all 5 rows");

    // A row aging out of the rolling window frees a slot again.
    const oldest = await prisma.script.findFirst({
      where: { userId: "hs4-cap-free" }, orderBy: { createdAt: "asc" },
    });
    await prisma.script.update({
      where: { id: oldest!.id },
      data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    ok((await createScriptWithinCap("hs4-cap-free", "FREE", input("free-5"))).ok === true,
      "createScriptWithinCap: a row aged out of the 30-day window frees a slot");

    // TOCTOU: two creates fired together while the user sits at 2/3. Counting
    // outside the transaction let BOTH pass; serialized, exactly one wins.
    await prisma.script.createMany({
      data: [
        { userId: "hs4-race", topic: "race-1", hookText: "h", bodyText: "b", ctaText: "c" },
        { userId: "hs4-race", topic: "race-2", hookText: "h", bodyText: "b", ctaText: "c" },
      ],
    });
    const raced = await Promise.all([
      createScriptWithinCap("hs4-race", "FREE", input("race-3a")),
      createScriptWithinCap("hs4-race", "FREE", input("race-3b")),
    ]);
    ok(raced.filter((r) => r.ok).length === 1 && raced.filter((r) => !r.ok).length === 1,
      "createScriptWithinCap: 2 concurrent creates at 2/3 → exactly 1 created, 1 SCRIPT_LIMIT");
    ok((await prisma.script.count({ where: { userId: "hs4-race" } })) === 3,
      "createScriptWithinCap: the concurrent pair never pushed the FREE user past the cap");
  }

  // ── normalizeLines / assembleScriptForHandoff: no blank lines EVER ──────
  {
    ok(normalizeLines("a\n\nb") === "a\nb", "normalizeLines drops internal blank lines");
    ok(normalizeLines("\r\n a \r\n\r\n b \r\n") === "a\nb", "normalizeLines handles CRLF + trims each line");
    ok(normalizeLines("   ") === "", "normalizeLines of a whitespace-only block → ''");

    // The Task 3 carry-forward: user-typed blank lines survive the PUT autosave
    // (it stores bodyText verbatim), so the handoff assembly is the last line of
    // defence — the editor turns 1 line into 1 Segment.
    const typed = {
      hookText: "hook",
      bodyText: "บรรทัด 1\n\n   \nบรรทัด 2\n",
      ctaText: "\ncta",
    };
    const assembled = assembleScriptForHandoff(typed);
    ok(assembled === "hook\nบรรทัด 1\nบรรทัด 2\ncta",
      "assembleScriptForHandoff strips user-typed blank lines from every section");
    ok(!assembled.split("\n").some((line) => line.trim() === ""),
      "assembleScriptForHandoff output has no blank line anywhere");
    ok(assembleScript(typed).includes("\n\n"),
      "regression guard: the raw assembleScript of that same draft DOES contain blank lines");
    // An empty section must not leave a dangling blank line either.
    ok(assembleScriptForHandoff({ hookText: "hook", bodyText: "", ctaText: "cta" }) === "hook\ncta",
      "assembleScriptForHandoff: an empty section leaves no blank line");
  }

  // ── sendScriptToEditor ──────────────────────────────────────────────────
  {
    const { getEditorProject } = await import("../src/lib/editor-projects");

    const paidScript = await createScript("hs4-pro", {
      topic: "ส่งเข้าตัดต่อ",
      durationSec: 60,
      hookFormula: "curiosity-gap",
      structure: "pas",
      hookText: "hook ที่เลือกไว้",
      // user-typed blank lines (PUT stores them verbatim)
      bodyText: "ประโยค 1\n\nประโยค 2\n   \nประโยค 3",
      ctaText: "ตามไว้เลย",
    });

    const sent = await sendScriptToEditor("hs4-pro", paidScript.id);
    ok(sent.ok === true, "sendScriptToEditor (paid) → ok");
    if (sent.ok) {
      ok(typeof sent.projectId === "string" && sent.projectId.length > 0,
        "sendScriptToEditor returns the new projectId");

      const project = await getEditorProject("hs4-pro", sent.projectId);
      ok(project !== null, "sendScriptToEditor created a real EditorProject owned by the caller");
      const draft = (project?.draft ?? {}) as Record<string, unknown>;
      ok(draft.mode === "script", "handoff draftJson has mode: 'script'");
      ok(draft.script === "hook ที่เลือกไว้\nประโยค 1\nประโยค 2\nประโยค 3\nตามไว้เลย",
        "handoff draftJson.script === the assembled, blank-line-stripped script");
      ok(!String(draft.script).split("\n").some((line) => line.trim() === ""),
        "handoff draftJson.script contains no blank line (1 line = 1 Segment)");
      // The draft must be the editor's own default shape, not a hand-rolled object.
      ok(draft.voiceEngine !== undefined && draft.bgmVolume !== undefined && draft.mixPreset !== undefined,
        "handoff draftJson carries the editor's default project fields (shared default-draft builder)");
      ok(draft.projectTitle === "ส่งเข้าตัดต่อ" && project?.title === "ส่งเข้าตัดต่อ",
        "handoff project is titled after the script topic (draft + row agree)");
      // The editor's bootstrap rejects a project whose stored draft doesn't
      // materialize (→ "ข้อมูลโปรเจกต์ไม่สมบูรณ์"), so the handoff draft must
      // pass the editor's own validator, not just be valid JSON.
      const { materializeEditorProjectDraft } = await import("../src/lib/editor-project-recovery-journal");
      ok(materializeEditorProjectDraft(draft) !== null,
        "handoff draftJson passes the editor's own recovery-draft validator (bootstrap accepts it)");

      const after = await getScript("hs4-pro", paidScript.id);
      ok(after?.status === "sent", "sendScriptToEditor flips Script.status to 'sent'");
      ok(after?.editorProjectId === sent.projectId, "sendScriptToEditor stores editorProjectId on the Script");
    }

    // FREE plan → EDITOR_LOCKED, and nothing is created/mutated.
    const freeScript = await createScript("hs4-free", {
      topic: "ฟรีส่งไม่ได้", durationSec: 60, hookText: "h", bodyText: "b", ctaText: "c",
    });
    const projectsBefore = await prisma.editorProject.count({ where: { userId: "hs4-free" } });
    const locked = await sendScriptToEditor("hs4-free", freeScript.id);
    ok(locked.ok === false && locked.code === "EDITOR_LOCKED",
      "sendScriptToEditor (FREE) → EDITOR_LOCKED");
    ok(locked.ok === false && locked.message === "อัปเกรดเป็น PRO เพื่อส่งเข้าตัดต่อ",
      "EDITOR_LOCKED carries the UI spec's Thai upsell copy");
    ok((await prisma.editorProject.count({ where: { userId: "hs4-free" } })) === projectsBefore,
      "sendScriptToEditor (FREE) creates no EditorProject");
    ok((await getScript("hs4-free", freeScript.id))?.status === "draft",
      "sendScriptToEditor (FREE) leaves the Script as a draft");

    // IDOR: another user's script id is a 404, never a handoff.
    const foreign = await sendScriptToEditor("hs4-pro", freeScript.id);
    ok(foreign.ok === false && foreign.code === "NOT_FOUND",
      "sendScriptToEditor refuses another user's script (IDOR → NOT_FOUND)");
    ok((await getScript("hs4-free", freeScript.id))?.editorProjectId === null,
      "the foreign sendScriptToEditor attempt did not touch the row");
    ok((await sendScriptToEditor("hs4-pro", "does-not-exist")).ok === false,
      "sendScriptToEditor on a missing id → not ok");

    // ── Atomicity: the handoff is one transaction ────────────────────────
    // A script that is gone by the time the handoff runs must fail AND leave no
    // EditorProject behind (the Script write, not the ownership load, is the
    // authoritative check — count 0 rolls the project back).
    {
      const doomed = await createScript("hs4-pro", {
        topic: "โดนลบระหว่างส่ง", durationSec: 60, hookText: "h", bodyText: "b", ctaText: "c",
      });
      const projectsBefore = await prisma.editorProject.count({ where: { userId: "hs4-pro" } });
      await prisma.script.delete({ where: { id: doomed.id } });
      const gone = await sendScriptToEditor("hs4-pro", doomed.id);
      ok(gone.ok === false && gone.code === "NOT_FOUND",
        "sendScriptToEditor on a script deleted before the call → NOT_FOUND");
      ok((await prisma.editorProject.count({ where: { userId: "hs4-pro" } })) === projectsBefore,
        "sendScriptToEditor on a deleted script leaves NO orphaned EditorProject");
    }
    {
      // The rollback mechanism itself: the project create now runs INSIDE the
      // caller's transaction, so the throw that a count-0 Script write raises
      // undoes it. (Prisma 6 has no $use middleware to fault-inject the race
      // point, so the guarantee is exercised through the same code path with
      // the same tx client.)
      const { createEditorProject } = await import("../src/lib/editor-projects");
      const before = await prisma.editorProject.count({ where: { userId: "hs4-pro" } });
      const sentinel = new Error("rollback probe");
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          await createEditorProject("hs4-pro", { title: "rollback probe", draft: { mode: "script" } }, tx);
          throw sentinel;
        });
      } catch (e) {
        threw = e === sentinel;
      }
      ok(threw, "createEditorProject(tx): the probe transaction threw as expected");
      ok((await prisma.editorProject.count({ where: { userId: "hs4-pro" } })) === before,
        "createEditorProject(tx): a failed outer transaction rolls the project back (no orphan)");
      // The editor's own callers pass no tx and must keep working unchanged.
      const standalone = await createEditorProject("hs4-pro", { title: "no-tx caller" });
      ok(typeof standalone.id === "string",
        "createEditorProject without a tx still creates a project (editor's own callers unchanged)");
      await prisma.editorProject.delete({ where: { id: standalone.id } });
    }

    // A script whose sections are all blank can't become an empty editor draft.
    const blankScript = await prisma.script.create({
      data: { userId: "hs4-pro", topic: "ว่าง", hookText: " ", bodyText: "\n \n", ctaText: "" },
    });
    const blank = await sendScriptToEditor("hs4-pro", blankScript.id);
    ok(blank.ok === false && blank.code === "EMPTY_SCRIPT",
      "sendScriptToEditor rejects a script that is blank after normalization");
  }

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
