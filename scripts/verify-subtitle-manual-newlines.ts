import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle } from "../src/remotion/renderSubtitle";
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

// Regression guard: a multi-line caption must be sized by its LONGEST line, not total
// length — splitting short lines with "\n" must not shrink the font (the manual-newline bug).
const fontSize = (m: string) => (m.match(/font-size:(\d+)px/) || [])[1];
const oneShort = markup("สั้น", "stroke", "pop");
const twoShort = markup("สั้น\nสั้น", "stroke", "pop");
check("multi-line caption sized by longest line, not total (no shrink)", !!fontSize(oneShort) && fontSize(oneShort) === fontSize(twoShort));
// No regression for single-line captions: a genuinely long single line still scales down.
const longLine = markup("ยาวมากกกกกกกกกกกกกกก", "stroke", "pop");
check("single long line still scales down (no regression)", Number(fontSize(longLine)) < Number(fontSize(oneShort)));

console.log("All subtitle manual newline checks passed.");
