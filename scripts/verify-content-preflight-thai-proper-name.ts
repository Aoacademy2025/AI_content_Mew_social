// Regression test for #353 — Thai scripts deadlocked the Content Preflight analyzer.
// Run: npx tsx scripts/verify-content-preflight-thai-proper-name.ts
//
// The analyzer has two independent definitions of "this field contains a proper name":
//   - the VALIDATOR rejects on a bare substring match
//   - the REPAIRER only rewrites a name that stands as a whole token (word boundaries)
// Thai is written without spaces, so a Thai proper name inside Thai prose can never
// satisfy the repairer's boundaries while always tripping the validator. Repair became a
// no-op, all three self-correction attempts failed identically, and the job died with
// CONTENT_PREFLIGHT_INVALID_ANALYSIS. In prod that was 46 of 57 analyzer failures.
//
// The invariant this pins: whatever the validator rejects, the repairer must be able to
// repair — in Thai as well as in English.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "content-preflight-thai-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;

async function main() {
  const { execSync } = await import("node:child_process");
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { prisma } = await import("../src/lib/prisma");
  const { ContentPreflightError, createGeminiContentPreflightAnalyzer } =
    await import("../src/lib/content-preflight.server");

  const user = await prisma.user.create({
    data: {
      name: "Preflight owner", email: "preflight-thai@example.test", geminiKey: "test-gemini-key",
      plan: "PRO", subStatus: "active",
    },
  });

  const windows = Array.from({ length: 4 }, (_, index) => ({
    text: `ฉากที่ ${index + 1}`,
    startMs: index * 4_000,
    endMs: (index + 1) * 4_000,
  }));

  /** A Story Entity plus beats whose provider-facing prose embeds the proper name the
   *  way Thai actually writes it: glued to the surrounding words, no spaces. */
  function thaiAnalysis(properName: string, beatText: (index: number) => string) {
    return {
      contentDomain: "education",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatment: { label: "ชัดเจน", mood: "focused" },
      dominantNarrativeMode: "continuous practical explanation",
      rankedTreatmentPresetIds: ["expert-clarity", "practical-documentary", "modern-business-technology"],
      treatmentRecommendationRationale: "The whole source is a practical explanation.",
      formatRecommendation: null,
      storyEntities: [{
        entityId: "entity-1",
        entityType: "person",
        properName,
        durableAttributes: ["ผู้ชายวัยกลางคน", "สวมเสื้อเชิ้ต"],
        renderingDescription: "a middle-aged man in a shirt",
        recurringCharacterDescription: null,
        isRealPerson: false,
      }],
      beats: windows.map((window, index) => ({
        beatKey: `window-${index}`,
        sourceExcerpt: window.text,
        startMs: window.startMs,
        endMs: window.endMs,
        subject: beatText(index),
        action: "อธิบายเรื่องการทำงาน",
        setting: "ในออฟฟิศ",
        emotion: "focused",
        emphasis: `จุดที่ ${index}`,
        hardSceneFacts: {
          entityTypes: ["person"], ages: [], genders: [], actions: ["explaining"],
          locationTypes: ["office"], timeOfDay: null, historicalPeriod: null,
          count: null, essentialObjects: [],
        },
        entityRefs: ["entity-1"],
        sceneIntensity: "clear",
        safetyBoundary: "none" as const,
      })),
    };
  }

  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  // ── A. The Thai deadlock: name glued inside Thai prose ──
  let thaiCalls = 0;
  const thaiAnalyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
    thaiCalls += 1;
    // "สมชาย" sits inside "สมชายกำลังอธิบาย…" with no separator on either side.
    return JSON.stringify(thaiAnalysis("สมชาย", (index) => `สมชายกำลังอธิบายขั้นที่${index + 1}`));
  });

  let thaiResult: Awaited<ReturnType<typeof thaiAnalyzer.analyze>> | null = null;
  let thaiError: unknown = null;
  try {
    thaiResult = await thaiAnalyzer.analyze({
      kind: "creator-script",
      text: windows.map((window) => window.text).join("\n"),
      windows,
    });
  } catch (error) {
    thaiError = error;
  }

  check(
    "A1: a Thai proper name is repaired instead of failing the job",
    thaiError === null,
    thaiError instanceof ContentPreflightError ? `${thaiError.code}` : "",
  );
  check(
    "A2: repaired deterministically in ONE provider call, not three retries",
    thaiCalls === 1,
    `calls=${thaiCalls}`,
  );
  if (thaiResult) {
    const leaked = thaiResult.beats.filter((beat) =>
      [beat.subject, beat.action, beat.setting, beat.emotion, beat.emphasis, beat.sceneIntensity]
        .join(" ")
        .includes("สมชาย"));
    check("A3: the proper name never reaches a provider-facing beat field", leaked.length === 0, `leaked=${leaked.length}`);
    check(
      "A4: the beat still describes the entity",
      thaiResult.beats.every((beat) => beat.subject.trim().length > 0),
    );
  }

  // ── B. English must keep working exactly as before ──
  let englishCalls = 0;
  const englishAnalyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
    englishCalls += 1;
    return JSON.stringify(thaiAnalysis("Sam", (index) => `Sam explains step ${index + 1}`));
  });
  const englishResult = await englishAnalyzer.analyze({
    kind: "creator-script",
    text: windows.map((window) => window.text).join("\n"),
    windows,
  });
  check("B1: English name still repaired in one call", englishCalls === 1, `calls=${englishCalls}`);
  check(
    "B2: English proper name never reaches a provider-facing field",
    englishResult.beats.every((beat) => !beat.subject.includes("Sam")),
  );

  // ── C. Ordinary Thai prose with no entity name is untouched ──
  let cleanCalls = 0;
  const cleanAnalyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
    cleanCalls += 1;
    return JSON.stringify(thaiAnalysis("สมชาย", (index) => `ผู้ชายกำลังอธิบายขั้นที่${index + 1}`));
  });
  const cleanResult = await cleanAnalyzer.analyze({
    kind: "creator-script",
    text: windows.map((window) => window.text).join("\n"),
    windows,
  });
  check("C1: clean Thai prose needs no repair pass", cleanCalls === 1, `calls=${cleanCalls}`);
  assert.ok(cleanResult.beats.length === windows.length);
  check(
    "C2: clean Thai beat text is preserved byte-for-byte",
    cleanResult.beats[0].subject === "ผู้ชายกำลังอธิบายขั้นที่1",
    cleanResult.beats[0].subject,
  );

  // ── D. A name parked in one non-subject field is cleared in that field ──
  // The old validator reported every hit at `subject`, so a name left in `setting` sent the
  // model back to rewrite a field that was already clean. What a customer feels is the
  // outcome: the offending field must come back without the name, and the untouched
  // fields must stay untouched.
  let settingCalls = 0;
  const settingAnalyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
    settingCalls += 1;
    const analysis = thaiAnalysis("ดารา", () => "ผู้ชายวัยกลางคนกำลังอธิบาย");
    analysis.beats = analysis.beats.map((beat) => ({ ...beat, setting: "ในห้องประชุมของดาราสตูดิโอ" }));
    return JSON.stringify(analysis);
  });
  const settingResult = await settingAnalyzer.analyze({
    kind: "creator-script",
    text: windows.map((window) => window.text).join("\n"),
    windows,
  });
  check("D1: a name only in `setting` is repaired in one call", settingCalls === 1, `calls=${settingCalls}`);
  check(
    "D2: the name is gone from `setting`",
    settingResult.beats.every((beat) => !beat.setting.includes("ดารา")),
    settingResult.beats[0].setting,
  );
  check(
    "D2b: the replacement reads as a phrase, not fused into its Thai neighbours",
    / a middle-aged man in a shirt /.test(settingResult.beats[0].setting),
    settingResult.beats[0].setting,
  );
  check(
    "D3: the already-clean `subject` is left alone",
    settingResult.beats[0].subject === "ผู้ชายวัยกลางคนกำลังอธิบาย",
    settingResult.beats[0].subject,
  );

  // ── E. Policy net kept: a multi-word name straddling two fields is still refused ──
  // No single field holds "Sam Lee", but the provider would still receive it. This case was
  // refused before the per-field split and must stay refused — the fix is about ending an
  // unrepairable deadlock, not about letting a proper name through.
  let straddleCalls = 0;
  const straddleAnalyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
    straddleCalls += 1;
    const analysis = thaiAnalysis("Sam Lee", () => "the founder Sam");
    analysis.beats = analysis.beats.map((beat) => ({ ...beat, action: "Lee explains the process" }));
    return JSON.stringify(analysis);
  });
  let straddleRefused = false;
  try {
    await straddleAnalyzer.analyze({
      kind: "creator-script",
      text: windows.map((window) => window.text).join("\n"),
      windows,
    });
  } catch (error) {
    straddleRefused = error instanceof ContentPreflightError && error.code === "INVALID_ANALYSIS";
  }
  check("E1: a name split across adjacent fields is still refused", straddleRefused);

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
