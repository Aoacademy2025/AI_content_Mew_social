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
import type { TtsTiming } from "../src/lib/tts-timing";

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
assert.ok(
  renderedStyles.some((style) => style.wordBreak === "keep-all" && style.overflowWrap === "normal"),
  "Thai subtitles must wrap only at safe word boundaries, never at arbitrary characters",
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
