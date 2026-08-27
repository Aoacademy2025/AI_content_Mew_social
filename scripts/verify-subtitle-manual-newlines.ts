import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle, resolveSubtitleFontSize } from "../src/remotion/renderSubtitle";
import type { SubtitleStylePreset, SubtitleTextEffect } from "../src/remotion/types";

function check(name: string, ok: boolean) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
}

function markup(text: string, preset: SubtitleStylePreset, effect: SubtitleTextEffect) {
  return renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderSubtitle(text, "#ffffff", 80, false, preset, "'Kanit', sans-serif", 900, 5, 30, effect, "#FFE500"),
    ),
  );
}

const plain = markup("บรรทัดแรก\nบรรทัดสอง", "stroke", "pop");
check("plain presets preserve manual newline via CSS", plain.includes("white-space:pre-line"));
check("plain presets keep newline text in markup", plain.includes("บรรทัดแรก\nบรรทัดสอง"));

const highlight = markup("hello world\nnext line", "plain", "highlight");
check("highlight effect renders an explicit line break", highlight.includes("<br"));
check("highlight keeps inline spaces inside each line", highlight.includes(">hello</span> <span") && highlight.includes(">next</span> <span"));

const karaoke = markup("hello world\nnext line", "plain", "karaoke");
check("karaoke effect renders an explicit line break", karaoke.includes("<br"));
check("karaoke keeps inline spaces inside each line", karaoke.includes(">hello</span> <span") && karaoke.includes(">next</span> <span"));

const typewriter = markup("first line\nsecond line", "box", "typewriter");
check("typewriter preserves manual newline via CSS", typewriter.includes("white-space:pre-line"));

// Configured sizing is authoritative: neither adding a manual line nor using a
// longer card may silently override the size control.
const fontSize = (m: string) => (m.match(/font-size:(\d+)px/) || [])[1];
const oneShort = markup("สั้น", "stroke", "pop");
const twoShort = markup("สั้น\nสั้น", "stroke", "pop");
check("manual newline keeps the configured size", !!fontSize(oneShort) && fontSize(oneShort) === fontSize(twoShort));
const longText = "ยาวมากกกกกกกกกกกกกกก";
check(
  "configured-size mode keeps a single long line at the selected size",
  resolveSubtitleFontSize(longText, 80, true) === resolveSubtitleFontSize("สั้น", 80, true),
);
check(
  "emergency rollback still sizes a multi-line caption from its longest line",
  resolveSubtitleFontSize("สั้น\nสั้น", 80, false) === resolveSubtitleFontSize("สั้น", 80, false),
);
check(
  "emergency rollback still reduces a genuinely long line",
  resolveSubtitleFontSize(longText, 80, false) < resolveSubtitleFontSize("สั้น", 80, false),
);

console.log("All subtitle manual newline checks passed.");
