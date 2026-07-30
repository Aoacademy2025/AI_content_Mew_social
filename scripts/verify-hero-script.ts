// verify-hero-script.ts — Task 1 (Hero Script v1): schema + BrandProfile
// vertical slice.
//
// Exercises the service layer directly (src/lib/hero-script.server.ts,
// src/lib/prompts/hero-script.ts) against a throwaway SQLite DB — the routes
// stay thin wrappers over this logic (per the shared spec) so there's no need
// to fake a Clerk session here. NEVER points at prisma/dev.db.
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
  } = await import("../src/lib/hero-script.server");
  const { buildAnalyzePrompt, buildNicheDrilldownPrompt } = await import("../src/lib/prompts/hero-script");
  const { prisma } = await import("../src/lib/prisma");
  const { FREE_LIMITS, PRO_LIMITS, BUSINESS_LIMITS } = await import("../src/lib/plan-limits");

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

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
