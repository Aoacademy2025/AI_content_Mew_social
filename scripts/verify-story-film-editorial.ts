import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHeroSubtitleOverlayConfig } from "../src/lib/hero-editorial";
import { protectSubtitleWordBreaks, renderSubtitle } from "../src/remotion/renderSubtitle";
import {
  captionsForStoryFilmEditorial,
  createDefaultStoryFilmEditorialConfig,
  parseStoryFilmCaptionTrack,
  storyFilmCaptionTrackFromTtsTiming,
  storyFilmSubtitleDesign,
  validateStoryFilmEditorialConfig,
} from "../src/lib/story-film-editorial";
import { buildCanonicalCaptionsFromAlignedWords } from "../src/lib/mcp/subtitle-quality";
import { tokenizeWords, type TtsTiming } from "../src/lib/tts-timing";

const spoken = "คืนหนึ่ง มิวพบข้อความที่ไม่ควรอยู่บนจอ";
const characters = Array.from(spoken);
const timing: TtsTiming = {
  provider: "elevenlabs",
  segments: [{ text: spoken, startMs: 0, durationMs: 8_000 }],
  chars: {
    characters,
    startSec: characters.map((_, index) => index * 8 / characters.length),
    endSec: characters.map((_, index) => (index + 1) * 8 / characters.length),
  },
};

const track = storyFilmCaptionTrackFromTtsTiming(timing, 8_000, "elevenlabs_alignment");
assert.ok(track && track.captions.length > 0 && track.words.length > 0, "ElevenLabs alignment becomes a durable caption track");
assert.equal(parseStoryFilmCaptionTrack(JSON.parse(JSON.stringify(track)))?.source, "elevenlabs_alignment");

const editorial = createDefaultStoryFilmEditorialConfig(spoken, 8_000);
const validated = validateStoryFilmEditorialConfig({
  ...editorial,
  subtitleMode: "2",
  subtitleStylePreset: "box-rounded",
  subtitleTextEffect: "fade",
  subtitleFontSize: 60,
  subtitleFontWeight: 600,
  textOverlays: [{ sceneKey: "scene-01", text: "ข้อความที่ไม่มีใครควรเห็น" }],
}, 8_000);
const captions = captionsForStoryFilmEditorial({
  editorial: validated,
  track,
  scenes: [{ sceneKey: "scene-01", startMs: 0, endMs: 4_000, sourceExcerpt: spoken }],
});
assert.ok(captions.some((caption) => caption.text === "ข้อความที่ไม่มีใครควรเห็น"), "scene text replaces only its caption window");

const config = buildHeroSubtitleOverlayConfig({
  baseVideoUrl: "http://127.0.0.1:3000/api/renders/base.mp4",
  captions,
  durationMs: 8_000,
  design: storyFilmSubtitleDesign(validated),
  headlineHook: validated.headlineHook,
});
assert.equal(config.subtitleStylePreset, "box-rounded");
assert.equal(config.headlineHook?.enabled, true);
assert.ok(config.keywordPopups.length > 0 && config.durationInFrames === 240);
assert.equal(config.keywordPopups[0]?.size, 60, "MCP subtitle size must reach the shared Hero renderer");
assert.equal(config.keywordPopups[0]?.fontWeight, 600, "MCP subtitle weight must reach the shared Hero renderer");

const renderedSubtitle = renderSubtitle(
  "เดือนพฤษภาคม 2025 อัลลัน บรูกส์ ชาวแคนาดา",
  "#FFFFFF",
  60,
  false,
  "box-rounded",
  "'Kanit', 'Noto Sans Thai', sans-serif",
  600,
  0,
  60,
  "fade",
  "#FFE500",
);
const renderedStyles: Array<Record<string, unknown>> = [];
function collectStyles(node: unknown) {
  if (!node || typeof node !== "object") return;
  const element = node as { props?: { style?: Record<string, unknown>; children?: unknown } };
  if (element.props?.style) renderedStyles.push(element.props.style);
  const children = element.props?.children;
  if (Array.isArray(children)) children.forEach(collectStyles);
  else collectStyles(children);
}
collectStyles(renderedSubtitle);
assert.match(
  protectSubtitleWordBreaks("อัลลัน"),
  /\u2060/u,
  "a short Thai proper name must be protected as one author-delimited token",
);
const displayRegressionText = "เรื่องนี้มาจากคำฟ้องของบรูกส์ และความสัมพันธ์ก็ได้รับผลกระทบแล้ว เมื่อคุยนานต่อเนื่องเราอาจเห็นด้วยกับเขาทุกเรื่อง คนนอกวงมองไม่เห็นว่าเรากำลังหลงทาง";
const graphemeSegmenter = new Intl.Segmenter("th", { granularity: "grapheme" });
const protectedDisplayText = protectSubtitleWordBreaks(displayRegressionText);
for (const term of ["บรูกส์", "ผลกระทบ", "ต่อเนื่อง", "ทุกเรื่อง", "มองไม่เห็น", "หลงทาง"]) {
  const protectedTerm = Array.from(graphemeSegmenter.segment(term), (part) => part.segment).join("\u2060");
  assert.ok(
    protectedDisplayText.includes(protectedTerm),
    `Thai display wrapping must keep ${term} on one side of a line break`,
  );
}
assert.equal(
  protectedDisplayText.replaceAll("\u2060", ""),
  displayRegressionText,
  "display-only Thai break protection must preserve every authored character",
);
assert.ok(
  renderedStyles.some((style) => style.wordBreak === "keep-all" && style.overflowWrap === "normal"),
  "Thai subtitles must wrap only at safe word boundaries, never at arbitrary characters",
);

const thaiRegressionSource = [
  "เรื่องนี้มาจากคำฟ้องของบรูกส์ และคดียังไม่ได้ตัดสินนะครับ",
  "ชื่อเสียง และความสัมพันธ์ก็ได้รับผลกระทบแล้ว",
  "ต่อมาบริษัทเพิ่มคำเตือนให้พักเมื่อคุยนานต่อเนื่อง ส่วนคดีนี้ยังไม่ตัดสินครับ",
].join("\n");
const thaiRegressionWords = tokenizeWords(thaiRegressionSource).map((word, index) => ({
  ...word,
  startMs: index * 180,
  endMs: index * 180 + 160,
}));
const narrowThaiCaptions = buildCanonicalCaptionsFromAlignedWords(
  thaiRegressionSource,
  thaiRegressionWords,
  27,
);
assert.ok(narrowThaiCaptions, "Thai regression fixture must build canonical captions");

const sentenceTrack = {
  version: 1 as const,
  source: "forced_alignment" as const,
  fullText: thaiRegressionSource,
  captions: narrowThaiCaptions,
  words: thaiRegressionWords,
};
const sentenceCaptions = captionsForStoryFilmEditorial({
  editorial: {
    ...createDefaultStoryFilmEditorialConfig(thaiRegressionSource, 12_000),
    subtitleMode: "sentence",
  },
  track: sentenceTrack,
  scenes: [{
    sceneKey: "scene-01",
    startMs: 0,
    endMs: 12_000,
    sourceExcerpt: thaiRegressionSource,
  }],
});
assert.ok(
  sentenceCaptions.length < narrowThaiCaptions.length,
  "Story Film sentence mode must regroup a dense alignment into readable phrase cards",
);
assert.ok(
  sentenceCaptions.every((caption) => caption.endMs - caption.startMs >= 1_000),
  "Story Film sentence cards must remain on screen for at least one second",
);
const brokenProtectedTerms = ["บรูกส์", "ผลกระทบ", "ต่อเนื่อง"].filter((term) =>
  sentenceCaptions.some((caption, index, all) => (
    index < all.length - 1
    && `${caption.text}${all[index + 1].text}`.includes(term)
    && !caption.text.includes(term)
    && !all[index + 1].text.includes(term)
  )),
);
assert.deepEqual(
  brokenProtectedTerms,
  [],
  "Story Film phrase cards must not split real Thai names or compounds",
);

const compressedWords = thaiRegressionWords.map((word, index) => ({
  ...word,
  startMs: index,
  endMs: index + 1,
}));
assert.equal(
  parseStoryFilmCaptionTrack({ ...sentenceTrack, words: compressedWords }),
  null,
  "a forced alignment that compresses many spoken words into milliseconds must fail closed",
);

const renderer = readFileSync("src/lib/story-film-render.server.ts", "utf8");
const presenterAlignment = readFileSync("src/lib/story-film-caption-alignment.server.ts", "utf8");
assert.match(renderer, /runRender\(/, "Story Film final burn must reuse Hero's Remotion render core");
assert.match(renderer, /buildHeroSubtitleOverlayConfig/, "Story Film must use the shared editorial contract");
assert.doesNotMatch(renderer, /\[V4\+ Styles\]|buildEditorialAss|ass='/, "the duplicate ASS subtitle path must stay removed");
assert.match(presenterAlignment, /resolveUploadTranscriptWords/, "presenter ASR words must align back to the exact authored script");
assert.match(presenterAlignment, /buildCanonicalCaptionsFromAlignedWords/, "presenter captions must keep canonical script text");

console.log("ok: provider timing becomes the canonical Story Film caption track");
console.log("ok: subtitle density, scene replacement, and Headline share Hero's overlay config");
console.log("ok: Story Film has no parallel ASS subtitle renderer");
console.log("ok: presenter uploads use Hero's canonical forced-alignment quality path");
