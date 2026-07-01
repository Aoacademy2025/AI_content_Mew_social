// verify-mcp-parity.ts
// Proves the two MCP→WEB quality-parity fixes at the code level (no render, no LLM call):
//   1) B-roll cadence: the orchestrator now groups captions into ~4s windows (buildBrollWindows,
//      the SAME helper the web editor uses) so the background holds one clip per window instead
//      of cutting on every caption — fixes the strobing "พื้นหลังไม่เนียน / แล้วตัด".
//   2) Sentence subtitles: captionsFromTtsTiming honors the split-script `cardsOverride` the
//      orchestrator now passes (parity with web), instead of the greedy char-cap fallback that
//      broke mid-phrase ("ตัดคำ/เว้นบรรทัดเพี้ยน").
//
// Pure — imports the same shared functions the web + MCP paths use.

import { buildBrollWindows } from "../src/lib/broll-windows";
import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import type { TtsTiming, ScriptCard } from "../src/lib/tts-timing";

let fail = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL ") + m); if (!c) fail++; };

// ───────────────────────────────────────────────────────────────────────────
// P1 — b-roll windows reduce cadence. Uses duckyhero's REAL 35-caption spans
// (from the prod clip render-1782933616178, subtitleMode=sentence, ~52s audio,
// avatarMode=full) — the exact video Mew reported as strobing.
// ───────────────────────────────────────────────────────────────────────────
console.log("P1) b-roll windows reduce cadence (duckyhero real clip: 35 captions)");
const capMs: [number, number][] = [
  [0,410],[420,890],[970,1460],[1500,1820],[1840,2210],[2240,2660],[2680,2880],[2900,3290],
  [3400,3740],[3750,4100],[4230,4700],[4700,5210],[5230,6100],[6110,6550],[6560,6940],[6940,7080],
  [7130,7730],[7740,8160],[8180,8520],[8570,9170],[9170,9550],[9650,10030],[10120,10580],[10580,11020],
  [11020,11380],[11470,11780],[12000,12600],[13000,13600],[14000,14600],[15000,15600],[16000,16600],
  [17000,17600],[18000,18600],[19000,19600],[20000,20600],
];
const realCaps = capMs.map(([s, e], i) => ({ startMs: s, endMs: e, text: `seg${i}` }));
const wins4 = buildBrollWindows(realCaps, 4);
ok(realCaps.length === 35, "35 captions in (would be 35 background cuts = strobe)");
ok(wins4.length >= 5 && wins4.length <= 14, `→ ${wins4.length} windows @4s (≈1 cut / ~4s, no strobe)`);
ok(wins4.length < realCaps.length / 2, `window count ${wins4.length} << caption count 35 (cadence capped)`);
let tiled = true;
for (let i = 1; i < wins4.length; i++) if (wins4[i].captionStartIdx !== wins4[i - 1].captionEndIdx + 1) tiled = false;
ok(tiled, "windows tile the captions with no gaps / overlaps");
ok(wins4[0].startMs === realCaps[0].startMs && wins4[wins4.length - 1].endMs === realCaps[34].endMs,
   "windows span the full [start, end] timeline");

// ───────────────────────────────────────────────────────────────────────────
// FIX A — captionsFromTtsTiming honors the split-script cardsOverride (4th arg
// the orchestrator now passes). Without an override it falls back to the greedy
// char-cap splitter (over-fragments). Same TTS timing, same renderer — only the
// card cutting differs, exactly as on the web path.
// ───────────────────────────────────────────────────────────────────────────
console.log("FIX A) sentence captions honor split-script cards (vs greedy fallback)");
const phrases = [
  "ร้านเล็กหลายร้านขายดีมากในเวลานี้ ",
  "แต่พอสิ้นเดือนเงินกลับไม่เหลือเลย ",
  "เพราะลืมนับต้นทุนแฝงหลายอย่างไป ",
  "ค่ากล่องค่าแพ็กค่าส่งค่าธรรมเนียม ",
  "และเวลาของตัวเองที่เสียไปกับงาน ",
  "ลองให้ AI ช่วยคำนวณราคาขายที่คุ้มดู",
];
let t = 0;
const segs = phrases.map((p) => { const s = { text: p, startMs: t, durationMs: p.length * 60 }; t += p.length * 60; return s; });
// gemini legitimately has chars:null; no silences → no silence-snap. Big cards → no short-merge.
const timing = { provider: "gemini", segments: segs, chars: null } as unknown as TtsTiming;
const fullText = phrases.join("");
ok(fullText.length >= 120, `fullText ${fullText.length} chars ≥120 (web split-script guard fires)`);

const greedy = captionsFromTtsTiming(timing, t, 24);
const mid = phrases.slice(0, 3).join("").length; // boundary on a phrase (word) edge
const override: ScriptCard[] = [{ startChar: 0, endChar: mid }, { startChar: mid, endChar: fullText.length }];
const withCards = captionsFromTtsTiming(timing, t, 24, override);

ok(!!greedy && !!withCards, "both greedy and override produce captions");
ok(greedy!.captions.length >= 5, `greedy char-cap over-fragments (${greedy!.captions.length} cards)`);
ok(withCards!.captions.length === 2, `override honored → exactly the 2 split-script cards (got ${withCards!.captions.length})`);
ok(withCards!.captions.length < greedy!.captions.length, "override yields fewer, sentence-level cards than greedy");
const c0 = withCards!.captions[0].text.replace(/\s/g, "");
const expected0 = fullText.slice(0, mid).replace(/\s/g, "");
ok(c0 === expected0, "card[0] = split-script span verbatim (no mid-phrase cut)");

if (fail) { console.error(`\n❌ ${fail} assertion(s) failed`); process.exit(1); }
console.log("\n✅ MCP parity (split-script sentence cards + b-roll windows): all passed");
