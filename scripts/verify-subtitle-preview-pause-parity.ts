import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle } from "../src/remotion/renderSubtitle";
import { subtitlePreviewEffectFrame } from "../src/app/(dashboard)/video-editor/_v2/subtitle-preview-frame";

const fps = 30;
const elapsedMs = 1_833;
const captionDurationFrames = 90;
const text = "แต่เจ้าของธุรกิจต้องเห็นสัญญาณ";
const expectedFrame = Math.round((elapsedMs / 1000) * fps);

function visibleTypewriterText(frame: number): string {
  const markup = renderToStaticMarkup(renderSubtitle(
    text,
    "#fff",
    80,
    false,
    "stroke",
    "Kanit",
    900,
    frame,
    captionDurationFrames,
    "typewriter",
    "#FFE500",
  ));
  return markup.match(/<span style="color:#fff">([^<]*)<\/span>/)?.[1] ?? "";
}

const pausedFrame = subtitlePreviewEffectFrame({ elapsedMs, fps });

assert.equal(pausedFrame, expectedFrame, "paused preview must keep the current timeline frame");
assert.equal(
  visibleTypewriterText(pausedFrame),
  visibleTypewriterText(expectedFrame),
  "paused typewriter preview must match the text burned at the same frame",
);

console.log("PASS paused subtitle preview matches exported frame");
