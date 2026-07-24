// T5 (hv-emotion) — build the T3 screening harness's manifest.json for the
// ref-hunt batch (one Whisper-model-load screening pass covers all 16
// personas x N temps, instead of 16 separate loads).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ARTIFACT_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "matrix");
const REFHUNT_DIR = path.join(ARTIFACT_ROOT, "refhunt");
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, "run-manifest.json");

type ManifestEntry = {
  key: string;
  persona: string;
  phase: string;
  label: string;
  params: Record<string, unknown>;
  status: string;
  wavPath?: string;
};

if (!existsSync(MANIFEST_PATH)) throw new Error(`${MANIFEST_PATH} not found`);
const entries: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const refhuntEntries = entries.filter((e) => e.phase === "refhunt" && e.status === "completed");
if (refhuntEntries.length === 0) throw new Error("no completed refhunt entries found");

const screenManifest = refhuntEntries.map((e) => ({
  file: path.basename(e.wavPath!),
  transcript: e.params.text as string,
  label: e.label,
  group: e.persona,
}));

writeFileSync(path.join(REFHUNT_DIR, "manifest.json"), JSON.stringify(screenManifest, null, 2));
console.log(JSON.stringify({ event: "screen-manifest-written", count: screenManifest.length, dir: REFHUNT_DIR }));
