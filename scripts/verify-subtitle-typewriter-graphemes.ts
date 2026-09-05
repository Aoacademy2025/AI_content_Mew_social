import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle } from "../src/remotion/renderSubtitle";

const samples = ["น้ำขึ้น ๆ", "ดีขึ้น", "กำลังใจ", "มิว 👩🏽‍💻 AI", "ราคา ๑๒๓ บาท"];
const segmenter = new Intl.Segmenter("th", { granularity: "grapheme" });
for (const text of samples) {
  const boundaries = new Set([0, ...Array.from(segmenter.segment(text), part => part.index + part.segment.length)]);
  for (let frame = 0; frame < 45; frame++) {
    const markup = renderToStaticMarkup(renderSubtitle(text, "#FFFFFF", 80, false, "shadow", "Kanit", 900, frame, 45, "typewriter", "#FFE500"));
    assert.ok(markup.includes('visibility:hidden'), "unrevealed glyphs must hide inherited outline and shadow too");
    const revealed = markup.match(/<span style="color:#FFFFFF">([\s\S]*?)<\/span>/)?.[1]?.replace(/\u2060/g, "");
    assert.ok(revealed !== undefined, "typewriter exposes its visible text");
    assert.ok(boundaries.has(revealed.length), `${JSON.stringify(text)} frame ${frame} splits a grapheme after ${JSON.stringify(revealed)}`);
  }
}
console.log("PASS: typewriter reveals complete Thai graphemes and emoji at every frame");
