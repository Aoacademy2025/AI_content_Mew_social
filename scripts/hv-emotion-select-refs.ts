// T5 (hv-emotion) Step 1 — pick top-2 ref-hunt candidates per persona.
// Guard order: CER <= 5% (T3 harness's own disqualify threshold) first, then
// F0 identity preservation (median within +/-25% of the persona's baked-ref
// F0, from docs/research/2026-07-24-hero-voice-persona-shortlist.json) —
// don't let temperature drift the cloned voice into someone else. If fewer
// than 2 candidates survive both guards, relax in a documented order and log
// it (never silently drop a persona).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ARTIFACT_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const REFHUNT_DIR = path.join(ARTIFACT_ROOT, "refhunt");
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, "run-manifest.json");
const SCREEN_JSON_PATH = path.join(REFHUNT_DIR, "screen-out.json");
const SELECTION_PATH = path.join(ARTIFACT_ROOT, "refhunt-selection.json");

const PERSONA_F0: Record<string, number> = {
  voice_31: 198.3, voice_13: 207.1, voice_15: 258.7, voice_43: 223.9, voice_26: 389.9,
  voice_42: 124.2, voice_48: 98.3, voice_27: 96.3, voice_38: 93.3,
  voice_40: 148.6, voice_11: 134.7, voice_47: 174.2,
  voice_18: 248.5, voice_07: 345.3, voice_21: 220.1, voice_46: 231.8,
};

type ScreenRow = {
  file: string; group: string; label: string; cer: number | null; f0_median_hz: number | null;
  score: number | null; rank: number | null; disqualified: boolean; disqualification_reason: string | null;
};
type ScreenReport = { voices: ScreenRow[] };
type ManifestEntry = { key: string; persona: string; phase: string; label: string; params: Record<string, unknown>; status: string; wavPath?: string };

if (!existsSync(SCREEN_JSON_PATH)) throw new Error(`${SCREEN_JSON_PATH} not found — run the screening harness first`);
const screen: ScreenReport = JSON.parse(readFileSync(SCREEN_JSON_PATH, "utf-8"));
const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

const byPersonaLabel = new Map<string, ManifestEntry>();
for (const e of manifest) {
  if (e.phase === "refhunt" && e.status === "completed") byPersonaLabel.set(`${e.persona}:${e.label}`, e);
}

const selections: Array<{
  persona: string; rank: 1 | 2; temp: number; wavPath: string; refText: string;
  f0MedianHz: number | null; cerPercent: number | null; score: number | null; relaxed: string | null;
}> = [];

const report: string[] = [];

for (const personaId of Object.keys(PERSONA_F0)) {
  const rows = screen.voices.filter((r) => r.group === personaId);
  const baselineF0 = PERSONA_F0[personaId];
  const f0Guard = (row: ScreenRow) => row.f0_median_hz !== null && Math.abs(row.f0_median_hz - baselineF0) <= 0.25 * baselineF0;

  let relaxed: string | null = null;
  let pool = rows.filter((r) => !r.disqualified && f0Guard(r));
  if (pool.length < 2) {
    relaxed = "f0-guard-relaxed (fewer than 2 candidates passed CER+F0; dropped F0 identity guard)";
    pool = rows.filter((r) => !r.disqualified);
  }
  if (pool.length < 2) {
    relaxed = "cer-guard-relaxed (fewer than 2 candidates passed CER<=5%; included disqualified candidates ranked by score)";
    pool = rows.slice();
  }
  pool = pool.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const top2 = pool.slice(0, 2);

  if (top2.length === 0) {
    report.push(`${personaId}: NO CANDIDATES AT ALL (0 completed refhunt jobs) — persona cannot proceed to eval matrix.`);
    continue;
  }
  if (relaxed) report.push(`${personaId}: ${relaxed}`);

  top2.forEach((row, idx) => {
    const entry = byPersonaLabel.get(`${personaId}:${row.label}`);
    if (!entry?.wavPath) return;
    const temp = Number(String(row.label).replace("temp", ""));
    selections.push({
      persona: personaId,
      rank: (idx + 1) as 1 | 2,
      temp,
      wavPath: entry.wavPath,
      refText: entry.params.text as string,
      f0MedianHz: row.f0_median_hz,
      cerPercent: row.cer === null ? null : Math.round(row.cer * 10000) / 100,
      score: row.score,
      relaxed,
    });
  });
}

writeFileSync(SELECTION_PATH, JSON.stringify(selections, null, 2));
console.log(JSON.stringify({ event: "selection-written", count: selections.length, path: SELECTION_PATH }));
for (const line of report) console.log("NOTE: " + line);
