import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle } from "../src/remotion/renderSubtitle";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`✓ ${message}`);
}

function textContent(markup: string) {
  return markup.replace(/<br\s*\/?\s*>/g, "\n").replace(/<[^>]*>/g, "");
}

function markup(text: string, effect: "karaoke" | "highlight", frame: number) {
  return renderToStaticMarkup(renderSubtitle(
    text,
    "#FFFFFF",
    80,
    false,
    "shadow",
    "Kanit",
    900,
    frame,
    45,
    effect,
    "#F87171",
    { shadow: true },
  ));
}

function karaokeMarkup(text: string, frame: number, captionDurFrames: number) {
  return renderToStaticMarkup(renderSubtitle(
    text,
    "#FFE500",
    107,
    false,
    "stroke",
    "Kanit",
    900,
    frame,
    captionDurFrames,
    "karaoke",
    "#F87171",
  ));
}

function tokenStyle(renderedMarkup: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = renderedMarkup.match(new RegExp(`<span style="([^"]*)">${escaped}<\\/span>`));
  if (!match) throw new Error(`FAIL: rendered token ${JSON.stringify(token)} was not found`);
  return match[1];
}

function karaokeAccentFrames(text: string, token: string, captionDurFrames: number): number[] {
  return Array.from({ length: captionDurFrames }, (_, frame) => frame).filter((frame) => (
    tokenStyle(karaokeMarkup(text, frame, captionDurFrames), token).includes("color:#F87171")
  ));
}

const samples = [
  "ประมาณ 170,000 บาท",
  "ประมาณ 170 , 000 บาท",
  "ลด 50%",
  "ราคา ฿599",
  "บรรทัดแรก\nบรรทัดสอง",
];

for (const effect of ["karaoke", "highlight"] as const) {
  for (const sample of samples) {
    const paused = markup(sample, effect, -1);
    assert(textContent(paused) === sample, `${effect} pause preserves ${JSON.stringify(sample)}`);
    assert(!paused.includes("#FFFFFF60"), `${effect} pause does not dim later tokens`);

    for (const frame of [0, 15, 44]) {
      assert(
        textContent(markup(sample, effect, frame)) === sample,
        `${effect} frame ${frame} preserves source text`,
      );
    }
  }
}

assert(
  markup("หนึ่ง สอง", "karaoke", 0).includes("#F87171"),
  "karaoke playback retains active accent",
);

// Production regression from Thitima's export: numeric tokens must remain
// readable while another word is active. Presence in textContent alone is not
// enough — #FFE50060 was technically present but visually disappeared against
// real footage.
const inactiveNumericStyle = tokenStyle(karaokeMarkup("มา 6 เดือน", 0, 23), "6");
assert(
  inactiveNumericStyle.includes("color:#FFE500") && !inactiveNumericStyle.includes("#FFE50060"),
  "karaoke playback keeps an inactive numeric token fully opaque",
);

const oneDigitAccentFrames = karaokeAccentFrames("มา 6 เดือน", "6", 23);
assert(
  oneDigitAccentFrames.length >= 8,
  "karaoke gives a one-digit token at least 8 active frames at 30fps",
);

const trailingNumericAccentFrames = karaokeAccentFrames("ผู้หญิงวัย 41", "41", 28);
assert(
  trailingNumericAccentFrames.filter((frame) => frame < 24).length >= 4,
  "trailing numeric token is active before the final 4-frame caption fade",
);

console.log("\n✅ SUBTITLE TEXT RENDER CHECKS PASSED");
