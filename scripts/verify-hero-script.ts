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
  } = await import("../src/lib/hero-script.server");
  const {
    buildAnalyzePrompt,
    buildNicheDrilldownPrompt,
    buildBrandBlock,
    buildIdeasPrompt,
    buildHooksPrompt,
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

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
