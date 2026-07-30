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
  } = await import("../src/lib/hero-script.server");
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
  delete process.env.MANAGED_GEMINI;
  delete process.env.GEMINI_SERVER_KEY;
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
    }
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

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
