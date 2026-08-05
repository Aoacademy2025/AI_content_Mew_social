// T5 (hv-emotion) — build the T3 screening harness's manifest.json for the
// eval-matrix batch (eval-main + eval-tags per-job WAVs, plus the
// concatenated chunking-variant WAVs). One Whisper-model-load pass for all
// 16 personas x ~23 arms.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ARTIFACT_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const EVAL_DIR = path.join(ARTIFACT_ROOT, "eval");
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, "run-manifest.json");

type ManifestEntry = {
  key: string; persona: string; phase: string; label: string;
  params: Record<string, unknown>; status: string; wavPath?: string;
};

if (!existsSync(MANIFEST_PATH)) throw new Error(`${MANIFEST_PATH} not found`);
const entries: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

const S1 = "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง";
const S2 = "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา";

const screenManifest: Array<{ file: string; transcript: string; label: string; group: string }> = [];

for (const e of entries.filter((x) => x.status === "completed" && (x.phase === "eval-main" || x.phase === "eval-tags"))) {
  const rawText = e.params.text as string;
  // eval-tags used S1 with a prepended [surprise-ah] tag; expected transcript
  // for CER purposes is the text WITHOUT non-verbal tags (brief requirement).
  const transcript = e.phase === "eval-tags" ? rawText.replace(/\[[a-z-]+\]\s*/gi, "").trim() : rawText;
  screenManifest.push({
    file: path.join(e.persona, path.basename(e.wavPath!)),
    transcript,
    label: e.label,
    group: e.persona,
  });
}

// Concatenated chunking-variant WAVs (not individual manifest entries —
// written directly by hv-emotion-run-matrix.ts after all chunks for a cap
// completed). Screen them against the FULL S2 text.
const personas = [...new Set(entries.map((e) => e.persona))];
for (const persona of personas) {
  for (const cap of [300, 700]) {
    const wavPath = path.join(EVAL_DIR, persona, `ref1_t1.0_S2chunk${cap}.wav`);
    if (existsSync(wavPath)) {
      screenManifest.push({
        file: path.join(persona, `ref1_t1.0_S2chunk${cap}.wav`),
        transcript: S2,
        label: `ref1_t1.0_S2chunk${cap}`,
        group: persona,
      });
    }
  }
}

writeFileSync(path.join(EVAL_DIR, "manifest.json"), JSON.stringify(screenManifest, null, 2));
console.log(JSON.stringify({ event: "screen-manifest-written", count: screenManifest.length, dir: EVAL_DIR }));
