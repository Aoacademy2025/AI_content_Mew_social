// T6 (hv-emotion) — Step 2: customer-pack.zip. Subset of the pack for sharing:
// 4 strongest personas by screening (winners.json avgExpressivenessScore,
// the T3 harness's own composite metric) x S1 only x 3 arms (Hero winner,
// Hero current/baseline, Gemini), plus a one-line Thai instruction file.
// NOT blinded (brief: "no answer key anywhere inside" — this is a shareable
// demo folder, not a research trial instrument) and uses opaque persona-N
// labels (no internal voice_XX catalog IDs exposed).
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24");
const MATRIX_ROOT = path.join(ARTIFACT_ROOT, "matrix");
const FIDELITY_ROOT = path.join(ARTIFACT_ROOT, "fidelity");
const GEMINI_ROOT = path.join(ARTIFACT_ROOT, "gemini");
const CUSTOMER_DIR = path.join(ARTIFACT_ROOT, "customer-pack");
const ZIP_PATH = path.join(ARTIFACT_ROOT, "customer-pack.zip");

const FEMALE = new Set(["voice_31", "voice_13", "voice_15", "voice_18", "voice_43", "voice_26", "voice_47"]);
function geminiGenderArm(persona: string): "female" | "male" {
  return FEMALE.has(persona) ? "female" : "male";
}

type WinnersFile = Record<string, {
  winner: { ref: { rank: 1 | 2 }; temp: number; avgExpressivenessScore: number; perScriptFiles: { S1: string } };
}>;
const winners: WinnersFile = JSON.parse(readFileSync(path.join(MATRIX_ROOT, "winners.json"), "utf-8"));

type GeminiMeta = { clips: Array<{ scriptId: string; arm: string; file: string }> };
const geminiMeta: GeminiMeta = JSON.parse(readFileSync(path.join(GEMINI_ROOT, "metadata.json"), "utf-8"));
function geminiFileFor(genderArm: "female" | "male"): string {
  const found = geminiMeta.clips.find((c) => c.scriptId === "s1" && c.arm === genderArm);
  if (!found) throw new Error(`no gemini S1 clip for ${genderArm}`);
  return found.file;
}

// 4 strongest personas by T3 screening composite (winners.json avgExpressivenessScore desc).
const ranked = Object.entries(winners)
  .map(([persona, v]) => ({ persona, score: v.winner.avgExpressivenessScore }))
  .sort((a, b) => b.score - a.score);
const top4 = ranked.slice(0, 4);
console.log(JSON.stringify({ event: "customer-pack-top4", top4 }));

if (existsSync(CUSTOMER_DIR)) rmSync(CUSTOMER_DIR, { recursive: true, force: true });
mkdirSync(CUSTOMER_DIR, { recursive: true });

top4.forEach(({ persona }, i) => {
  const n = i + 1;
  const dir = path.join(CUSTOMER_DIR, `persona-${n}`);
  mkdirSync(dir, { recursive: true });

  const w = winners[persona].winner;
  const winnerSrc = path.join(MATRIX_ROOT, "eval", w.perScriptFiles.S1);
  const baselineSrc = path.join(FIDELITY_ROOT, "baseline", persona, "S1.wav");
  const genderArm = geminiGenderArm(persona);
  const geminiSrc = path.join(GEMINI_ROOT, geminiFileFor(genderArm));

  for (const [src, destName] of [
    [winnerSrc, "hero-winner.wav"],
    [baselineSrc, "hero-current.wav"],
    [geminiSrc, "gemini.wav"],
  ] as const) {
    if (!existsSync(src)) throw new Error(`customer-pack source missing: ${src}`);
    copyFileSync(src, path.join(dir, destName));
  }
});

const instructionTh =
  "ตัวอย่างเสียงพากย์ Hero AI Creator Studio 4 คาแรกเตอร์ (hero-winner = เวอร์ชันปรับปรุงใหม่, hero-current = เวอร์ชันปัจจุบัน, gemini = เทียบกับ Google Gemini TTS) — ฟังด้วยหูฟังเพื่ออรรถรสที่ดีที่สุด";
writeFileSync(path.join(CUSTOMER_DIR, "instructions-th.txt"), instructionTh + "\n");

if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
execFileSync("zip", ["-r", "-q", path.relative(ARTIFACT_ROOT, ZIP_PATH), path.basename(CUSTOMER_DIR)], { cwd: ARTIFACT_ROOT });
console.log(JSON.stringify({ event: "customer-pack-zip-written", path: ZIP_PATH }));
