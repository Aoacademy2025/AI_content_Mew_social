// T6 (hv-emotion) — Step 1 report artifact: winner S2/S3 CER before (raw
// display text, T5 matrix) vs after (normalized speechText, T6 re-render).
// Prints a Markdown table to stdout for pasting into task-6-report.md.
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const MATRIX_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const FIDELITY_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24", "fidelity");

type ScreenRow = { label: string; group: string; cer: number; disqualified: boolean; transcript_actual: string };
function loadScreenOut(p: string): Map<string, ScreenRow> {
  const data = JSON.parse(readFileSync(p, "utf-8")) as { voices: ScreenRow[] };
  const map = new Map<string, ScreenRow>();
  for (const row of data.voices) map.set(`${row.group}::${row.label}`, row);
  return map;
}
const matrixScreen = loadScreenOut(path.join(MATRIX_ROOT, "eval", "screen-out.json"));
const fidelityScreen = loadScreenOut(path.join(FIDELITY_ROOT, "screen-out.json"));

// Same CER algorithm as scripts/screen-hero-voice-expressiveness.py
// (character_error_rate / normalized_text) — reimplemented here so we can
// score the SAME transcript_actual against a DIFFERENT reference (the raw
// display text) than the one the harness scored it against (the normalized
// speechText), to isolate a measurement confound (see report).
function normalizedForCer(value: string): string {
  return [...value].filter((c) => /\p{L}|\p{N}/u.test(c)).map((c) => c.toLowerCase()).join("");
}
function characterErrorRate(expected: string, actual: string): number {
  const left = normalizedForCer(expected);
  const right = normalizedForCer(actual);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let li = 1; li <= left.length; li++) {
    const current = [li];
    for (let ri = 1; ri <= right.length; ri++) {
      current.push(Math.min(
        current[current.length - 1] + 1,
        previous[ri] + 1,
        previous[ri - 1] + (left[li - 1] !== right[ri - 1] ? 1 : 0),
      ));
    }
    previous = current;
  }
  return previous[previous.length - 1] / Math.max(1, left.length);
}

const RAW_TEXT: Record<string, string> = {
  S2: "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา",
  S3: "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด",
};

type WinnersFile = Record<string, { winner: { ref: { rank: 1 | 2 }; temp: number } }>;
const winners: WinnersFile = JSON.parse(readFileSync(path.join(MATRIX_ROOT, "winners.json"), "utf-8"));

const PERSONAS = [
  "voice_31", "voice_13", "voice_15", "voice_43", "voice_26",
  "voice_42", "voice_48", "voice_27", "voice_38",
  "voice_40", "voice_11", "voice_47",
  "voice_18", "voice_07", "voice_21", "voice_46",
];

const lines: string[] = [];
lines.push("| Persona | Script | CER before (vs raw text) | CER after (vs normalized text, literal) | CER after (vs RAW text, confound-corrected) |");
lines.push("|---|---|---:|---:|---:|");

let sumBefore = 0, sumAfterLiteral = 0, sumAfterCorrected = 0, n = 0;
const perScript: Record<string, { before: number[]; afterLiteral: number[]; afterCorrected: number[] }> = {
  S2: { before: [], afterLiteral: [], afterCorrected: [] },
  S3: { before: [], afterLiteral: [], afterCorrected: [] },
};

for (const persona of PERSONAS) {
  const w = winners[persona].winner;
  for (const scriptId of ["S2", "S3"] as const) {
    const label = `ref${w.ref.rank}_t${w.temp}_${scriptId}`;
    const before = matrixScreen.get(`${persona}::${label}`);
    const after = fidelityScreen.get(`${persona}::winner-rerender:${label}`);
    const beforePct = before ? before.cer * 100 : NaN;
    const afterLiteralPct = after ? after.cer * 100 : NaN;
    const afterCorrectedPct = after ? characterErrorRate(RAW_TEXT[scriptId], after.transcript_actual) * 100 : NaN;
    lines.push(`| ${persona} | ${scriptId} | ${beforePct.toFixed(2)}% | ${afterLiteralPct.toFixed(2)}% | ${afterCorrectedPct.toFixed(2)}% |`);
    if (!Number.isNaN(beforePct) && !Number.isNaN(afterLiteralPct)) {
      sumBefore += beforePct; sumAfterLiteral += afterLiteralPct; sumAfterCorrected += afterCorrectedPct; n += 1;
      perScript[scriptId].before.push(beforePct);
      perScript[scriptId].afterLiteral.push(afterLiteralPct);
      perScript[scriptId].afterCorrected.push(afterCorrectedPct);
    }
  }
}

console.log(lines.join("\n"));
console.log("");
console.log(`**Overall avg CER: before ${(sumBefore / n).toFixed(2)}% | after-literal(vs normalized ref) ${(sumAfterLiteral / n).toFixed(2)}% | after-corrected(vs raw ref) ${(sumAfterCorrected / n).toFixed(2)}% (n=${n} winner S2+S3 pairs)**`);
for (const s of ["S2", "S3"] as const) {
  const b = perScript[s].before.reduce((a, c) => a + c, 0) / perScript[s].before.length;
  const al = perScript[s].afterLiteral.reduce((a2, c) => a2 + c, 0) / perScript[s].afterLiteral.length;
  const ac = perScript[s].afterCorrected.reduce((a2, c) => a2 + c, 0) / perScript[s].afterCorrected.length;
  console.log(`**${s} avg CER: before ${b.toFixed(2)}% | after-literal ${al.toFixed(2)}% | after-corrected ${ac.toFixed(2)}%**`);
}
