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

console.log("\n✅ SUBTITLE TEXT RENDER CHECKS PASSED");
