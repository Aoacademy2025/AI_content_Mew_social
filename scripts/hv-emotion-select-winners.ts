// T5 (hv-emotion) Step 3 — winner selection + winners.json.
// Winner = best (ref, temp) config by (CER guard <=5% on ALL of S1+S2+S3)
// then average expressiveness score across S1+S2+S3. Runner-up = second best
// surviving config. Falls back to a documented relaxed ranking if no config
// fully clears the CER guard for a persona.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ARTIFACT_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const EVAL_DIR = path.join(ARTIFACT_ROOT, "eval");
const SCREEN_JSON_PATH = path.join(EVAL_DIR, "screen-out.json");
const SELECTION_PATH = path.join(ARTIFACT_ROOT, "refhunt-selection.json");
const WINNERS_PATH = path.join(ARTIFACT_ROOT, "winners.json");

type ScreenRow = {
  file: string; group: string; label: string; cer: number | null; f0_median_hz: number | null;
  score: number | null; rank: number | null; disqualified: boolean; disqualification_reason: string | null;
};
type ScreenReport = { voices: ScreenRow[] };
type RefSelection = { persona: string; rank: 1 | 2; temp: number; wavPath: string; refText: string };

if (!existsSync(SCREEN_JSON_PATH)) throw new Error(`${SCREEN_JSON_PATH} not found — run the eval screening harness first`);
const screen: ScreenReport = JSON.parse(readFileSync(SCREEN_JSON_PATH, "utf-8"));
const refSelections: RefSelection[] = JSON.parse(readFileSync(SELECTION_PATH, "utf-8"));

const personas = [...new Set(refSelections.map((s) => s.persona))];
const MATRIX_TEMPS = [0.0, 1.0, 2.0];
const S_LABELS = ["S1", "S2", "S3"];

type ConfigResult = {
  ref: 1 | 2; temp: number; rows: (ScreenRow | undefined)[]; complete: boolean;
  cerGuardPass: boolean; avgScore: number | null; avgCer: number | null;
};

const winners: Record<string, unknown> = {};
const notes: string[] = [];

for (const persona of personas) {
  const rows = screen.voices.filter((r) => r.group === persona);
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const refs = refSelections.filter((s) => s.persona === persona).sort((a, b) => a.rank - b.rank);

  const configs: ConfigResult[] = [];
  for (const ref of refs) {
    for (const temp of MATRIX_TEMPS) {
      const configRows = S_LABELS.map((s) => byLabel.get(`ref${ref.rank}_t${temp}_${s}`));
      const complete = configRows.every((r) => r !== undefined);
      const cerGuardPass = complete && configRows.every((r) => !r!.disqualified);
      const scores = configRows.filter((r): r is ScreenRow => !!r && r.score !== null).map((r) => r.score!);
      const cers = configRows.filter((r): r is ScreenRow => !!r && r.cer !== null).map((r) => r.cer!);
      configs.push({
        ref: ref.rank, temp,
        rows: configRows, complete, cerGuardPass,
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        avgCer: cers.length ? cers.reduce((a, b) => a + b, 0) / cers.length : null,
      });
    }
  }

  const complete = configs.filter((c) => c.complete);
  let relaxed: string | null = null;
  let pool = complete.filter((c) => c.cerGuardPass);
  if (pool.length === 0) {
    relaxed = "no config fully passed the CER<=5% guard on all of S1+S2+S3 — ranked by avg score with CER-guard-failure count as a tiebreak penalty";
    pool = complete;
  }
  pool = pool.slice().sort((a, b) => {
    const aFail = a.rows.filter((r) => r?.disqualified).length;
    const bFail = b.rows.filter((r) => r?.disqualified).length;
    if (aFail !== bFail) return aFail - bFail;
    return (b.avgScore ?? -1) - (a.avgScore ?? -1);
  });

  if (pool.length === 0) {
    notes.push(`${persona}: NO usable config (missing eval-matrix jobs) — no winner.`);
    winners[persona] = null;
    continue;
  }
  if (relaxed) notes.push(`${persona}: ${relaxed}`);

  const [winner, runnerUp] = pool;
  const refFor = (rank: 1 | 2) => refs.find((r) => r.rank === rank)!;
  const toRecord = (c: ConfigResult) => ({
    ref: refFor(c.ref),
    temp: c.temp,
    cerGuardPass: c.cerGuardPass,
    avgExpressivenessScore: c.avgScore,
    avgCerPercent: c.avgCer === null ? null : Math.round(c.avgCer * 10000) / 100,
    perScriptFiles: Object.fromEntries(S_LABELS.map((s, i) => [s, c.rows[i]?.file ?? null])),
  });

  winners[persona] = {
    winner: toRecord(winner),
    runnerUp: runnerUp ? toRecord(runnerUp) : null,
    relaxed,
  };
}

writeFileSync(WINNERS_PATH, JSON.stringify(winners, null, 2));
const found = Object.values(winners).filter((w) => w !== null).length;
console.log(JSON.stringify({ event: "winners-written", found, total: personas.length, path: WINNERS_PATH }));
for (const n of notes) console.log("NOTE: " + n);
