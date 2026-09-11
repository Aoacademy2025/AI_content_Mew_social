// Regression test for HERO-26 — one surplus beat threw the whole video away.
// Run: npx tsx scripts/verify-content-preflight-beat-count.ts
//
// The analyzer is asked for exactly one beat per B-roll window and validation compared the
// two counts with `!==`. On production the analyzer was never SHORT and was usually over by
// exactly one: 27/26, 40/39, 42/41, 52/51, 61/60. Eleven of the eighteen recorded attempts
// were `n+1`, not one attempt of any job ever hit the requested number, so all three
// self-corrections were spent and the job died with CONTENT_PREFLIGHT_INVALID_ANALYSIS.
// Retrying could not help: asking a language model to count to 41 is the part that does
// not work.
//
// Beats are consumed strictly by position — `resolveContentPreflight` overwrites each
// beat's `sourceExcerpt`, `startMs` and `endMs` from `windows[index]` — so a surplus beat
// is spare material and dropping it is safe as long as every window keeps ITS beat.
//
// The invariant this pins: a surplus beat is dropped, a missing beat is still refused, and
// no window is ever silently given another window's beat.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "content-preflight-beats-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;

async function main() {
  const { execSync } = await import("node:child_process");
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { prisma } = await import("../src/lib/prisma");
  const { ContentPreflightError, createGeminiContentPreflightAnalyzer } =
    await import("../src/lib/content-preflight.server");

  const user = await prisma.user.create({
    data: {
      name: "Preflight owner", email: "preflight-beats@example.test", geminiKey: "test-gemini-key",
      plan: "PRO", subStatus: "active",
    },
  });

  const windows = Array.from({ length: 6 }, (_, index) => ({
    text: `ฉากที่ ${index + 1} เล่าเรื่องต่อเนื่อง`,
    startMs: index * 4_000,
    endMs: (index + 1) * 4_000,
  }));

  /** One valid beat. `excerpt` is what the analyzer claims this beat covers — the prompt
   *  tells it to copy the matching window text into that field. */
  function beat(excerpt: string, label: string) {
    return {
      beatKey: `beat-${label}`,
      sourceExcerpt: excerpt,
      subject: `a middle-aged woman presenting point ${label}`,
      action: "explaining to the camera",
      setting: "a bright studio",
      emotion: "focused",
      emphasis: label,
      hardSceneFacts: {
        entityTypes: ["person"], ages: [], genders: [], actions: ["explaining"],
        locationTypes: ["studio"], timeOfDay: null, historicalPeriod: null,
        count: null, essentialObjects: [],
      },
      entityRefs: [],
      sceneIntensity: "clear",
      safetyBoundary: "none" as const,
    };
  }

  function analysis(beats: ReturnType<typeof beat>[]) {
    return {
      contentDomain: "education",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatment: { label: "ชัดเจน", mood: "focused" },
      dominantNarrativeMode: "continuous practical explanation",
      rankedTreatmentPresetIds: ["expert-clarity", "practical-documentary", "modern-business-technology"],
      treatmentRecommendationRationale: "The whole source is a practical explanation.",
      formatRecommendation: null,
      storyEntities: [],
      beats,
    };
  }

  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  const analyze = async (beats: ReturnType<typeof beat>[]) => {
    let calls = 0;
    const analyzer = createGeminiContentPreflightAnalyzer(user.id, async () => {
      calls += 1;
      return JSON.stringify(analysis(beats));
    });
    try {
      const result = await analyzer.analyze({
        kind: "creator-script",
        text: windows.map((window) => window.text).join("\n"),
        windows,
      });
      return { result, calls, error: null as unknown };
    } catch (error) {
      return { result: null, calls, error };
    }
  };

  const perWindow = windows.map((window, index) => beat(window.text, `w${index}`));

  // ── A. The production shape: one surplus beat at the end ──
  // Every recorded failure was the analyzer adding a beat, never dropping one.
  const trailing = await analyze([...perWindow, beat("a closing thought", "surplus")]);
  check(
    "A1: n+1 beats with a trailing surplus is accepted, not failed",
    trailing.error === null,
    trailing.error instanceof ContentPreflightError ? trailing.error.code : "",
  );
  check(
    "A2: accepted on the attempt that produced it — no extra provider call",
    trailing.calls === 1,
    `calls=${trailing.calls}`,
  );
  if (trailing.result) {
    check(
      "A3: exactly one beat per window survives",
      trailing.result.beats.length === windows.length,
      `beats=${trailing.result.beats.length}/${windows.length}`,
    );
    check(
      "A4: every window keeps ITS OWN beat, in order",
      trailing.result.beats.every((kept, index) => kept.emphasis === `w${index}`),
      trailing.result.beats.map((kept) => kept.emphasis).join(","),
    );
  }

  // ── B. A surplus beat inserted in the middle must not shift every later window ──
  // Truncating blindly would hand window 3 the beat written for window 2, and because
  // `resolveContentPreflight` overwrites sourceExcerpt by index, nothing downstream could
  // ever notice. The excerpt the analyzer copied is what keeps the mapping honest.
  const middle = await analyze([
    ...perWindow.slice(0, 3),
    beat("an aside that belongs to no window", "surplus"),
    ...perWindow.slice(3),
  ]);
  check(
    "B1: a mid-list surplus beat is accepted too",
    middle.error === null,
    middle.error instanceof ContentPreflightError ? middle.error.code : "",
  );
  if (middle.result) {
    check(
      "B2: the surplus is the beat that is dropped, not the last window's",
      middle.result.beats.every((kept, index) => kept.emphasis === `w${index}`),
      middle.result.beats.map((kept) => kept.emphasis).join(","),
    );
  }

  // ── C. Too FEW beats stays a refusal ──
  // A window with no beat has no material. Filling it would be inventing a scene.
  const short = await analyze(perWindow.slice(0, windows.length - 1));
  check(
    "C1: fewer beats than windows is still refused",
    short.error instanceof ContentPreflightError && short.error.code === "INVALID_ANALYSIS",
  );
  check(
    "C2: a short analysis still spends its self-correction attempts",
    short.calls === 3,
    `calls=${short.calls}`,
  );

  // ── D. Exactly one beat per window is untouched ──
  const exact = await analyze(perWindow);
  check("D1: the exact count still passes in one call", exact.error === null && exact.calls === 1);
  check(
    "D2: no beat is dropped when none is surplus",
    exact.result?.beats.length === windows.length,
    `beats=${exact.result?.beats.length}`,
  );

  // ── E. Surplus beats with unusable excerpts still resolve to one beat per window ──
  // The excerpt is a hint, not a guarantee: a model that paraphrases instead of copying
  // must not put the customer back in the unrepairable deadlock. Falling back to the
  // trailing assumption matches every shape production has recorded.
  const paraphrased = await analyze([
    ...windows.map((_, index) => beat(`paraphrase of window ${index}`, `w${index}`)),
    beat("paraphrase of a closing thought", "surplus"),
  ]);
  check(
    "E1: surplus is still dropped when excerpts do not match",
    paraphrased.error === null,
    paraphrased.error instanceof ContentPreflightError ? paraphrased.error.code : "",
  );
  check(
    "E2: the trailing surplus is the one dropped",
    paraphrased.result?.beats.every((kept, index) => kept.emphasis === `w${index}`) === true,
    paraphrased.result?.beats.map((kept) => kept.emphasis).join(","),
  );

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
