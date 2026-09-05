/** Offline benchmark over private inputs. Emits numeric evidence only; never
 * asserts production qualification from an ASR-derived screening reference. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { selectAcousticSubtitleClock } from "../../src/lib/acoustic-subtitle-selection";
import { ACOUSTIC_CLOCK_VERSION, ACOUSTIC_MODEL_REVISION, projectAcousticClock } from "../../src/lib/acoustic-subtitle-clock";
import { tokenizeWords } from "../../src/lib/tts-timing";

type ManifestRow = { id: string; text: string; timing: string };
type Reference = { startChar: number; baselineMs: number; referenceMs: number; labelSource: string };
function stats(errors: number[]) {
  const sorted = errors.map(Math.abs).sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
  return { count: sorted.length, medianMs: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: p(1),
    within250: sorted.filter(x => x <= 250).length, within500: sorted.filter(x => x <= 500).length,
    over1000: sorted.filter(x => x > 1000).length };
}
async function main() {
  const [manifest, directory, output] = process.argv.slice(2);
  if (!manifest || !directory || !output) throw new Error("benchmark_arguments_required");
  const rows: ManifestRow[] = JSON.parse(await readFile(manifest, "utf8"));
  const evidence = [];
  const allBaseline: number[] = [], allProposed: number[] = [];
  let humanReferences = 0, missingReferenceFiles = 0, unmatchedReferences = 0;
  for (const row of rows) {
    let clock, reference;
    try {
      clock = JSON.parse(await readFile(path.join(directory, `${row.id}-clock.json`), "utf8"));
      reference = JSON.parse(await readFile(path.join(directory, `${row.id}-references.json`), "utf8"));
    } catch { missingReferenceFiles++; continue; }
    const selected = selectAcousticSubtitleClock({ text: row.text, maxCardChars: 30, existingTimingSource: row.timing,
      result: { clock, evidence: { status: "unavailable", mode: "apply", applied: false,
        version: ACOUSTIC_CLOCK_VERSION, modelRevision: ACOUSTIC_MODEL_REVISION, durationMs: clock.durationMs } } });
    const projected = projectAcousticClock({ text: row.text, characters: clock.characters,
      baselineWords: tokenizeWords(row.text).map(w => ({ ...w, startMs: 0, endMs: 0 })), audioDurationMs: clock.audioDurationMs });
    const before: number[] = [], after: number[] = [], candidate: number[] = [];
    for (const ref of reference.boundaries as Reference[]) {
      if (ref.labelSource === "human-reviewed") humanReferences++;
      const word = projected?.words.find(w => ref.startChar >= w.startChar && ref.startChar < w.endChar);
      if (!word) { unmatchedReferences++; continue; }
      before.push(ref.baselineMs - ref.referenceMs);
      candidate.push(word.startMs - ref.referenceMs);
      after.push((selected.evidence.applied ? word.startMs : ref.baselineMs) - ref.referenceMs);
    }
    allBaseline.push(...before); allProposed.push(...after);
    evidence.push({ jobId: row.id, source: row.timing, textSimilarity: reference.textSimilarity,
      status: selected.evidence.status, applied: selected.evidence.applied,
      verifiedWords: selected.evidence.verifiedWordCount ?? 0, totalWords: selected.evidence.totalWordCount ?? 0,
      baseline: stats(before), proposed: stats(after), candidate: stats(candidate) });
  }
  const report = {
    version: ACOUSTIC_CLOCK_VERSION, modelRevision: ACOUSTIC_MODEL_REVISION,
    qualification: "NOT_QUALIFIED: requires held-out human references and production-load/export verification",
    inputClips: rows.length, evaluatedClips: evidence.length, missingReferenceFiles, unmatchedReferences,
    humanReferences, baseline: stats(allBaseline), proposed: stats(allProposed), clips: evidence,
  };
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evaluatedClips: report.evaluatedClips, humanReferences,
    baseline: report.baseline, proposed: report.proposed, qualification: report.qualification }));
}
main().catch(() => { console.error("acoustic_benchmark_failed: check private inputs locally"); process.exitCode = 1; });
