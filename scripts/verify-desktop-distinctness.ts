// Desktop Distinctness + plan routes. Run against a throwaway SQLite DB:
//   node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-desktop-distinctness.ts
//   npm run verify:desktop-distinctness
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "desktop-plan-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.DESKTOP_PLAN_VERIFY = "1";
process.env.DESKTOP_APP = "1";
process.env.DESKTOP_ALLOWLIST = "";
process.env.MANAGED_GEMINI = "1";
process.env.GEMINI_SERVER_KEY = "test-desktop-plan-key";
execSync("./node_modules/.bin/prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const THAI_TEXT = /[ก-๙]/;
const PLAN_VERSIONS_PATH = join(process.cwd(), "src/app/api/desktop/plan-versions/route.ts");
const PLAN_SPLIT_PATH = join(process.cwd(), "src/app/api/desktop/plan-split/route.ts");

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) {
    console.error("❌ " + m);
    process.exit(1);
  }
  console.log("✓ " + m);
  passed++;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function talking(id: string, lines: string[], segSec = 8): {
  footageId: string;
  durationSec: number;
  transcript: { text: string; start: number; end: number }[];
} {
  return {
    footageId: id,
    durationSec: lines.length * segSec,
    transcript: lines.map((text, i) => ({
      text,
      start: i * segSec,
      end: i * segSec + segSec - 0.5,
    })),
  };
}

function longTranscript(durationSec: number, segSec = 5): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (let t = 0, i = 0; t < durationSec; t += segSec, i++) {
    const end = Math.min(t + segSec, durationSec);
    out.push({ text: `ประโยคที่ ${i + 1} ของคลิปยาว`, start: t, end });
  }
  return out;
}

function versionJson(items: Array<{
  sequence: string[];
  headline: string;
  caption: string;
  rationale?: string;
  overlays?: unknown[];
}>) {
  return JSON.stringify({
    versions: items.map((v) => ({
      sequence: v.sequence,
      overlays: v.overlays ?? [],
      headline: v.headline,
      caption: v.caption,
      rationale: v.rationale ?? "มุมขายต่างกัน",
    })),
  });
}

function splitJson(items: Array<{ start: number; end: number; headline: string; caption: string; reason: string }>) {
  return JSON.stringify({ segments: items });
}

async function main() {
  const versionsSource = readFileSync(PLAN_VERSIONS_PATH, "utf8");
  const splitSource = readFileSync(PLAN_SPLIT_PATH, "utf8");
  assert(versionsSource.includes("withDesktop"), "plan-versions uses withDesktop");
  assert(/export const POST = withDesktop\(/.test(versionsSource), "plan-versions POST is wrapped by withDesktop");
  assert(splitSource.includes("withDesktop"), "plan-split uses withDesktop");
  assert(/export const POST = withDesktop\(/.test(splitSource), "plan-split POST is wrapped by withDesktop");

  const {
    talkingSet,
    setsEqual,
    sharedRatio,
    distinctnessFromWorstR,
    worstSharedRatio,
    normalizeDistinctText,
    textsDistinct,
    versionsHaveEqualSets,
    maxVersionsForTalkingCount,
    enumerateAdmissibleSubsets,
    regenerateCollides,
    capForTalkingCount,
  } = await import("../src/lib/desktop/distinctness");
  const { parsePlanVersionsJson, parsePlanSplitJson } = await import("../src/lib/desktop/plan-json");
  const { passesThaiOutput } = await import("../src/lib/desktop/thai-output");
  const { recordAiTextCall } = await import("../src/lib/ai-text-limits");
  const { prisma } = await import("../src/lib/prisma");
  const { createMcpToken } = await import("../src/lib/mcp/token");
  const { setDesktopPlanTextGeneratorForTests } = await import("../src/lib/desktop/plan-model");
  const { __resetDesktopPlanRateForTest } = await import("../src/lib/desktop/plan-rate-limit");
  const { POST: POST_VERSIONS } = await import("../src/app/api/desktop/plan-versions/route");
  const { POST: POST_SPLIT } = await import("../src/app/api/desktop/plan-split/route");

  // equal sets rejected regardless of order
  const setAB = talkingSet(["a", "b"]);
  const setBA = talkingSet(["b", "a"]);
  assert(setsEqual(setAB, setBA), "talkingSet ignores order");
  assert(
    versionsHaveEqualSets([
      { sequence: ["a", "b"] },
      { sequence: ["b", "a"] },
    ]) === true,
    "equal sets rejected regardless of order",
  );
  assert(
    versionsHaveEqualSets([
      { sequence: ["a", "b"] },
      { sequence: ["a", "c"] },
    ]) === false,
    "different sets are allowed",
  );

  // maxVersions by k
  assert(maxVersionsForTalkingCount(1) === 1, "k=1 → 1");
  assert(maxVersionsForTalkingCount(2) === 1, "k=2 → 1");
  assert(maxVersionsForTalkingCount(3) === 4, "k=3 → 4");
  assert(maxVersionsForTalkingCount(4) === 8, "k=4 → 8");
  assert(maxVersionsForTalkingCount(5) === 12, "k=5 → 12");
  assert(capForTalkingCount(4) === 8, "k=4 cap is 8");
  assert(enumerateAdmissibleSubsets(["a", "b", "c", "d"]).length === 10, "k=4 admissible family size is 10");

  // r formula and สูง/กลาง/ต่ำ
  assert(sharedRatio(["a", "b"], ["a", "c"]) === 0.5, "r({a,b},{a,c}) = 0.5");
  assert(Math.abs(sharedRatio(["a", "b"], ["a", "b", "c"]) - 2 / 3) < 1e-9, "r(pair, triple) = 2/3");
  assert(sharedRatio(["a", "b"], ["a", "b"]) === 1, "r(equal) = 1");
  assert(distinctnessFromWorstR(0.40) === "สูง", "r=0.40 → สูง");
  assert(distinctnessFromWorstR(0.41) === "กลาง", "r=0.41 → กลาง");
  assert(distinctnessFromWorstR(0.70) === "กลาง", "r=0.70 → กลาง");
  assert(distinctnessFromWorstR(0.71) === "ต่ำ", "r=0.71 → ต่ำ");
  assert(worstSharedRatio(["a", "b"], [["a", "c"], ["b", "c"]]) === 0.5, "worst r among pair-vs-pair is 0.5");

  // headline/caption dedupe ignores emoji/punctuation/hashtags
  assert(
    normalizeDistinctText("ขาวจริงไหม?! 😍 #nivea") === normalizeDistinctText("ขาวจริงไหม"),
    "normalize strips emoji, punctuation, hashtags",
  );
  assert(
    textsDistinct("ผิวขาวจริงไหม ✨", "ผิวขาวจริงไหม!!! #sale") === false,
    "headline/caption dedupe ignores emoji/punctuation/hashtags",
  );
  assert(textsDistinct("ขาวจริงไหม", "คุ้มจริงไหม") === true, "different headlines stay distinct");

  // regenerate-one never collides with existing (pure)
  const existing = [
    { sequence: ["a", "b"], headline: "มุมหนึ่งของสินค้า", caption: "แคปชันหนึ่งของสินค้า" },
    { sequence: ["a", "c"], headline: "มุมสองของสินค้า", caption: "แคปชันสองของสินค้า" },
  ];
  assert(
    regenerateCollides(
      { sequence: ["b", "a"], headline: "มุมใหม่ของสินค้า", caption: "แคปชันใหม่ของสินค้า" },
      existing,
    ) === true,
    "regenerate-one collides when set matches existing (order ignored)",
  );
  assert(
    regenerateCollides(
      { sequence: ["b", "c"], headline: "มุมหนึ่งของสินค้า", caption: "แคปชันใหม่ของสินค้า" },
      existing,
    ) === true,
    "regenerate-one collides when headline matches after normalize",
  );
  assert(
    regenerateCollides(
      { sequence: ["b", "c"], headline: "มุมสามของสินค้า", caption: "แคปชันสามของสินค้า" },
      existing,
    ) === false,
    "regenerate-one accepts a new set and new copy",
  );

  // Thai-output check with a Latin product name
  assert(
    passesThaiOutput("Nivea ขาวขึ้นในเจ็ดวันจริงไหม", "Nivea") === true,
    "Thai-output check passes with Latin product name stripped",
  );
  assert(
    passesThaiOutput("Amazing Nivea cream today", "Nivea") === false,
    "Thai-output check fails when leftover text is Latin",
  );

  // JSON schema validation
  assert(parsePlanVersionsJson("not-json") === null, "invalid JSON → null");
  assert(parsePlanVersionsJson('{"versions":[]}') !== null, "empty versions array is schema-valid");
  assert(parsePlanVersionsJson('{"oops":1}') === null, "missing versions key → null");
  assert(
    parsePlanVersionsJson(versionJson([{ sequence: ["a", "b"], headline: "หัว", caption: "แคป" }])) !== null,
    "valid plan-versions JSON parses",
  );
  assert(parsePlanSplitJson("nope") === null, "invalid split JSON → null");
  assert(
    parsePlanSplitJson(splitJson([{ start: 0, end: 20, headline: "หัว", caption: "แคป", reason: "เหตุ" }])) !== null,
    "valid plan-split JSON parses",
  );

  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: {
      name: "desktop-plan",
      email: "desktop-plan@t.test",
      clerkId: "clerk_desktop_plan",
      plan: "PRO",
      subStatus: "active",
      minutesLimit: 80,
      minutesUsed: 0,
      aiAudioMinutesUsed: 0,
      aiTextCallsUsed: 0,
      usagePeriodStartedAt: new Date(),
    },
  });
  const { token: pat } = await createMcpToken(user.id, "desktop-plan");

  const usedOf = async () =>
    (await prisma.user.findUnique({
      where: { id: user.id },
      select: { aiTextCallsUsed: true },
    }))!.aiTextCallsUsed;

  const recorded = await recordAiTextCall(user.id);
  assert(recorded.allowed === true && recorded.used === 1, "recordAiTextCall increments once");
  await prisma.user.update({ where: { id: user.id }, data: { aiTextCallsUsed: 0 } });

  const product = { name: "Nivea", description: "ครีมทาผิวให้ขาวกระจ่าง", savedHeadlines: ["ขาวจริงไหม"] };
  const talkingThree = [
    talking("a", ["พูดถึงปัญหาผิวหมอง", "แนะนำครีมทาเช้า"]),
    talking("b", ["เทียบกับครีมเก่า", "บอกผลหลังใช้"]),
    talking("c", ["ราคาคุ้มไหม", "สรุปใครควรใช้"]),
  ];
  const productFootage = [{ footageId: "p1", durationSec: 4 }];

  function versionsReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/api/desktop/plan-versions", {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function splitReq(body: Record<string, unknown>): Request {
    return new Request("http://localhost/api/desktop/plan-split", {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const fourOk = versionJson([
    { sequence: ["a", "b"], headline: "ผิวหมองแก้ได้ในเจ็ดวัน", caption: "เล่าปัญหาแล้วโชว์ผลจากครีมทาเช้า #รีวิว" },
    { sequence: ["a", "c"], headline: "ราคานี้คุ้มกว่าที่คิด", caption: "เทียบราคาแล้วสรุปใครควรใช้จริง" },
    { sequence: ["b", "c"], headline: "ผลลัพธ์ต่างจากครีมเก่า", caption: "เทียบของเก่าแล้วจบด้วยใครเหมาะ" },
    { sequence: ["a", "b", "c"], headline: "ครบทุกมุมก่อนตัดสินใจซื้อ", caption: "ปัญหา ผลลัพธ์ และราคาในคลิปเดียว" },
  ]);

  // JSON schema validation + one retry on invalid JSON
  let modelCalls = 0;
  setDesktopPlanTextGeneratorForTests(async () => {
    modelCalls += 1;
    if (modelCalls === 1) return "this is not json {";
    return fourOk;
  });
  __resetDesktopPlanRateForTest();
  const retryRes = await POST_VERSIONS(versionsReq({
    product,
    talking: talkingThree,
    productFootage,
    n: 4,
    style: "sunrise",
  }));
  const retryBody = await jsonOf(retryRes);
  assert(retryRes.status === 200, "invalid JSON then valid retry → 200");
  assert(modelCalls === 2, "one retry on invalid JSON");
  assert(Array.isArray(retryBody.versions) && (retryBody.versions as unknown[]).length === 4, "retry returns 4 versions");
  assert(await usedOf() === 2, "recordAiTextCall once per model call (including retry)");

  // Thai-output check with a Latin product name (route)
  __resetDesktopPlanRateForTest();
  await prisma.user.update({ where: { id: user.id }, data: { aiTextCallsUsed: 0 } });
  modelCalls = 0;
  setDesktopPlanTextGeneratorForTests(async () => {
    modelCalls += 1;
    return fourOk;
  });
  const thaiRes = await POST_VERSIONS(versionsReq({
    product,
    talking: talkingThree,
    productFootage,
    n: 4,
    style: "ocean",
  }));
  const thaiBody = await jsonOf(thaiRes);
  assert(thaiRes.status === 200, "Latin product name plan → 200");
  assert(thaiBody.maxVersions === 4, "k=3 maxVersions is 4");
  const versions = thaiBody.versions as Array<{ headline: string; caption: string; sequence: string[] }>;
  assert(versions.every((v) => passesThaiOutput(v.headline, "Nivea") && passesThaiOutput(v.caption, "Nivea")), "route headlines/captions pass Thai-output with Latin product name");

  // regenerate-one never collides with existing (route)
  __resetDesktopPlanRateForTest();
  const existingPlans = versions.slice(0, 3).map((v, i) => ({
    index: i,
    sequence: v.sequence,
    overlays: [],
    headline: v.headline,
    caption: v.caption,
    distinctness: "กลาง",
    rationale: "มีอยู่แล้ว",
  }));
  let regenCalls = 0;
  setDesktopPlanTextGeneratorForTests(async () => {
    regenCalls += 1;
    if (regenCalls === 1) {
      return versionJson([{
        sequence: ["b", "a"],
        headline: existingPlans[0].headline,
        caption: "แคปชันชนกับของเดิม",
      }]);
    }
    return versionJson([{
      sequence: ["a", "b", "c"],
      headline: "มุมใหม่ที่ไม่ซ้ำชุดเดิม",
      caption: "แคปชันใหม่ที่ไม่ชนกับของเดิม",
    }]);
  });
  const regenRes = await POST_VERSIONS(versionsReq({
    product,
    talking: talkingThree,
    productFootage,
    n: 1,
    style: "mono",
    existing: existingPlans,
    regenerateIndex: 3,
  }));
  const regenBody = await jsonOf(regenRes);
  assert(regenRes.status === 200, "regenerate-one → 200");
  const regenVersions = regenBody.versions as Array<{ sequence: string[]; headline: string; caption: string }>;
  assert(regenVersions.length === 1, "regenerateIndex set → exactly one Version");
  assert(
    regenerateCollides(regenVersions[0], existingPlans) === false,
    "regenerate-one never collides with existing",
  );

  // plan-split spans
  __resetDesktopPlanRateForTest();
  setDesktopPlanTextGeneratorForTests(async () => splitJson([
    { start: 0, end: 30, headline: "เปิดด้วยปัญหาผิวหมอง", caption: "เล่าปัญหาแล้วชวนดูวิธีแก้", reason: "ครบประโยคและอยู่ช่วงต้นคลิป" },
    { start: 35, end: 70, headline: "โชว์ผลหลังใช้จริง", caption: "ช่วงผลลัพธ์ที่คนดูอยากเห็น", reason: "ห่างจากช่วงก่อนและจบประโยค" },
  ]));
  const splitRes = await POST_SPLIT(splitReq({
    footageId: "long1",
    durationSec: 180,
    transcript: longTranscript(180),
  }));
  const splitBody = await jsonOf(splitRes);
  assert(splitRes.status === 200, "plan-split → 200");
  const segs = splitBody.segments as Array<{ start: number; end: number; headline: string; caption: string; reason: string }>;
  assert(Array.isArray(segs) && segs.length >= 1, "plan-split returns segments");
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i].end - segs[i].start;
    assert(d >= 15 && d <= 60, `segment ${i} duration ${d} is 15–60s`);
    assert(typeof segs[i].headline === "string" && typeof segs[i].caption === "string", `segment ${i} has headline + caption`);
    if (i > 0) {
      assert(segs[i].start >= segs[i - 1].end + 3, `segment ${i} is ≥ 3s after previous`);
      assert(segs[i].start >= segs[i - 1].end, `segment ${i} does not overlap previous`);
    }
  }

  // over text ceiling → 402 AI_TEXT_QUOTA {remaining}
  __resetDesktopPlanRateForTest();
  await prisma.user.update({ where: { id: user.id }, data: { aiTextCallsUsed: 2000 } });
  let quotaCalls = 0;
  setDesktopPlanTextGeneratorForTests(async () => {
    quotaCalls += 1;
    return fourOk;
  });
  const quotaRes = await POST_VERSIONS(versionsReq({
    product,
    talking: talkingThree,
    productFootage,
    n: 1,
    style: "sunrise",
  }));
  const quotaBody = await jsonOf(quotaRes);
  assert(quotaRes.status === 402, "over text ceiling → 402");
  assert(quotaBody.code === "AI_TEXT_QUOTA", "over text ceiling → AI_TEXT_QUOTA");
  assert(typeof quotaBody.remaining === "number", "402 body has remaining");
  assert(quotaBody.remaining === 0, "at ceiling remaining is 0");
  assert(typeof quotaBody.message === "string" && THAI_TEXT.test(quotaBody.message as string), "402 Thai message");
  assert(quotaCalls === 0, "402 happens before any model call");
  assert(await usedOf() === 2000, "blocked record did not increment");

  // 11th request in a minute → 429
  await prisma.user.update({ where: { id: user.id }, data: { aiTextCallsUsed: 0 } });
  __resetDesktopPlanRateForTest();
  setDesktopPlanTextGeneratorForTests(async () => fourOk);
  let last: Response | null = null;
  let lastBody: Record<string, unknown> = {};
  for (let i = 0; i < 11; i++) {
    last = await POST_VERSIONS(versionsReq({
      product,
      talking: talkingThree,
      productFootage,
      n: 1,
      style: "sunrise",
    }));
    lastBody = await jsonOf(last);
  }
  assert(last!.status === 429, "11th request in a minute → 429");
  assert(typeof lastBody.message === "string" && THAI_TEXT.test(lastBody.message as string), "429 Thai message");

  setDesktopPlanTextGeneratorForTests(null);
  __resetDesktopPlanRateForTest();
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} DESKTOP DISTINCTNESS CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
