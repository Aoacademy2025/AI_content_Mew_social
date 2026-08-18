// Regression gate for missing provider timing.
//
// MCP must recover timestamps from the generated audio (forced alignment) and
// must never certify a proportional character clock as production-ready timing.
// The full orchestrator integration lives in verify-mcp-orchestrator.ts; this
// file exercises the alignment and final subtitle release gate directly.

import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import {
  alignTranscriptWordsToSource,
  buildCanonicalCaptionsFromAlignedWords,
  validateSubtitleQuality,
} from "../src/lib/mcp/subtitle-quality";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const script = "ประหยัดเงิน 5,000 บาท ทุกเดือน";
check(
  "missing provider timing is not converted into captions locally",
  captionsFromTtsTiming(undefined, 3_000, 27) === null,
);

const transcriptWords = [
  { word: "ประหยัด", startMs: 100, endMs: 550 },
  { word: "เงิน", startMs: 550, endMs: 850 },
  { word: "5,000", startMs: 900, endMs: 1_300 },
  { word: "บาท", startMs: 1_350, endMs: 1_700 },
  { word: "ทุก", startMs: 1_750, endMs: 2_050 },
  { word: "เดือน", startMs: 2_050, endMs: 2_600 },
];
const aligned = alignTranscriptWordsToSource(script, transcriptWords);
check("forced alignment maps timestamps onto canonical source tokens", !!aligned && aligned.length > 0);
check(
  "forced alignment retains exact authored text and numbers",
  aligned?.map((word) => word.word).join("").replace(/\s+/gu, "") === script.replace(/\s+/gu, ""),
);

const captions = [
  { text: "ประหยัดเงิน", startMs: 100, endMs: 850 },
  { text: "5,000 บาท", startMs: 900, endMs: 1_700 },
  { text: "ทุกเดือน", startMs: 1_750, endMs: 2_600 },
];
const passed = validateSubtitleQuality({
  script,
  captions,
  audioDurationMs: 3_000,
  timingSource: "forced_alignment",
});
check("exact forced-aligned captions pass the release gate", passed.status === "passed");

const changedNumber = validateSubtitleQuality({
  script,
  captions: captions.map((caption, index) => index === 1 ? { ...caption, text: "500 บาท" } : caption),
  audioDurationMs: 3_000,
  timingSource: "forced_alignment",
});
check(
  "changed numbers fail closed",
  changedNumber.status === "failed" && changedNumber.code === "text_mismatch",
);

const lostInternalSpace = validateSubtitleQuality({
  script,
  captions: captions.map((caption, index) => index === 1 ? { ...caption, text: "5,000บาท" } : caption),
  audioDurationMs: 3_000,
  timingSource: "forced_alignment",
});
check(
  "lost spacing inside a displayed card fails closed",
  lostInternalSpace.status === "failed" && lostInternalSpace.code === "spacing_mismatch",
);

const outOfBounds = validateSubtitleQuality({
  script,
  captions: captions.map((caption, index) => index === 2 ? { ...caption, endMs: 3_500 } : caption),
  audioDurationMs: 3_000,
  timingSource: "forced_alignment",
});
check(
  "captions outside the audio timeline fail closed",
  outOfBounds.status === "failed" && outOfBounds.code === "timing_out_of_bounds",
);

// Production regression (2026-08-13..18): all five text_mismatch jobs used
// forced_alignment. The transcribe route intentionally sanitizes punctuation
// from its display captions, while the generated audio was spoken from this
// exact script. Reuse only the transcript timestamps; subtitle text must come
// back from canonical source ranges so quotes, ellipses, numbers and question
// marks cannot disappear.
const punctuatedScript = "ก่อนเริ่ม... พูดว่า “Hero AI” ช่วยได้ 10 เท่า จริงไหม?";
const punctuatedSourceWords = ["ก่อน", "เริ่ม", "พูด", "ว่า", "Hero", "AI", "ช่วย", "ได้", "10", "เท่า", "จริง", "ไหม"];
const punctuatedTranscriptWords = punctuatedSourceWords.map((word, index) => ({
  word,
  startMs: index * 400,
  endMs: index * 400 + 360,
}));
const punctuatedAligned = alignTranscriptWordsToSource(punctuatedScript, punctuatedTranscriptWords);
check("punctuation-sanitized transcript words align to the exact source", !!punctuatedAligned);
const canonicalCaptions = punctuatedAligned
  ? buildCanonicalCaptionsFromAlignedWords(punctuatedScript, punctuatedAligned, 28)
  : null;
check("forced alignment rebuilds captions from canonical source ranges", !!canonicalCaptions);
const canonicalQuality = canonicalCaptions
  ? validateSubtitleQuality({
      script: punctuatedScript,
      captions: canonicalCaptions,
      audioDurationMs: 5_000,
      timingSource: "forced_alignment",
    })
  : null;
check(
  "forced-alignment fallback preserves punctuation and passes the release gate",
  canonicalQuality?.status === "passed",
  JSON.stringify(canonicalQuality),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll forced-alignment subtitle checks passed ✓");
