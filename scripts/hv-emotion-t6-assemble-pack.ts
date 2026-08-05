// T6 (hv-emotion) — Step 2: assemble the blind A/B listening pack.
// Reads winners.json + all three screen-out.json files (matrix, fidelity,
// gemini) + gemini metadata, builds 48 trials (16 personas x S1/S2/S3) with
// 3 arms each (A=Hero winner, B=Hero baseline, C=Gemini), does a deterministic
// per-trial seeded shuffle, copies anonymized WAVs into pack/tNN/tNN_{a,b,c}.wav,
// writes pack/index.html (offline single file) + pack/README-mew.md, and
// answer-key.json OUTSIDE pack/ (never referenced by the HTML).
// Offline/local-file-only script — no RunPod calls, no network.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24");
const MATRIX_ROOT = path.join(ARTIFACT_ROOT, "matrix");
const FIDELITY_ROOT = path.join(ARTIFACT_ROOT, "fidelity");
const GEMINI_ROOT = path.join(ARTIFACT_ROOT, "gemini");
const PACK_ROOT = path.join(ARTIFACT_ROOT, "pack");
const ANSWER_KEY_PATH = path.join(ARTIFACT_ROOT, "answer-key.json");

// ── Persona roster: 16 final personas, canonical order (task-5-report.md).
// Gender per T1's canonical tally (task-1-report.md "Final composition round 2"):
// 7 female (voice_31,13,15,18,43,26,47) / 8 male (voice_40,46,11,21,42,48,27,38)
// / 1 gender-neutral (voice_07). NOTE: docs/research/…persona-shortlist.json has
// no literal "gender" field (the brief's "gender per shortlist JSON" is read as
// "the gender classification established alongside that shortlist", i.e. this
// T1 tally, since it's the only audited gender source tied to these 16 IDs).
const PERSONAS = [
  "voice_31", "voice_13", "voice_15", "voice_43", "voice_26",
  "voice_42", "voice_48", "voice_27", "voice_38",
  "voice_40", "voice_11", "voice_47",
  "voice_18", "voice_07", "voice_21", "voice_46",
];
const FEMALE = new Set(["voice_31", "voice_13", "voice_15", "voice_18", "voice_43", "voice_26", "voice_47"]);
// male + gender-neutral -> Puck (task-6-brief.md Step 2 arm C rule)
function geminiGenderArm(persona: string): "female" | "male" {
  return FEMALE.has(persona) ? "female" : "male";
}

const SCRIPT_IDS = ["S1", "S2", "S3"] as const;
type ScriptId = typeof SCRIPT_IDS[number];
const SCRIPT_TEXT: Record<ScriptId, string> = {
  S1: "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง",
  S2: "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา",
  S3: "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด",
};
const SCRIPT_DESC_TH: Record<ScriptId, string> = {
  S1: "Hook เปิดคลิป (ไม่มีตัวเลข)",
  S2: "เนื้อเรื่อง + ตัวเลข/วันที่",
  S3: "CTA ปิดท้าย + คำทับศัพท์อังกฤษ",
};

// voice_26 identity near-miss (Step 3 selection used the winner ref clip whose
// F0 median drifted from the persona's baked-ref identity F0 — flagged in
// task-5-report / progress.md, brief explicitly requires surfacing it here).
const VOICE_26_IDENTITY_FLAG = {
  code: "identity_nearmiss_f0",
  detail: "Winner ref clip F0 median 294.62 Hz vs voice_26 baked-ref identity F0 389.9 Hz (shortlist JSON) = -24.44%. The cloned voice may drift from voice_26's baked identity in pitch.",
};

// ── Deterministic per-trial seeded shuffle (mulberry32 PRNG, documented so
// it's independently reproducible from the seed alone). ──────────────────
const SHUFFLE_SEED = 20260724;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle3<T>(items: [T, T, T], trialIndex: number): [T, T, T] {
  const rand = mulberry32(SHUFFLE_SEED + trialIndex);
  const arr = [...items] as T[];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr as [T, T, T];
}

// ── Screen-out loaders ──────────────────────────────────────────────────
type ScreenRow = {
  file: string; label: string; group: string; cer: number; score: number;
  rank: number | null; disqualified: boolean; disqualification_reason: string | null;
  duration_seconds: number;
};
function loadScreenOut(p: string): Map<string, ScreenRow> {
  const data = JSON.parse(readFileSync(p, "utf-8")) as { voices: ScreenRow[] };
  const map = new Map<string, ScreenRow>();
  for (const row of data.voices) map.set(`${row.group}::${row.label}`, row);
  return map;
}

const matrixScreen = loadScreenOut(path.join(MATRIX_ROOT, "eval", "screen-out.json"));
const fidelityScreen = loadScreenOut(path.join(FIDELITY_ROOT, "screen-out.json"));
const geminiScreen = loadScreenOut(path.join(GEMINI_ROOT, "screen-out.json"));

type WinnersFile = Record<string, {
  winner: {
    ref: { rank: 1 | 2; temp: number; refText: string };
    temp: number;
    avgExpressivenessScore: number;
    perScriptFiles: { S1: string; S2: string; S3: string };
  };
}>;
const winners: WinnersFile = JSON.parse(readFileSync(path.join(MATRIX_ROOT, "winners.json"), "utf-8"));

type GeminiMeta = { clips: Array<{ scriptId: string; arm: string; voiceName: string; file: string }> };
const geminiMeta: GeminiMeta = JSON.parse(readFileSync(path.join(GEMINI_ROOT, "metadata.json"), "utf-8"));
function geminiFile(scriptId: ScriptId, genderArm: "female" | "male"): string {
  const found = geminiMeta.clips.find((c) => c.scriptId === scriptId.toLowerCase() && c.arm === genderArm);
  if (!found) throw new Error(`no gemini clip for ${scriptId}/${genderArm}`);
  return found.file;
}

// ── Build arm source info per (persona, script) ─────────────────────────
type ArmKind = "winner" | "baseline" | "gemini";
type ArmInfo = {
  kind: ArmKind;
  srcAbsPath: string;
  config: Record<string, unknown>;
  cerPercent: number | null;
  cerBeforePercent?: number | null; // winner S2/S3 only: raw matrix CER pre-normalizer
  expressivenessScore: number | null;
  screenRank: number | null;
  disqualified: boolean | null;
  disqualificationReason: string | null;
  flags: Array<{ code: string; detail: string }>;
};

function buildWinnerArm(persona: string, scriptId: ScriptId): ArmInfo {
  const w = winners[persona].winner;
  const flags = persona === "voice_26" ? [VOICE_26_IDENTITY_FLAG] : [];
  if (scriptId === "S1") {
    const relFile = w.perScriptFiles.S1; // e.g. "voice_31/ref1_t0_S1.wav"
    const label = path.basename(relFile, ".wav"); // ref{rank}_t{temp}_S1
    const row = matrixScreen.get(`${persona}::${label}`);
    return {
      kind: "winner",
      srcAbsPath: path.join(MATRIX_ROOT, "eval", relFile),
      config: { armType: "hero-winner", persona, script: scriptId, refRank: w.ref.rank, refTemp: w.temp, refSource: "payload", normalizerApplied: false, reused: "S1 reused verbatim from T5 matrix (no re-render needed)" },
      cerPercent: row ? row.cer * 100 : null,
      expressivenessScore: row ? row.score : null,
      screenRank: row ? row.rank : null,
      disqualified: row ? row.disqualified : null,
      disqualificationReason: row ? row.disqualification_reason : null,
      flags,
    };
  }
  const label = `ref${w.ref.rank}_t${w.temp}_${scriptId}`;
  const afterRow = fidelityScreen.get(`${persona}::winner-rerender:${label}`);
  const beforeRow = matrixScreen.get(`${persona}::${label}`);
  return {
    kind: "winner",
    srcAbsPath: path.join(FIDELITY_ROOT, "winners", persona, `${label}.wav`),
    config: { armType: "hero-winner", persona, script: scriptId, refRank: w.ref.rank, refTemp: w.temp, refSource: "payload", normalizerApplied: true, normalizerVersion: "2026-07-24.1" },
    cerPercent: afterRow ? afterRow.cer * 100 : null,
    cerBeforePercent: beforeRow ? beforeRow.cer * 100 : null,
    expressivenessScore: afterRow ? afterRow.score : null,
    screenRank: afterRow ? afterRow.rank : null,
    disqualified: afterRow ? afterRow.disqualified : null,
    disqualificationReason: afterRow ? afterRow.disqualification_reason : null,
    flags,
  };
}

function buildBaselineArm(persona: string, scriptId: ScriptId): ArmInfo {
  const row = fidelityScreen.get(`${persona}::baseline:${scriptId}`);
  return {
    kind: "baseline",
    srcAbsPath: path.join(FIDELITY_ROOT, "baseline", persona, `${scriptId}.wav`),
    config: { armType: "hero-baseline", persona, script: scriptId, refSource: "baked", temp: 0.0, normalizerApplied: scriptId !== "S1", normalizerVersion: "2026-07-24.1" },
    cerPercent: row ? row.cer * 100 : null,
    expressivenessScore: row ? row.score : null,
    screenRank: row ? row.rank : null,
    disqualified: row ? row.disqualified : null,
    disqualificationReason: row ? row.disqualification_reason : null,
    flags: [],
  };
}

function buildGeminiArm(persona: string, scriptId: ScriptId): ArmInfo {
  const genderArm = geminiGenderArm(persona);
  const file = geminiFile(scriptId, genderArm);
  const label = `${scriptId.toLowerCase()}-${genderArm}`;
  const row = geminiScreen.get(`gemini::${label}`);
  const voiceName = genderArm === "female" ? "Aoede" : "Puck";
  return {
    kind: "gemini",
    srcAbsPath: path.join(GEMINI_ROOT, file),
    config: { armType: "gemini", persona, script: scriptId, voiceName, genderArm, note: "shared clip across all personas of this gender/script — not persona-specific" },
    cerPercent: row ? row.cer * 100 : null,
    expressivenessScore: row ? row.score : null,
    screenRank: row ? row.rank : null,
    disqualified: row ? row.disqualified : null,
    disqualificationReason: row ? row.disqualification_reason : null,
    flags: [],
  };
}

// ── Build all 48 trials ──────────────────────────────────────────────────
type Trial = {
  trialId: string;
  groupIndex: number; // opaque 1..16, no persona ID exposed to the HTML
  scriptId: ScriptId;
  arms: Record<ArmKind, ArmInfo>;
  shuffledOrder: [ArmKind, ArmKind, ArmKind]; // slot a,b,c -> arm kind
};

const trials: Trial[] = [];
let trialIndex = 0;
PERSONAS.forEach((persona, personaIdx) => {
  SCRIPT_IDS.forEach((scriptId) => {
    const trialId = `t${String(trialIndex + 1).padStart(2, "0")}`;
    const arms: Record<ArmKind, ArmInfo> = {
      winner: buildWinnerArm(persona, scriptId),
      baseline: buildBaselineArm(persona, scriptId),
      gemini: buildGeminiArm(persona, scriptId),
    };
    const shuffledOrder = seededShuffle3<ArmKind>(["winner", "baseline", "gemini"], trialIndex);
    trials.push({ trialId, groupIndex: personaIdx + 1, scriptId, arms, shuffledOrder });
    trialIndex += 1;
  });
});

// ── Verify every source file exists before copying anything ────────────
const missingSources: string[] = [];
for (const trial of trials) {
  for (const kind of trial.shuffledOrder) {
    if (!existsSync(trial.arms[kind].srcAbsPath)) missingSources.push(trial.arms[kind].srcAbsPath);
  }
}
if (missingSources.length > 0) {
  console.error(JSON.stringify({ event: "MISSING-SOURCE-FILES", count: missingSources.length, files: missingSources.slice(0, 20) }));
  process.exit(1);
}

// ── Copy anonymized files into pack/tNN/tNN_{a,b,c}.wav ─────────────────
mkdirSync(PACK_ROOT, { recursive: true });
const slotLetters: Array<"a" | "b" | "c"> = ["a", "b", "c"];
const answerKeyTrials: Array<Record<string, unknown>> = [];

for (const trial of trials) {
  const trialDir = path.join(PACK_ROOT, trial.trialId);
  mkdirSync(trialDir, { recursive: true });
  const slotMap: Record<string, unknown> = {};
  trial.shuffledOrder.forEach((armKind, slotIdx) => {
    const slot = slotLetters[slotIdx];
    const destFile = `${trial.trialId}_${slot}.wav`;
    copyFileSync(trial.arms[armKind].srcAbsPath, path.join(trialDir, destFile));
    const arm = trial.arms[armKind];
    slotMap[slot] = {
      arm: armKind,
      persona: PERSONAS[trial.groupIndex - 1],
      config: arm.config,
      cerPercent: arm.cerPercent === null ? null : Number(arm.cerPercent.toFixed(2)),
      cerBeforePercent: arm.cerBeforePercent === undefined ? undefined : (arm.cerBeforePercent === null ? null : Number(arm.cerBeforePercent.toFixed(2))),
      expressivenessScore: arm.expressivenessScore,
      screenRank: arm.screenRank,
      disqualified: arm.disqualified,
      disqualificationReason: arm.disqualificationReason,
      flags: arm.flags,
    };
  });
  answerKeyTrials.push({
    trialId: trial.trialId,
    groupIndex: trial.groupIndex,
    persona: PERSONAS[trial.groupIndex - 1],
    scriptId: trial.scriptId,
    labels: slotMap,
  });
}

writeFileSync(
  ANSWER_KEY_PATH,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    shuffleSeed: SHUFFLE_SEED,
    shuffleAlgorithm: "mulberry32(SHUFFLE_SEED + trialIndex), Fisher-Yates on [winner,baseline,gemini] -> slots a,b,c (trialIndex 0-based, trial order = persona-canonical-order x [S1,S2,S3])",
    personaCanonicalOrder: PERSONAS,
    trials: answerKeyTrials,
  }, null, 2),
);
console.log(JSON.stringify({ event: "answer-key-written", trials: answerKeyTrials.length, path: path.relative(REPO_ROOT, ANSWER_KEY_PATH) }));

// ── Write pack/index.html (built by a separate step, see build-pack-html.ts) ─
console.log(JSON.stringify({ event: "pack-audio-copied", trialFolders: trials.length, totalFiles: trials.length * 3 }));
