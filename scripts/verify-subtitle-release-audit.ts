import assert from "node:assert/strict";
import { auditSubtitleReleaseRecord } from "../src/lib/subtitle-release-audit";

const passedQa = {
  status: "passed",
  timingSource: "forced_alignment",
  textExact: true,
  captionCount: 1,
  audioDurationMs: 2_000,
  speechCoverage: { source: "silence_analysis", spokenEndMs: 1_900 },
};

const healthy = auditSubtitleReleaseRecord({
  id: "healthy",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: passedQa,
    preview: {
      captions: [{ text: "สวัสดี", startMs: 100, endMs: 1_900 }],
      words: [{ word: "สวัสดี", startMs: 100, endMs: 1_900, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 2_000,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 1_900 },
      config: { bgVideos: [] },
    },
  }),
});
assert.deepEqual(healthy, []);

const estimated = auditSubtitleReleaseRecord({
  id: "estimated",
  status: "done",
  type: "create",
  inputJson: "{}",
  outputJson: JSON.stringify({ subtitleQa: { ...passedQa, timingSource: "tts_segment_timing" } }),
});
assert.ok(
  estimated.some((issue) => issue.code === "unverified_alignment" && issue.severity === "p1"),
  "a degraded provider clock is reported, not treated as a release incident (ADR 0056)",
);

const warningRelease = auditSubtitleReleaseRecord({
  id: "warning-release",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      status: "warning",
      timingSource: "tts_segment_timing",
      textExact: true,
      code: "unverified_alignment",
    },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }],
      words: [{ word: "สวัสดี", startMs: 0, endMs: 2_000, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 2_000,
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  warningRelease.some((issue) => issue.code === "subtitle_qa_warning" && issue.severity === "p1"),
  "a released warning is reported at p1",
);
assert.ok(
  !warningRelease.some((issue) => issue.code === "failed_subtitle_qa"),
  "a warning is never counted as a failed release",
);

const legacyPresentationFailure = auditSubtitleReleaseRecord({
  id: "legacy-presentation-failure",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      status: "failed",
      timingSource: "forced_alignment",
      textExact: true,
      code: "card_too_short",
    },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }],
      words: [{ word: "สวัสดี", startMs: 0, endMs: 2_000, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 2_000,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 2_000 },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  legacyPresentationFailure.some((issue) => issue.code === "failed_subtitle_qa" && issue.severity === "p1"),
  "records persisted before ADR 0056 keep their presentation-only downgrade",
);

const generatedFallback = auditSubtitleReleaseRecord({
  id: "generated-fallback",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: { ...passedQa, timingSource: "generated_tts_fallback", speechCoverage: undefined },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }],
      words: [{ word: "สวัสดี", startMs: 0, endMs: 2_000, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 2_000,
      config: { bgVideos: [] },
    },
  }),
});
assert.deepEqual(
  generatedFallback,
  [],
  "explicit generated-TTS fallback remains auditable without being mislabeled as forced alignment",
);

const cutawayOffset = auditSubtitleReleaseRecord({
  id: "cutaway-offset",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ mode: "upload" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      ...passedQa,
      timingSource: "upload_transcription",
      audioDurationMs: 12_000,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 2_000 },
    },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }],
      words: [{ word: "สวัสดี", startMs: 0, endMs: 2_000, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 12_000,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 2_000 },
      avatarModel: "upload-cutaway",
      avatarVideoUrl: "/uploaded.mp4",
      config: {
        bgVideos: [{ src: "/uploaded.mp4", start: 8, end: 12, clipOffset: 0, clipDuration: 12 }],
      },
    },
  }),
});
assert.ok(cutawayOffset.some((issue) => issue.code === "timeline_aligned_offset_mismatch" && issue.severity === "p0"));

const uploadWithoutOptionalWords = auditSubtitleReleaseRecord({
  id: "upload-without-optional-words",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ mode: "upload" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      ...passedQa,
      timingSource: "upload_transcription",
      speechCoverage: { source: "silence_analysis", spokenEndMs: 1_900 },
    },
    preview: {
      captions: [{ text: "เสียงจริง", startMs: 100, endMs: 1_900 }],
      words: [],
      fullText: "เสียงจริง",
      audioDurationMs: 2_000,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 1_900 },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  !uploadWithoutOptionalWords.some((issue) => issue.code === "missing_word_timing"),
  "upload transcription keeps acoustically timed captions when optional regrouping words are unavailable",
);

const productionSpokenTailGap = auditSubtitleReleaseRecord({
  id: "production-spoken-tail-gap",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      ...passedQa,
      audioDurationMs: 71_140,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 70_900 },
    },
    preview: {
      captions: [{ text: "เสียงยังพูดต่อ", startMs: 0, endMs: 61_600 }],
      words: [{ word: "เสียงยังพูดต่อ", startMs: 0, endMs: 61_600, startChar: 0, endChar: 14 }],
      fullText: "เสียงยังพูดต่อ",
      audioDurationMs: 71_140,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 70_900 },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  productionSpokenTailGap.some((issue) => issue.code === "speech_coverage_incomplete" && issue.severity === "p1"),
  "persisted audit catches the production-shaped spoken-tail gap",
);

// ADR 0056: this is the shape production now ships — a warning release whose captions do
// not cover the whole spoken tail. It must be readable in the scanner without paging
// anyone: every finding p1, none p0.
const warningReleaseWithTailGap = auditSubtitleReleaseRecord({
  id: "warning-release-with-tail-gap",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      status: "warning",
      timingSource: "forced_alignment",
      textExact: true,
      code: "speech_coverage_incomplete",
      speechCoverage: { source: "silence_analysis", spokenEndMs: 70_900 },
    },
    preview: {
      captions: [{ text: "เสียงยังพูดต่อ", startMs: 0, endMs: 61_600 }],
      words: [{ word: "เสียงยังพูดต่อ", startMs: 0, endMs: 61_600, startChar: 0, endChar: 14 }],
      fullText: "เสียงยังพูดต่อ",
      audioDurationMs: 71_140,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 70_900 },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  warningReleaseWithTailGap.length > 0,
  "a warning release with a spoken-tail gap is still reported",
);
assert.deepEqual(
  warningReleaseWithTailGap.filter((issue) => issue.severity === "p0"),
  [],
  "a warning release never raises an ops p0 (ADR 0056)",
);
assert.ok(
  warningReleaseWithTailGap.some((issue) => issue.code === "subtitle_qa_warning")
    && warningReleaseWithTailGap.some((issue) => issue.code === "speech_coverage_incomplete"),
  "both the released warning and the coverage gap are visible to the scanner",
);

// Unreadable coverage evidence is an evidence bug, not a broken clip.
const unreadableCoverage = auditSubtitleReleaseRecord({
  id: "unreadable-coverage",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: { ...passedQa, speechCoverage: undefined },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 100, endMs: 1_900 }],
      words: [{ word: "สวัสดี", startMs: 100, endMs: 1_900, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 2_000,
      speechCoverage: { source: "guessed", spokenEndMs: "soon" },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  unreadableCoverage.some((issue) => issue.code === "invalid_speech_coverage" && issue.severity === "p1"),
  "unreadable coverage evidence is p1, and both invalid_speech_coverage branches agree",
);
assert.deepEqual(
  unreadableCoverage.filter((issue) => issue.severity === "p0"),
  [],
  "unreadable coverage evidence never raises an ops p0",
);

const healthyTrailingSilence = auditSubtitleReleaseRecord({
  id: "healthy-trailing-silence",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ voiceProvider: "gemini" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: {
      ...passedQa,
      audioDurationMs: 71_140,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 61_600 },
    },
    preview: {
      captions: [{ text: "เสียงจบแล้ว", startMs: 0, endMs: 61_600 }],
      words: [{ word: "เสียงจบแล้ว", startMs: 0, endMs: 61_600, startChar: 0, endChar: 11 }],
      fullText: "เสียงจบแล้ว",
      audioDurationMs: 71_140,
      speechCoverage: { source: "silence_analysis", spokenEndMs: 61_600 },
      config: { bgVideos: [] },
    },
  }),
});
assert.ok(
  !healthyTrailingSilence.some((issue) => issue.code === "speech_coverage_incomplete"),
  "proven trailing silence remains valid",
);

const directWithoutEvidence = auditSubtitleReleaseRecord({
  id: "missing-evidence",
  status: "done",
  type: "create",
  inputJson: "{}",
  outputJson: JSON.stringify({ videoUrl: "/final.mp4", subtitleQa: passedQa }),
});
assert.ok(directWithoutEvidence.some((issue) => issue.code === "missing_replay_evidence" && issue.severity === "p1"));

console.log("✅ SUBTITLE RELEASE AUDIT REGRESSIONS PASSED");
