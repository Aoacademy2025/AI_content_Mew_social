// Child process for verify-subtitle-balanced-break.ts §J (PR-A fix round, B1 + T2-F1).
//
// renderSubtitle reads NEXT_PUBLIC_SUBTITLE_FIT_V2 once, at import, so each fit mode
// (configured size vs the emergency legacy rollback) needs its own process. This prints,
// for every card of Mew's 48-card fixture at sizes 80 and 60, the text the burn draws and
// the text each scaled editor preview draws — display break included — so the parent can
// assert they break at the same positions.
import { readFileSync } from "node:fs";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyDisplayLineBreak,
  renderSubtitle,
  resolveSubtitleFontSize,
  SUBTITLE_FIT_V2_ENABLED,
} from "../../src/remotion/renderSubtitle";
import { renderSubEl } from "../../src/app/(dashboard)/video-editor/_components/subtitle-renderer";

// The editor's real preview scales: V2CaptionOverlay's initial 0.3 (frame width / 1080),
// v1 ActiveCaptionOverlay's 260/1080 and RightSettingsPanel's 220/1080.
const PREVIEW_SCALES = [0.3, 260 / 1080, 220 / 1080] as const;

function displayedText(node: React.ReactNode): string {
  return renderToStaticMarkup(node as React.ReactElement)
    .replace(/<br\s*\/?\s*>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\u2060/gu, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'");
}

const fixture = JSON.parse(readFileSync("scripts/fixtures/mcp-48-cards.json", "utf8")) as {
  captions: { text: string }[];
};

// One card longer than any fixture card, so the rollback mode (where the burn draws a
// length-scaled, smaller font and so rarely needs a break) still exercises a real break.
// Reported with index -1; the parent counts the 48 fixture rows separately.
const EXTRA_CARDS = [
  "เรื่องนี้มาจากคำฟ้องของบรูกส์ และความสัมพันธ์ก็ได้รับผลกระทบแล้ว เมื่อคุยนานต่อเนื่องเราอาจเห็นด้วยกับเขาทุกเรื่อง",
];

const rows: Array<{
  size: number;
  index: number;
  text: string;
  burn: string;
  previews: string[];
  atDrawnSize: string;
}> = [];

for (const size of [80, 60]) {
  const cards = [
    ...fixture.captions.map(({ text }, index) => ({ text, index })),
    ...EXTRA_CARDS.map((text) => ({ text, index: -1 })),
  ];
  cards.forEach(({ text, index }) => {
    // The burn: ShortVideoComposition passes the configured size on the 1080-wide frame.
    const burn = displayedText(renderSubtitle(
      text, "#FFFFFF", size, false, "stroke", "Kanit", 900, 0, 1, "pop", "#FFE500", {},
    ));
    // The editor previews: renderSubEl scales the font to the preview frame.
    const previews = PREVIEW_SCALES.map((scale) => displayedText(renderSubEl(
      text, "#FFFFFF", "#FFE500", false, "stroke", "Kanit", size, 900, scale, "pop", -1, 1,
    )));
    // What the burn should break at: the size actually drawn on the 1080 frame.
    const atDrawnSize = applyDisplayLineBreak(text, resolveSubtitleFontSize(text, size));
    rows.push({ size, index, text, burn, previews, atDrawnSize });
  });
}

console.log(`PARITY_JSON ${JSON.stringify({ fitV2: SUBTITLE_FIT_V2_ENABLED, scales: PREVIEW_SCALES, rows })}`);
