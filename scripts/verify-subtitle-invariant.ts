// Locks the SUBTITLE INVARIANT: windowing must never change keywordPopups (the subtitles).
// buildKeywordPopups is the pure extraction of generate-config's inline popup builder.
// run: npx tsx scripts/verify-subtitle-invariant.ts
import { buildKeywordPopups } from "../src/lib/keyword-popups";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const caps = [
  { text: "เช้านี้เริ่มด้วยกาแฟ", startMs: 0, endMs: 1500, tag: "hook" as const },
  { text: "กลิ่นหอมกรุ่น", startMs: 1500, endMs: 3000, tag: "body" as const },
  { text: "ลุยงานต่อ", startMs: 3000, endMs: 4500, tag: "body" as const },
];
const opts = { fps: 30, durationInFrames: 135, subtitleSize: 80, primaryColor: "#FFFFFF", accentColor: "#FFE500", subtitleStylePreset: undefined, subtitlePosition: 82, subtitleFontWeight: 900 };

const a = buildKeywordPopups(caps, opts);
check("one popup per caption", a.length === 3, `${a.length}`);
check("text preserved", a[0].text === "เช้านี้เริ่มด้วยกาแฟ");
check("frames from caption timing (hook 0→45)", a[0].start === 0 && a[0].end === 45, `${a[0].start},${a[0].end}`);
check("hook uses accent color", a[0].color === "#FFE500");
check("body uses primary color", a[1].color === "#FFFFFF");
check("position passed through", a[0].topPercent === 82);

// DETERMINISM: identical input → identical output (the invariant the window flag must keep)
const b = buildKeywordPopups(caps, opts);
check("deterministic / byte-identical", JSON.stringify(a) === JSON.stringify(b));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll subtitle-invariant checks passed.");
