// Regression gate for missing provider timing.
//
// MCP must recover timestamps from the generated audio (forced alignment) and
// must never certify a proportional character clock as production-ready timing.
// The full orchestrator integration lives in verify-mcp-orchestrator.ts; this
// file exercises the alignment and final subtitle release gate directly.

import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { prepareHeroVoiceSpeechText } from "../src/lib/hero-voice-speech";
import { tokenizeWords } from "../src/lib/tts-timing";
import {
  alignTranscriptWordsToSourceDetailed,
  alignTranscriptWordsToSource,
  buildCanonicalCaptionsFromAlignedWords,
  retimeCanonicalCaptionsFromAlignedWords,
  resolveUploadTranscriptWords,
  subtitleQualityShouldFailJob,
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

// Production 2026-08-28: Gemini returned a complete, monotonic word timeline,
// but one localized ASR spelling variation made the exact projector discard all
// acoustic evidence and fall back to tts_segment_timing. A small transcription
// difference must not block the whole video when the surrounding projection is
// strongly aligned and the canonical subtitle text still comes from the script.
const minorAsrVariationScript =
  "เริ่มสร้างวิดีโอคุณภาพสูงด้วยโปรโมชั่น Hero AI วันนี้ และตรวจสอบผลลัพธ์ก่อนเผยแพร่";
const minorAsrVariationWords = [
  "เริ่ม", "สร้าง", "วิดีโอ", "คุณภาพ", "สูง", "ด้วย", "โปรโมชัน",
  "Hero", "AI", "วันนี้", "และ", "ตรวจสอบ", "ผลลัพธ์", "ก่อน", "เผยแพร่",
].map((word, index) => ({
  word,
  startMs: index * 360,
  endMs: index * 360 + 320,
}));
const minorAsrVariationAligned = alignTranscriptWordsToSource(
  minorAsrVariationScript,
  minorAsrVariationWords,
);
check(
  "complete acoustic timing survives one minor ASR spelling variation",
  !!minorAsrVariationAligned && minorAsrVariationAligned.length > 0,
);

// Production 2026-08-28: Gemini spoke authored ASCII numeric claims correctly,
// while ASR returned the Thai spoken form. Display text must remain byte-exact
// to the script, but equivalent speech evidence still needs to carry the real
// acoustic timestamps. This is not permission to fuzzy-match a changed value.
const spokenNumericScript =
  "ในปี 2026 ประหยัดเงิน 5,000 บาท เพิ่มขึ้น 20 เปอร์เซ็นต์";
const spokenNumericWords = [
  "ใน", "ปี", "สอง", "พัน", "ยี่สิบ", "หก", "ประหยัด", "เงิน",
  "ห้า", "พัน", "บาท", "เพิ่ม", "ขึ้น", "ยี่สิบ", "เปอร์เซ็นต์",
].map((word, index) => ({
  word,
  startMs: index * 300,
  endMs: index * 300 + 260,
}));
const spokenNumericAlignment = alignTranscriptWordsToSourceDetailed(
  spokenNumericScript,
  spokenNumericWords,
);
check(
  "ASCII numeric claims align to equivalent Thai spoken ASR words",
  spokenNumericAlignment.status === "aligned",
  JSON.stringify(spokenNumericAlignment),
);
check(
  "spoken-number recovery keeps canonical ASCII display text",
  spokenNumericAlignment.status === "aligned"
    && spokenNumericAlignment.words.map((word) => word.word).join("").replace(/\s+/gu, "")
      === spokenNumericScript.replace(/\s+/gu, ""),
);
const retimedSpokenNumericCards = spokenNumericAlignment.status === "aligned"
  ? retimeCanonicalCaptionsFromAlignedWords(
      spokenNumericScript,
      [
        { text: "ในปี 2026", startMs: 0, endMs: 2_000, tag: "hook" as const },
        { text: "ประหยัดเงิน 5,000 บาท เพิ่มขึ้น 20 เปอร์เซ็นต์", startMs: 2_000, endMs: 4_500, tag: "body" as const },
      ],
      spokenNumericAlignment.words,
    )
  : null;
check(
  "legacy caption cards keep their text and receive acoustic timestamps",
  !!retimedSpokenNumericCards
    && retimedSpokenNumericCards[0].text === "ในปี 2026"
    && retimedSpokenNumericCards[0].startMs === spokenNumericWords[0].startMs
    && retimedSpokenNumericCards[0].endMs > retimedSpokenNumericCards[0].startMs
    && retimedSpokenNumericCards[1].tag === "body",
);
const changedLegacyCard = spokenNumericAlignment.status === "aligned"
  ? retimeCanonicalCaptionsFromAlignedWords(
      spokenNumericScript,
      [{ text: "ในปี 2025 ประหยัดเงิน 5,000 บาท เพิ่มขึ้น 20 เปอร์เซ็นต์", startMs: 0, endMs: 4_500 }],
      spokenNumericAlignment.words,
    )
  : null;
check("legacy retiming refuses changed caption claims", changedLegacyCard === null);

const changedSpokenNumericEvidence = alignTranscriptWordsToSource(
  "ประหยัด 5,000 บาท ภายในเดือนนี้",
  [
    { word: "ประหยัด", startMs: 0, endMs: 400 },
    { word: "ห้า", startMs: 400, endMs: 600 },
    { word: "ร้อย", startMs: 600, endMs: 800 },
    { word: "บาท", startMs: 800, endMs: 1_100 },
    { word: "ภายใน", startMs: 1_100, endMs: 1_450 },
    { word: "เดือน", startMs: 1_450, endMs: 1_750 },
    { word: "นี้", startMs: 1_750, endMs: 2_000 },
  ],
);
check(
  "spoken-number recovery rejects a changed numeric value",
  changedSpokenNumericEvidence === null,
);

const spokenDigitSequence = alignTranscriptWordsToSource(
  "เบอร์โทร 081-234-5678",
  ["เบอร์", "โทร", "ศูนย์", "แปด", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด"]
    .map((word, index) => ({ word, startMs: index * 250, endMs: index * 250 + 220 })),
);
check(
  "contextual phone digits align to digit-by-digit Thai ASR speech",
  !!spokenDigitSequence,
);
const changedSpokenDigitSequence = alignTranscriptWordsToSource(
  "เบอร์โทร 081-234-5678",
  ["เบอร์", "โทร", "ศูนย์", "แปด", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "เก้า"]
    .map((word, index) => ({ word, startMs: index * 250, endMs: index * 250 + 220 })),
);
check(
  "contextual phone-digit recovery rejects one changed digit",
  changedSpokenDigitSequence === null,
);
const contextualCurrencySpeech = alignTranscriptWordsToSource(
  "ยอด -1.05 บาท ภายในปีนี้",
  ["ยอด", "ลบ", "หนึ่ง", "บาท", "ห้า", "สตางค์", "ภายใน", "ปี", "นี้"]
    .map((word, index) => ({ word, startMs: index * 280, endMs: index * 280 + 240 })),
);
check(
  "signed Thai baht decimals align to their contextual spoken form",
  !!contextualCurrencySpeech,
);
const literalDecimalCurrencySpeech = alignTranscriptWordsToSource(
  "ยอด 1.05 บาท ภายในปีนี้",
  ["ยอด", "หนึ่ง", "จุด", "ศูนย์", "ห้า", "บาท", "ภายใน", "ปี", "นี้"]
    .map((word, index) => ({ word, startMs: index * 280, endMs: index * 280 + 240 })),
);
check(
  "Gemini-style literal baht decimals keep their observed spoken form",
  !!literalDecimalCurrencySpeech,
);
const changedContextualCurrencySpeech = alignTranscriptWordsToSource(
  "ยอด -1.05 บาท ภายในปีนี้",
  ["ยอด", "ลบ", "หนึ่ง", "บาท", "หก", "สตางค์", "ภายใน", "ปี", "นี้"]
    .map((word, index) => ({ word, startMs: index * 280, endMs: index * 280 + 240 })),
);
check(
  "contextual currency recovery rejects a changed satang value",
  changedContextualCurrencySpeech === null,
);
const structuredSpeechScripts = [
  "วันที่ 1/1/2026 เปิดตัว",
  "เวลา 09:30 น. เริ่มงาน",
  "2026-08-28 เปิดตัว",
  "ยอด 10–20 บาท",
  "วิ่ง 20 km ใน 2 ชั่วโมง",
  "อุณหภูมิ 37°C วันนี้",
];
const structuredSpeechAlignments = structuredSpeechScripts.map((source) => {
  const spoken = prepareHeroVoiceSpeechText(source);
  const words = tokenizeWords(spoken).map((word, index) => ({
    word: word.word,
    startMs: index * 220,
    endMs: index * 220 + 190,
  }));
  return alignTranscriptWordsToSource(source, words);
});
check(
  "dates, times, ranges, and units align through the shared speech contract",
  structuredSpeechAlignments.every(Boolean),
);
const changedStructuredSpeech = prepareHeroVoiceSpeechText("เวลา 09:35 น. เริ่มงาน");
const changedStructuredWords = tokenizeWords(changedStructuredSpeech).map((word, index) => ({
  word: word.word,
  startMs: index * 220,
  endMs: index * 220 + 190,
}));
check(
  "structured numeric recovery rejects a changed time",
  alignTranscriptWordsToSource("เวลา 09:30 น. เริ่มงาน", changedStructuredWords) === null,
);

// Production 2026-08-28: the authored text and ASR both contained "ตีสาม",
// but Gemini inserted an acoustic sound-effect token beside it. Global edit
// distance mapped the final ม onto an adjacent source word and the old hard
// boundary guard rejected a correct numeric claim. Exact local numeric evidence
// may survive non-numeric insertions; a numeric continuation must still fail.
const numericAnchorScript =
  "เขาเดินกลับมาที่ห้องเหมือนเดิมทุกคืนตอนตีสามเสียงเก้าอี้ลากแล้วเขาก็นั่งหันหน้าเข้ากำแพง";
const numericAnchorSourceWords = tokenizeWords(numericAnchorScript).map((word) => word.word);
const numericAnchorIndex = numericAnchorSourceWords.indexOf("สาม");
const numericAnchorWithSound = [...numericAnchorSourceWords];
numericAnchorWithSound.splice(numericAnchorIndex + 1, 0, "ครืดดดด");
const anchoredNumericAlignment = alignTranscriptWordsToSource(
  numericAnchorScript,
  numericAnchorWithSound.map((word, index) => ({
    word,
    startMs: index * 220,
    endMs: index * 220 + 190,
  })),
);
check(
  "exact local numeric speech survives a neighboring non-numeric ASR insertion",
  anchoredNumericAlignment !== null,
);
const numericAnchorWithChairEcho = [...numericAnchorSourceWords];
numericAnchorWithChairEcho.splice(numericAnchorIndex + 1, 0, "เก้าอี้");
const numericChairEchoAlignment = alignTranscriptWordsToSourceDetailed(
  numericAnchorScript,
  numericAnchorWithChairEcho.map((word, index) => ({
    word,
    startMs: index * 220,
    endMs: index * 220 + 190,
  })),
);
check(
  "number-like syllables inside ordinary ASR words do not become numeric continuations",
  numericChairEchoAlignment.status === "aligned",
  numericChairEchoAlignment.status === "failed" ? numericChairEchoAlignment.code : "",
);
const numericAnchorWithChangedValue = [...numericAnchorSourceWords];
numericAnchorWithChangedValue.splice(numericAnchorIndex + 1, 0, "สิบ");
check(
  "numeric continuation beside a local anchor remains fail-closed",
  alignTranscriptWordsToSource(
    numericAnchorScript,
    numericAnchorWithChangedValue.map((word, index) => ({
      word,
      startMs: index * 220,
      endMs: index * 220 + 190,
    })),
  ) === null,
);

const numericAnchorWithNeighborTypo = [...numericAnchorSourceWords];
numericAnchorWithNeighborTypo[numericAnchorIndex + 1] = numericAnchorWithNeighborTypo[
  numericAnchorIndex + 1
].slice(1);
check(
  "numeric anchor survives a missing first character in the neighboring ASR word",
  alignTranscriptWordsToSource(
    numericAnchorScript,
    numericAnchorWithNeighborTypo.map((word, index) => ({
      word,
      startMs: index * 220,
      endMs: index * 220 + 190,
    })),
  ) !== null,
);
const numericAnchorWithContinuationAndNeighborTypo = [...numericAnchorWithNeighborTypo];
numericAnchorWithContinuationAndNeighborTypo.splice(numericAnchorIndex + 1, 0, "สิบ");
check(
  "numeric continuation remains fail-closed when the neighboring ASR word loses a character",
  alignTranscriptWordsToSource(
    numericAnchorScript,
    numericAnchorWithContinuationAndNeighborTypo.map((word, index) => ({
      word,
      startMs: index * 220,
      endMs: index * 220 + 190,
    })),
  ) === null,
);

const changedNumericEvidence = alignTranscriptWordsToSource(
  "ประหยัด 5,000 บาท ภายในเดือนนี้",
  [
    { word: "ประหยัด", startMs: 0, endMs: 400 },
    { word: "500", startMs: 400, endMs: 800 },
    { word: "บาท", startMs: 800, endMs: 1_100 },
    { word: "ภายใน", startMs: 1_100, endMs: 1_450 },
    { word: "เดือน", startMs: 1_450, endMs: 1_750 },
    { word: "นี้", startMs: 1_750, endMs: 2_000 },
  ],
);
check(
  "fuzzy acoustic recovery still rejects changed numeric claims",
  changedNumericEvidence === null,
);

const overlapFailure = alignTranscriptWordsToSourceDetailed(script, [
  { word: "ประหยัด", startMs: 100, endMs: 700 },
  { word: "เงิน", startMs: 650, endMs: 850 },
]);
check(
  "alignment reports the exact timing failure instead of collapsing to null",
  overlapFailure.status === "failed" && overlapFailure.code === "overlapping_timing",
);

// Upload transcription captions are already aligned directly to the uploaded
// audio. Per-word char offsets are optional editor metadata; disagreement
// between two ASR projections must disable regrouping, not fail the whole clip.
const uploadFallback = resolveUploadTranscriptWords(
  "เสียงจริงจากคลิป",
  [
    { word: "ข้อความ", startMs: 0, endMs: 500 },
    { word: "คนละแบบ", startMs: 500, endMs: 1_000 },
  ],
);
check("upload keeps its acoustic captions when optional word regrouping cannot align", !uploadFallback.regroupingAvailable);
check("upload fallback exposes why regrouping was disabled", uploadFallback.failureCode === "text_mismatch");
check("upload fallback does not ship unsafe per-word offsets", uploadFallback.words.length === 0);

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
  "changed numbers still flag text_mismatch",
  changedNumber.status === "failed" && changedNumber.code === "text_mismatch",
);
check(
  "text_mismatch blocks release because the spoken promise cannot be repaired after export",
  changedNumber.status === "failed" && subtitleQualityShouldFailJob(changedNumber) === true,
);

const estimatedTiming = validateSubtitleQuality({
  script,
  captions,
  audioDurationMs: 3_000,
  timingSource: "tts_segment_timing",
});
check(
  "estimated TTS segment timing cannot certify subtitle/audio alignment",
  estimatedTiming.status === "failed"
    && estimatedTiming.code === "unverified_alignment"
    && subtitleQualityShouldFailJob(estimatedTiming) === true,
);

const estimatedWithSpacingIssue = validateSubtitleQuality({
  script,
  captions: captions.map((caption, index) => index === 1 ? { ...caption, text: "5,000บาท" } : caption),
  audioDurationMs: 3_000,
  timingSource: "tts_segment_timing",
});
check(
  "presentation issues cannot mask unverified audio timing",
  estimatedWithSpacingIssue.status === "failed"
    && estimatedWithSpacingIssue.code === "unverified_alignment"
    && subtitleQualityShouldFailJob(estimatedWithSpacingIssue) === true,
);

const lostInternalSpace = validateSubtitleQuality({
  script,
  captions: captions.map((caption, index) => index === 1 ? { ...caption, text: "5,000บาท" } : caption),
  audioDurationMs: 3_000,
  timingSource: "forced_alignment",
});
check(
  "lost spacing inside a displayed card still flags spacing_mismatch",
  lostInternalSpace.status === "failed" && lostInternalSpace.code === "spacing_mismatch",
);
check(
  "spacing_mismatch does not fail the VideoJob",
  subtitleQualityShouldFailJob(lostInternalSpace) === false,
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
check(
  "timing_out_of_bounds still fails the VideoJob",
  subtitleQualityShouldFailJob(outOfBounds) === true,
);
const punctOnly = validateSubtitleQuality({
  script: "ครับ...",
  captions: [
    { text: "ครับ", startMs: 0, endMs: 400 },
    { text: "...", startMs: 400, endMs: 700 },
  ],
  audioDurationMs: 800,
  timingSource: "forced_alignment",
});
check(
  "punctuation-only cards do not fail the VideoJob",
  punctOnly.status === "failed"
    && punctOnly.code === "punctuation_only_card"
    && subtitleQualityShouldFailJob(punctOnly) === false,
);
const tooShort = validateSubtitleQuality({
  script: "ครับ",
  captions: [{ text: "ครับ", startMs: 0, endMs: 100 }],
  audioDurationMs: 800,
  timingSource: "forced_alignment",
});
check(
  "card_too_short does not fail the VideoJob",
  tooShort.status === "failed"
    && tooShort.code === "card_too_short"
    && subtitleQualityShouldFailJob(tooShort) === false,
);
const emptyCaps = validateSubtitleQuality({
  script: "ครับ",
  captions: [],
  audioDurationMs: 800,
  timingSource: "tts_segment_timing",
});
check(
  "empty_captions still fails the VideoJob",
  emptyCaps.status === "failed"
    && emptyCaps.code === "empty_captions"
    && subtitleQualityShouldFailJob(emptyCaps) === true,
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
