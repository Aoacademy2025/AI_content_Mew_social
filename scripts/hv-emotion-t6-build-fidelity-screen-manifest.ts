// T6 (hv-emotion) — build the T3 screening harness's manifest.json for the
// Step 1 fidelity re-renders (baseline 48 + winner-rerender 32 = 80 files).
// Expected transcript = the SPEECH text actually submitted (prepareHeroVoiceSpeech
// output), per task-6-brief.md Step 1 ("not the display text").
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const FIDELITY_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "fidelity");
const MANIFEST_PATH = path.join(FIDELITY_ROOT, "run-manifest.json");

type ManifestEntry = {
  key: string;
  persona: string;
  phase: "baseline" | "winner-rerender";
  label: string;
  script: "S1" | "S2" | "S3";
  speechText: string;
  status: string;
  wavPath?: string;
};

if (!existsSync(MANIFEST_PATH)) throw new Error(`${MANIFEST_PATH} not found`);
const entries: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

const screenManifest: Array<{ file: string; transcript: string; label: string; group: string }> = [];

for (const e of entries.filter((x) => x.status === "completed")) {
  const relFromFidelityRoot = path.relative(FIDELITY_ROOT, path.resolve(__dirname, "..", e.wavPath!));
  screenManifest.push({
    file: relFromFidelityRoot,
    transcript: e.speechText,
    label: `${e.phase}:${e.label}`,
    group: e.persona,
  });
}

writeFileSync(path.join(FIDELITY_ROOT, "manifest.json"), JSON.stringify(screenManifest, null, 2));
console.log(JSON.stringify({ event: "screen-manifest-written", count: screenManifest.length, dir: FIDELITY_ROOT }));
