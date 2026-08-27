import assert from "node:assert/strict";
import { auditSubtitleReleaseRecord } from "../src/lib/subtitle-release-audit";

const passedQa = {
  status: "passed",
  timingSource: "forced_alignment",
  textExact: true,
  captionCount: 1,
  audioDurationMs: 2_000,
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
assert.ok(estimated.some((issue) => issue.code === "unverified_alignment" && issue.severity === "p0"));

const cutawayOffset = auditSubtitleReleaseRecord({
  id: "cutaway-offset",
  status: "done",
  type: "create",
  inputJson: JSON.stringify({ mode: "upload" }),
  outputJson: JSON.stringify({
    version: 2,
    mode: "preview",
    subtitleQa: { ...passedQa, timingSource: "upload_transcription" },
    preview: {
      captions: [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }],
      words: [{ word: "สวัสดี", startMs: 0, endMs: 2_000, startChar: 0, endChar: 6 }],
      fullText: "สวัสดี",
      audioDurationMs: 12_000,
      avatarModel: "upload-cutaway",
      avatarVideoUrl: "/uploaded.mp4",
      config: {
        bgVideos: [{ src: "/uploaded.mp4", start: 8, end: 12, clipOffset: 0, clipDuration: 12 }],
      },
    },
  }),
});
assert.ok(cutawayOffset.some((issue) => issue.code === "timeline_aligned_offset_mismatch" && issue.severity === "p0"));

const directWithoutEvidence = auditSubtitleReleaseRecord({
  id: "missing-evidence",
  status: "done",
  type: "create",
  inputJson: "{}",
  outputJson: JSON.stringify({ videoUrl: "/final.mp4", subtitleQa: passedQa }),
});
assert.ok(directWithoutEvidence.some((issue) => issue.code === "missing_replay_evidence" && issue.severity === "p1"));

console.log("✅ SUBTITLE RELEASE AUDIT REGRESSIONS PASSED");
